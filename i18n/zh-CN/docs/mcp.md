# MCP 服务（`mqlite-mcp`）

`mqlite-mcp` 是一个 [Model Context Protocol](https://modelcontextprotocol.io) 服务，将 mqlite broker 暴露为 **agent 工具**，让 AI agent（如 Claude）无须编写 HTTP 即可观察 broker 健康、创建队列、发送、接收、结算消息及管理访问密钥。它是轻量的**无额外依赖**转发器：使用 MCP（stdio 上的 JSON-RPC 2.0），把每次工具调用转换为向 broker 发送的一次 HTTP POST。仅使用标准库和仓内 `wire` 契约，不依赖 MCP SDK 或 CGO，与 mqlite 其他部分保持一致。

## 构建与运行

```bash
make build           # → bin/mqlite-mcp  (also: go build ./cmd/mqlite-mcp)
```

它通过 stdio 提供服务：MCP host 启动它，经 stdin/stdout 通信。用 broker 端点和 token 配置：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `MQLITE_ENDPOINT` | `http://127.0.0.1:6754` | Broker 基础 URL |
| `MQLITE_TOKEN` | — | 配置的管理员、monitor 凭据或托管 broker 访问密钥；工具调用遵守其权限 |

## 连接 agent host

多数 MCP host 接受一个 JSON 服务条目，例如：

```json
{
  "mcpServers": {
    "mqlite": {
      "command": "/path/to/bin/mqlite-mcp",
      "env": {
        "MQLITE_ENDPOINT": "https://your-mqlite.fly.dev",
        "MQLITE_TOKEN": "mqk_prod_xxx"
      }
    }
  }
}
```

随后 agent 就能看到以下工具，并直接操作 broker。

## 工具

保持最小化：选定的核心路由按 1:1 映射（刻意精简，过度设计的工具容易让模型误用）：

权限遵循 HTTP API：生产者使用 `send`；消费者及订阅预配使用 `listen`；broker 范围的清单、生命周期和密钥管理使用 `manage`。`observe` 也接受配置的 monitor 凭据。

| 工具 | 功能 |
|---|---|
| `observe` | 完整的规范观测结果；无参数；需要 monitor 或 manage |
| `list_queues` | 列出队列/订阅 |
| `create_queue` | 按名称创建/更新队列 |
| `delete_queue` | 删除普通队列；可选 `force` 显式丢弃保留工作 |
| `subscribe` | 创建主题订阅或更新过滤器（`listen`）；可选 `ttl_ms` 设置固定寿命 |
| `list_subscriptions` | 按主题分页列出订阅，包含总数/数量及可选 deleting 条目（`manage`） |
| `delete_subscription` | 删除精确的主题/订阅对（`manage`）；可选 `force` 丢弃保留工作 |
| `send` | 发送消息（`queue`、`body`，可选 `message_id`/`group_id`） |
| `receive` | 以 peek-lock 接收消息，返回 `seq_number` 与 `lock_token` |
| `complete` | 确认消息处理完成（`queue`、`seq_number`、`lock_token`） |
| `abandon` | 结束本次交付尝试；低于上限时立即/延后重试，否则转入死信 |
| `reject` | 将消息转入死信 |
| `renew` | 延长同一次有效交付锁，不增加 `delivery_count`；不能复活过期锁 |
| `defer` | 暂存消息，稍后按 `seq_number` 取回 |
| `receive_deferred` | 按 `seq_numbers` 取回 deferred 消息 |
| `peek` | 不加锁地浏览（可按 `state` 筛选） |
| `stats` | 按状态统计队列消息数量 |
| `redrive` | 将死信移回 active |
| `purge` | 永久删除死信 |
| `create_key` | 创建托管密钥（`id`、`name`、`permissions`，可选 `expires_at_ms`）；只返回一次 token |
| `list_keys` | 列出公开密钥元数据，包括已撤销/过期密钥（`after_id`、`limit`、`sort`） |
| `revoke_key` | 按公开 `id` 撤销托管密钥；重复撤销安全 |

使用 `receive` 返回的 `lock_token` 结算。交付是至少一次，因此 agent 应确保 处理函数 幂等。完整 HTTP 语义参见 [api-reference.md](api-reference.md)。

## 队列删除

`delete_queue` 接受 `{"name":"orders"}` 进行仅空删除，或接受 `{"name":"orders","force":true}` 授权永久丢弃所有消息状态。不能根据先前观测自行推断 force 授权。持锁工作可能已经造成外部副作用，删除无法撤销该效果。

调用内完成物理删除时返回 `{"deleted":true,"state":"deleted"}`；持久退役已生效、后台仍在有界清理时返回 `{"deleted":false,"state":"deleting"}`。后一状态中，数据面调用失败，`list_queues` 保留 `state:"deleting"` 行，名称不能复用。原丢弃授权已经持久化，后台清理不需要后续写入。应串行化删除和同名重建；用 `list_queues` 只读检查状态，等到不再包含该名称后再创建替代资源。传输失败、重定向、任意 HTTP 5xx（包括网关生成的响应）或格式错误的成功响应都应视为未知结果。保留名称并通过 `list_queues` 对账，绝不自动重放 `delete_queue`。应配置中间层不重试生命周期删除路由。

## 订阅生命周期

`delete_subscription` 接受 `topic`、`name` 和可选 `force`，默认仅空删除。删除被接受后立即停止订阅 扇出，返回与队列删除相同的 `deleted` / `deleting` 结果。即使订阅名称全局唯一，也必须提供精确主题/名称对。两种删除模式都需要 `manage`；`force` 改变的是非空前提，不是权限。

使用 `list_subscriptions` 进行有界清单查询和对账。可选参数为 `topic`、`after`、`limit`（默认 100，最大 1,000）以及 `include_deleting`；结果包含 `subscriptions`、`total` 和 `next_after`。游标不透明，并绑定主题/deleting 范围。null、不完整、乱序、越出范围或内部不一致的成功分页响应会被拒绝，不能用于证明已删除名称不存在。破坏性调用遇到重定向、传输失败、任何 HTTP 5xx 或无效成功响应时，不要重放。保持对一次性订阅名称的所有权，以 `include_deleting:true` 查询，直到原映射不存在。

默认容量是 active 与 deleting 订阅合计 10,000。这是元数据安全上限；发布工作和存储副本仍随匹配订阅数增加，因此高频场景下 agent 不应每个请求创建一个订阅，而应使用稳定回复订阅，按 `correlation_id` 分发。

`subscribe` 接受可选的正整数 `ttl_ms`。首次创建时，它设置从该创建时刻起算的固定寿命。省略 `ttl_ms` 会创建永久订阅，或保留已有订阅的寿命；MCP 工具拒绝显式零值。重复原来的正 TTL 是幂等的；对同一订阅提供另一正 TTL，会在更改过滤器前返回冲突。更新、重试、流量和接收都不会延长期限。

`subscribe` 需要 `listen`，且是 broker 范围的 创建或更新（upsert）：调用方可更新任何已知 `(topic,name)` 对的过滤器。它不授予清单查询或删除权。只有 listen 权限的 agent 创建临时订阅时，应始终设置 `ttl_ms`；提前退役和对账由管理者执行。

到达截止时间时，broker 使订阅不可用，并将 TTL 视为丢弃保留消息的预先授权。物理清理有界且异步，因此名称会持续保留，直到使用 `include_deleting:true` 的清单不再返回它。之后同名创建会开启新生命周期；应将删除/到期与同名重建串行化。每个清单项包含 `created_at_ms` 和 `expires_at_ms`；到期时间为零表示永久订阅。真正的临时工作优先使用全局唯一、仅用一次的名称。高频请求/回复优先为每个服务实例保留一个稳定回复订阅，按 `correlation_id` 路由回复。

## 只读观测

`observe` 工具要求 `mqlite-mcp` 和 broker 都为 **v0.3.2 或更新版本**。配置的监控凭据也需要 v0.3.2 或更新的 broker。

以 `{}` 调用 `observe`，获取与 HTTP 路由、Go SDK 和 CLI 相同的规范 JSON 快照：可用性/新鲜度、队列瞬时值、进程消息效果、存储操作、维护、过滤器和 HTTP 测量。工具不重新计算计数。即使 HTTP 请求成功，队列采集不可用也会明确表示；应检查 `collection.state` 和运行时可用性标志。Broker 重启时，进程计数器清零。参见 [observability.md](observability.md)。

为只读监控 agent，可将 broker 的 `MQLITE_MONITOR_TOKENS` 中配置的一项凭据设置为此进程的 `MQLITE_TOKEN`。工具清单不变，但 broker 只允许该凭据执行 `observe`，其他工具调用返回 `permission_denied`。托管 `send`/`listen` 凭据不能观测整个 broker，monitor 也不是托管密钥权限。

## 访问密钥管理

三个密钥工具需要 `manage`；环境管理员 token 和有效托管 `manage` 密钥均可继续签发管理员密钥。`send` 和 `listen` 密钥调用这些工具会得到 `permission_denied`。MCP 服务每次调用都转发 `MQLITE_TOKEN`，由 broker 授权决定允许执行的操作。

调用 `create_key` 前，选择并保留一个唯一的 32 字符小写十六进制 `id`。`id` 是公开元数据，独立于秘密 token：

```json
{
  "name": "create_key",
  "arguments": {
    "id": "e734810a9f634d75bd8a029c1f7e5062",
    "name": "order-producer",
    "permissions": ["send"]
  }
}
```

`permissions` 接受 `send`、`listen`、两者组合或 `manage`（包含两者）。`expires_at_ms` 是未来 UTC 纪元毫秒时间戳；省略或零表示不过期。响应含 `key` 元数据，以及格式为 `mqk_` 加 64 个小写十六进制字符、只返回一次的 `token`。安全保存 token；它会出现在成功的 MCP 工具结果中，并可能被 MCP host 保留。列表响应从不包含秘密值或 token 摘要。

创建不会自动重试。错误会包含保留的合法公开 ID；结果不确定后，应先对该 ID 使用 `list_keys` 和 `revoke_key`，再用新 ID 签发替代密钥。复用 ID 返回 `key_conflict`，无法恢复秘密值。把 `list_keys` 的 `next_after_id` 传回 `after_id`，直到游标缺失；默认 limit 为 100，最大 1000。可选 `sort` 为 `id_asc`（默认）或 `created_desc`（最新创建优先，相同时间再按公开 ID 降序）。每页保持相同排序。按创建顺序分页时，游标必须标识已有密钥，包括已撤销或过期项。默认 ID 顺序也接受不存在的前驱 ID，以便对账响应丢失的创建。环境 token 不会列出，也不能通过这些工具撤销。Broker 显式关闭认证时，密钥工具不可用。

