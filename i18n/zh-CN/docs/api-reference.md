# mqlite HTTP API 参考

Broker 使用 **Connect 风格的 HTTP JSON 协议**。每个操作都是向 `/mqlite.v1.<Service>/<Method>` 发送一次携带 JSON 正文的 `POST` 请求，因此可直接使用 curl 调用。本文依据 [`wire/wire.go`](../wire/wire.go) 中的线协议契约（broker 与 Go SDK 共用的唯一事实来源，避免两者偏离）以及服务端错误映射生成。

本参考跟随 `main`，包含尚未发布的变更。最新受支持的版本为 v0.4.2；使用该版本 broker 时，请查阅 [v0.4.2 参考](https://github.com/mqlitehq/mqlite/blob/v0.4.2/docs/api-reference.md)。本文介绍的 broker 时间响应头、调整后的 Go 托管 Receiver 重试与续锁行为、1 秒至 1 小时的队列锁时长范围、保留租约的启动行为以及协调关停响应均尚未发布；参见 [CHANGELOG.md](../CHANGELOG.md#unreleased)。v0.3.3 已撤回且不再受支持；使用管理接口较少的 v0.3.2 时，请查阅其 tag 中的文档。

每个 RPC 正文必须恰好是一个非 null 的 JSON 对象，包括没有其他请求字段的操作（`{}`）。未知字段和对象之后的额外数据会被拒绝。重复字段沿用 Go `encoding/json` 的行为：后出现的标量值覆盖先前的值，而重复的对象和 map 值可能合并。

## 约定

- **传输**：HTTP `POST`，`Content-Type: application/json`。服务发现与健康检查使用无需认证的 `GET` 端点；按需启用的指标端点在同一端口使用需要认证的 `GET`。
- **Go SDK 传输**：RPC 客户端从不跟随 HTTP 重定向。默认客户端为每个 broker 保留最多 64 条空闲连接，以支持并发 Receiver，并在 `Client.Close` 时释放自己拥有的空闲连接。通过 `WithHTTPClient` 传入的客户端仍归调用方所有；MQLite 保留其传输和超时设置，但仍禁止 RPC 重定向。自定义传输的 `MaxIdleConnsPerHost` 至少应覆盖 Receiver 并发数加有效预取数（即托管管线中最多同时进行的网络工作量）。如果应用用不透明的包装器替换了进程级 `http.DefaultTransport`，MQLite 会保留该包装器以兼容监控插桩和 mock，且不会关闭它；底层连接池的大小仍由应用负责，因为通用的 `http.RoundTripper` 无法被克隆或调优。
- **`body`** 在 JSON 中使用 **base64**（Go 将 `[]byte` 编码为 base64）。
- **时间戳**为 **Unix 纪元毫秒数**（UTC）整数。消息时长使用 `*_ms`；可观测性中明确命名为 `*_seconds` 的时长保留小数秒。
- **Broker 时间响应头**：每个 broker 响应都包含 `X-Mqlite-Server-Time-Ms`，其值为 UTC 纪元毫秒数，取自租约、TTL、调度和结算（settlement）决策所用的同一时钟。Go 托管客户端只信任成功的 broker 响应中的该字段，并扣除保守的传输预算，将绝对租约截止时间映射到本地单调时钟。旧客户端忽略这个新增响应头。对旧 broker，客户端可使用精度为一秒的 HTTP `Date`；若保守剩余时间下界主要受该精度影响，则使用有界的时钟降级节奏。如果两个响应头都不存在，公开的绝对截止时间仍会保留，但托管 Receiver 会报告一次诊断，在派发前确认租约，并使用有界的不可信时钟节奏，而不会把另一台机器的时间戳直接当成本地调度依据。新建或重新配置的队列接受 `0`（默认 30 秒）或 1 秒至 1 小时的锁时长。包含范围外旧值的数据库仍可读取，但在没有时间头、又无法证明极短租约尚有足够剩余时间时，此回退模式可能采取安全拒绝策略。原始 HTTP 调用方应保留至少一个时间响应头、进行 broker 时间映射，或同步时钟。启用 CORS 的 broker 会向浏览器客户端公开此响应头。
- **序号**（`seq_number`）由 broker 分配，是严格递增且**永不复用**的整数（可不连续）；它是**结算消息时使用的标识**，仅在消息存续期间有效。调用方不能设置序号。
- **交付模式**：默认 Peek-Lock 提供至少一次交付（at-least-once），可能重复，因此消费者必须具备幂等性。Receive-and-delete 是显式选择的至多一次 broker 删除路径，会先删除消息再返回；显式使用同一接收尝试 ID 重试，可重放保存的响应。配置为丢弃的消息 TTL、DLQ 保留策略、强制资源删除和固定订阅到期均是明确的移除路径；参见 [retention.md](retention.md)。
- **每种结果只有一个结算动词**：`Complete` / `Abandon` / `Reject` / `Defer`，没有别名。产生新效果时，必须提供 `Receive` 返回的 `lock_token` 且租约尚未过期；下文介绍完全相同请求的回执重放。

### 大小限制

消息**正文**按单条消息限制大小，整个请求正文按每次 RPC 限制大小（避免无限批次在逐条检查前就让 broker 内存耗尽）。字符串元数据字段（`subject`、`message_id`、`group_id`、`correlation_id`、`reply_to`、`content_type`、`properties` 的键和值）**没有强制长度上限**；它们存储为 SQLite `TEXT`，请保持合理大小（它们计入发送的 JSON 请求大小，不计入消息正文上限）。

| 限制 | 默认值 | 配置项 |
|---|---|---|
| `body` 大小 | **1 MiB**，超出返回 `413 message_too_large` | `MQLITE_MAX_MESSAGE_BYTES`（serve）/ `Options.MaxMessageBytes`（嵌入式） |
| 每次 RPC 的请求正文 | **32 MiB** → `413 message_too_large` | `server.MaxBodyBytes`（正文使用 base64；特大批次应拆分） |
| 每次 `Receive` 的 `max_messages` | 256（最大值） | 请求字段 |
| `wait_time_ms` 长轮询 | 20000（最大值） | 请求字段 |
| `Peek` 的 `max` | 默认 32，最大 1000 | 请求字段 |
| 保留的订阅 | active 与 deleting 合计 10,000 | `MQLITE_MAX_SUBSCRIPTIONS`（serve）/ `Options.MaxSubscriptions` 或 `WithMaxSubscriptions`（嵌入式） |
| 过滤器 `expr` 源码 | 限制长度与 AST 节点数 | 内部限制（参见 [concepts.md](concepts.md#subscription-filters-expr)） |

## 基础 URL

下列所有示例都使用 `$BASE_URL`，因为端口无法靠猜测确定；明确写出它，就是为了避免猜错端口。

```bash
# Talking to the broker directly. mqlite serves JSON-over-HTTP on TCP 6754 and terminates
# no TLS of its own, so this is plain http. When enabled, /metrics uses the
# same listener; terminate TLS in a reverse proxy when required.
BASE_URL=http://127.0.0.1:6754

# Behind a reverse proxy. Public HTTPS on 443 (which the URL omits, as usual) terminates at
# the proxy, which forwards to the broker's internal http://…:6754.
BASE_URL=https://mq.example.com
```

6754 不是另一套二进制协议的端口——这里没有二进制协议。没有代理时，同一套 HTTP JSON API 就监听在此端口。

发现卡片中的 `endpoints` 特意使用相对的路由**路径**：它们相对于提供卡片的源站解析，因此继承其协议、主机和端口。从 `$BASE_URL` 获取卡片后，即可直接使用这些路径。启用指标时，可选的 `metrics` 字段为同源路径 `/metrics`；默认省略。与其他路径一样，相对于 `$BASE_URL` 解析它即可。

## 认证

使用一个 `Authorization: Bearer <token>` 请求头。Broker 接受 `MQLITE_TOKENS` 中配置的管理员 token（以逗号分隔），以及数据库中存储的托管访问密钥。**默认安全：**如果**未设置** `MQLITE_TOKENS`，`mqlite serve` 会在启动时生成并打印一个管理员 token。新生成的 token 始终由 `mqk_` 加 64 个小写十六进制字符组成，即 256 位随机数，总长 68 个 ASCII 字符。已有的配置 token 无须更改格式，仍然有效。Token 值区分大小写。

将 `MQLITE_TOKENS=off` 设置为显式关闭认证（默认只绑定 loopback；绑定远程可达地址需要显式的不安全覆盖开关）。此时既有队列 API 保持开放，密钥管理 RPC 则被禁止。未提供 `WithTokens` 的嵌入式 `Serve` 具有相同的显式关闭认证行为。

启用认证后，缺失、格式错误、未知、过期或已撤销的凭据返回 `401 unauthenticated`；有效密钥缺少所需权限时返回 `403 permission_denied`。密钥存储失败属于服务端错误，绝不会绕过认证。裸 token、其他认证方案和重复的 Authorization 头均会被拒绝。

### 权限

权限覆盖**此 broker 中的所有队列和订阅**。可使用 `send`、`listen`、两者的组合或 `manage`；`manage` 包含前两者，并可签发新的管理员密钥。这是消费权限，不是只读观察权限：接收、结算和续锁都会改变消息状态。

| 所需权限 | 操作 |
|---|---|
| `send` | `QueueService/Send`、`Schedule`、`Cancel` |
| `listen` | `QueueService/Receive`、`ReceiveDeferred`、`Peek`、`Stats`、`Complete`、`CompleteBatch`、`Abandon`、`Reject`、`Defer`、`Renew`、`RenewBatch`；`AdminService/Subscribe`、`TestFilter` |
| `manage` | 所有其他 `AdminService` 方法、所有 `AuthService` 方法，以及 `/metrics` |
| 配置的 monitor 凭据 | 仅 `AdminService/Observe` 和 `/metrics` |

两种接收模式都需要 `listen`，包括 receive-and-delete。批量操作和幂等重放路径与原操作使用相同的权限检查。订阅清单和删除需要 `manage`；`force` 改变的是删除前提，不是权限。固定 TTL 是创建时预先授予的自动清理授权，不能给已有订阅追加或修改。控制台的管理视图需要 `manage`。配置的 monitor token 只开放其可观测性视图。公开的静态页面本身不授予任何 API 访问权。

从 v0.3.2 开始，可通过 `MQLITE_MONITOR_TOKENS` 在管理员认证之外配置逗号分隔的只读监控凭据。嵌入式对应选项为 `WithMonitorTokens`。监控凭据与管理员凭据必须不同；关闭认证时配置 monitor token 会被拒绝。监控凭据认证不查询密钥数据库，因此即使采集失败仍然可以观察到失败情况。它们不能查看消息正文、接收、发送、更改配置或签发密钥。它们通过修改配置并重启 broker 轮换，不通过托管密钥 API；`monitor` 不是托管密钥权限。可直接运行的监控栈参见[可观测性](observability.md)。

配置的管理员和托管 `manage` 密钥具有相同的操作权限。配置凭据优先检查：将一个已有的托管 token 显式放入 `MQLITE_TOKENS`，就会授予它管理员权限，独立于数据库中的权限、过期或撤销状态。要撤回这项静态授权，必须将其从配置中移除。数据库密钥操作从不修改环境配置。

### Observe（观测）

适用于 **v0.3.2 及更新版本**；旧 broker 未实现此路由。

向 `POST /mqlite.v1.AdminService/Observe` 发送 `{}`，返回 `/metrics`、SDK `Observe`、CLI `observe`、MCP `observe` 和控制台共用的规范 broker 观测结果。需要 `manage` 或配置的 monitor 凭据。

| 字段 | 含义 |
|---|---|
| `server_time_ms` | 响应组装附近读取的 broker 生命周期时钟；缺失或为零表示不可用，兼容的旧 broker 也可能如此 |
| `sampled_at_ms`、`started_at_ms`、`backend`、`version` | 队列采样时刻、引擎运行周期以及非敏感身份信息 |
| `access` | 请求能力：`manage`、`monitor` 或 `anonymous`；SDK 嵌入式模式使用 `embedded` |
| `collection` | 队列采集 `state`、`last_success_at_ms`、最近队列瞬时值 刷新的 `duration_seconds`、有界的 `error_code` |
| `queue_count`、`subscription_count`、`queues` | 实际保留状态的数量与年龄；只有采集为 `available` 时才能使用这些计数 |
| `runtime` | Schema 版本、读探针可用性/延迟、本地存储占用的可用性/字节数；不含 DSN 或路径 |
| `messages` | 引擎运行期间的 `{queue,event,count}` 效果，在确认提交后记录 |
| `storage` | 有界的操作结果、时长、重试和数据库连接池测量 |
| `maintenance`、`filters` | 维护启用状态、结果/时长/上次成功以及过滤器失败 |
| `http` | 请求结果/完整耗时、最终认证结果，以及认证后 处理函数 直方图 |

即使队列采集为 `unavailable`，认证成功仍返回 HTTP 200：此时 `queues` 为 `null`，并明确提供失败代码和上次成功采集时间。内存计数器仍可用。不能把缺失队列或不可用的大小/探针解释为零。认证本身仍采取安全拒绝策略；数据库不可用时，托管密钥可能无法使用。纯嵌入式观测将 HTTP 域标为 `not_applicable`。

观测是在一个时间区间内采样的，并不是跨所有运行时计数器的事务。队列瞬时值 共用一次聚合 SQL 读取和一个引擎时钟值。计数器在引擎/进程重启时清零，不是持久消息账本。直方图包含累计有限桶及总计数，该总计数也就是 Prometheus 的 `+Inf` 桶。现有 处理函数 直方图不含认证；完整请求耗时包含认证和正常 Receive 长轮询。`server_time_ms` 在响应组装附近单独读取，使用与生命周期截止时间相同的 broker 时钟。因此它可以前进，而缓存命中仍正确保留较旧的 `sampled_at_ms`。

队列或订阅被物理删除后，进程运行期间的消息效果会移入文档规定的 `messages[].queue == ""` 已退役聚合项。v0.4.1 修正 Go 解码器和内置控制台以接受该特殊标签，同时仍要求完整、唯一的事件域。其事件语义和 schema token 与 v0.4.0 相同；v0.4.1 还单独新增了上述可选、向前兼容的 `server_time_ms` 观测字段。

共享解码器将观测结果限制为 32 MiB，并拒绝不完整对象、矛盾的可用性以及格式错误的直方图数据。完整 JSON schema 由 [`wire/observability.go`](../wire/observability.go) 和 [`engine/observability.go`](../engine/observability.go) 表达；指标语义与兼容别名在[可观测性](observability.md)中规定。

```bash
curl -fsS "$BASE_URL/mqlite.v1.AdminService/Observe" \
  -H "Authorization: Bearer $MQLITE_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

### CreateKey / ListKeys / RevokeKey

这些方法适用于 v0.3.1 及更新版本；v0.3.0 未实现。所有路径为 `/mqlite.v1.AuthService/<Method>`，需要启用认证并具有 `manage` 权限。

| 方法 | 请求 | 响应 |
|---|---|---|
| `CreateKey` | `id`、`name`、`permissions`、可选的 `expires_at_ms` | `{"key": <AccessKey>, "token": "mqk_…"}` |
| `ListKeys` | 可选的 `after_id`、`limit`、`sort` | `{"keys": [<AccessKey>], "next_after_id": "…"}`；最后一页省略游标 |
| `RevokeKey` | `id` | `{"ok": true}`；已撤销的记录再次调用仍成功 |

`AccessKey` 元数据包含 `id`、`name`、`permissions`、`created_at_ms`、`expires_at_ms` 和 `revoked_at_ms`。过期时间为零表示不过期；撤销时间为零表示未撤销。过期和已撤销的记录对管理者仍然可见。元数据从不包含 token 或其摘要。列表只包含托管密钥；limit 默认为 100，不能超过 1000。省略或空 `sort` 表示 `id_asc`（公开 ID 升序）。按最新优先时使用 `sort: "created_desc"`：先按创建时间降序，同一时间再按公开 ID 降序。

将前一页的 `next_after_id` 作为 `after_id` 传入，并保持排序方式不变。对于 `created_desc`，游标必须指向已有密钥；未知游标或不支持的排序返回 `400 invalid_argument`。撤销和过期不会删除记录或改变其位置。要查看游标位置之后新产生的记录，请返回第一页。分页不是并发插入的快照。`id_asc` 模式也接受合法但不存在的 ID，因此可使用所保留创建 ID 的紧邻前驱配合 `limit: 1` 来查找该 ID。

创建前先生成并保留一个公开 ID：必须恰好是 32 个小写十六进制字符，表示 128 位随机数。SDK 提供 `GenerateKeyID()`；CLI 省略 `--id` 时会自动生成。该 ID 独立于密钥秘密值，使调用方能识别响应丢失的创建操作。名称必须是非空 UTF-8 标签，最多 128 字节，不得有首尾空白或 NUL；名称不必唯一。`permissions` 接受 `send`、`listen` 或 `manage`；任何包含 `manage` 的组合都会规范化为 `["manage"]`。过期时间使用纪元毫秒数，只能为零或未来时刻。

服务端生成秘密值，只存储其 SHA-256 摘要。请安全保存创建响应：后续任何操作都无法恢复同一个秘密值。重复 ID 返回 `409 key_conflict`，不会生成或泄露密钥。响应不确定后，不要自动重试创建。应按保留的 ID 对账，确认存在但未成功交付的密钥后将其撤销，再为替代密钥使用新 ID。未查询到记录，不代表仍在进行的请求不可能随后提交。绝不能猜测应撤销哪一个同名密钥。

撤销会立即拒绝后续认证尝试。已经授权的请求（包括长轮询 Receive）仍可完成。之后的结算和续锁仍需要有效密钥。已签发密钥彼此独立：撤销签发者不会连带撤销其签发的密钥。修改权限时应签发替代密钥、切换客户端，然后撤销旧密钥。

## 无需认证的端点

| 方法 | 路径 | 返回 |
|---|---|---|
| `GET` | `/` | JSON 发现卡片，或交互式浏览器的控制台（见下文） |
| `GET` | `/healthz` | `200 ok`（存活检查） |
| `GET` | `/ui` | 嵌入式管理控制台（启用时，见下文） |

```bash
curl "$BASE_URL/"                    # what is this? (no auth)
# → {"name":"mqlite","version":"<the broker's version>","description":"...","status":"ok",
#    "auth":"bearer","docs":"https://github.com/mqlitehq/mqlite",
#    "endpoints":["/mqlite.v1.QueueService/Send", ...every RPC route...],
#    "health":"/healthz","ui":"/ui"}
curl "$BASE_URL/healthz"             # ok
```

启用嵌入式控制台时，明确优先接受 `text/html` 的交互式浏览器会收到从 `/` 到 `/ui/` 的临时重定向。没有 `Accept` 头、使用 `*/*` 或 `application/json` 的请求继续收到上面完全相同的 JSON 卡片；响应随 `Accept` 而变。无界面 broker（`MQLITE_UI=off`）始终将 `/` 保持为 JSON。这既保留了机器发现能力，也使浏览器直接访问有实用意义。

RPC 需要 token 时，卡片的 `auth` 为 `"bearer"`；关闭认证时为 `"none"`，便于 agent 直接据此分支处理。`endpoints` 是 RPC 路由路径的**完整**列表（始终与 broker 实际提供的接口一致，属于固定契约）。`health` 是相对的存活检查路径。使用 `--metrics` 或 `MQLITE_METRICS=on` 在 API 端口启用 exporter 后，可选 `metrics` 字段为 `"/metrics"`。关闭时省略该字段，即使凭据有效，该路由也返回 `404`。启用指标需要管理员认证；公布的路由仍需 monitor 或管理员凭据。不需要单独配置 URL。

`/ui` 提供**嵌入式管理控制台**（打包进二进制的静态单页应用），页面本身免认证：加载页面不需要 token，API 调用会携带用户粘贴的 token。它默认开启；设置 `MQLITE_UI=off` 可关闭界面，此时 `/ui` 返回 404，卡片也省略可选的 `ui` 字段。

## 其他端点

| 方法 | 路径 | 认证 | 返回 |
|---|---|---|---|
| `GET` | `/metrics`（启用时） | 具有 `manage` 的 Bearer 或配置的 monitor 凭据 | Prometheus 文本：`mqlite_queue_messages{queue,state}` gauge |

## QueueService

所有路径为 `/mqlite.v1.QueueService/<Method>`。

### Send（发送）

在一个事务中将一条或多条消息入队。

- **请求** `SendRequest`：`queue`（string）、`messages`（[Message]）、`scheduled_enqueue_time_ms`（int，可选）、整个批次的 `ttl_ms`（int，可选）。每条输入 Message 也可分别携带自己的 `ttl_ms`；不要将正的批次级值与正的单条值组合使用。
- **响应** `SendResponse`：`seq_numbers`（[int]），与输入消息逐项按位置对应。
- **去重**：多消息批次中发生去重冲突的位置（同一 `message_id`、不同正文）返回 `0`（跳过），其余位置仍提交。**单条消息**的 Send 则返回 `409 already_exists`。

批次级 `ttl_ms` 作用于每条消息，是 TTL 相同批次的简洁写法。单条消息的 `ttl_ms` 支持 TTL 混合的批次。没有正的批次级 TTL 时，单条值为零或省略表示该条使用队列默认值；否则继承正的批次级值。MQLite v0.4.1 客户端在所有条目 TTL 相同时使用批次级字段，仅在值不同时使用单条字段。较旧的严格 broker 会拒绝新增的混合 TTL 请求格式，而不会悄悄改变 TTL。

正的队列 `default_ttl_ms` 同时是默认值和上限：消息/请求值与队列值均为正时，有效 TTL 取较小值；只有一个为正时取该值；两者都不为正时，不限制过期时间。负 TTL、低于线协议 1ms 精度的正值，以及无法用纪元毫秒数表示的有效截止时间均无效。入队时，`expires_at_ms = initial visible_at_ms + effective
TTL`，因此定时 Send 的 TTL 从计划可见时刻起算，而不是从请求被接受时起算。之后的续锁、延迟 Abandon 和调度激活都不会移动 `expires_at_ms`。此消息 TTL 与 `AdminService/Subscribe.ttl_ms` 无关，后者是订阅资源及其 支撑队列 的固定寿命。

```bash
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data "{\"queue\":\"orders\",\"messages\":[{\"body\":\"$(printf hi|base64)\"}]}" \
  "$BASE_URL/mqlite.v1.QueueService/Send"
```

### Receive（接收）

可使用 Peek-Lock（默认）或 Receive-and-Delete；最长长轮询 `wait_time_ms`。Receive-and-Delete 会在返回前删除消息行，且不授予租约：`lock_token` 为空，`locked_until_ms` 为零（空值时省略），同一接收尝试 ID 的重放也如此。SDK 将其表示为零值 `LockedUntil` 时间。每次新授予的 `Receive` 领取 都会增加 `delivery_count`。Peek-Lock 的 `receive_attempt_id` 只有在所有已保存 token 仍持有有效租约时，才返回保存的 领取 而不再次增加计数。如果显式嵌入式活租约回收、启动时回收过期租约、结算或正常租约到期使任一 token 失效，broker 会丢弃陈旧响应，重试安全地重新 领取；绝不会返回调用方已经不再持有的所有权。仅在未观察到响应、需要重试完全相同的 Receive 时使用尝试 ID。响应到达后，不要将该 ID 用于另一次 Receive，也不要在结算其中部分消息后复用。让部分陈旧的缓存响应失效，不会撤销原响应中其他仍有效的租约：原 token 在结算或租约到期前仍有效，以防原调用方仍在处理时发生并发交付。因此，新的 领取 可能返回更少的消息，或其他当前符合条件的工作。Receive-and-Delete 在尝试记录的有效期内持续重放不含 token 的已保存响应。两种模式的保存记录都会在“五分钟”和“记录时队列锁时长”中的较大值后到期，并受固定订阅到期时间限制。重放或续锁消息都不会延长该记录的截止时间。记录到期后，同一 ID 可以产生新的 领取，即使先前续锁的 token 仍然有效。因此，尝试 ID 是有期限的恢复键，不是永久交付身份。有效的非空保存响应还会将尝试 ID 绑定到原来的 `receive_mode`；换另一种模式复用会返回 `400 invalid_argument`。空结果不保存；记录过期后也不再绑定该 ID。

Go 托管 Receiver 会在同一轮 Receive 的全部瞬时重试中保留该尝试 ID。首次瞬时失败不增加客户端生成的延迟，但 HTTP 429/503 可以通过有效的 `Retry-After` 提示控制节奏。持续失败使用带等比例抖动的指数退避，基础值为 500ms，生成延迟上限为三秒。有效提示可将某次等待提高到最多 60 秒；只要提示提高了生成延迟，就会在等待前调用错误处理函数，包括首次失败。`Retry-After: 0` 不能消除后续退避。Receiver 接受相对秒数与 HTTP-date 两种格式。绝对日期使用同一响应中可解析的 `Date` 作为基准，否则使用本地收到响应的时刻；格式错误、负值和溢出值会被忽略。取消会中断等待。成功响应（包括空批次）会开始新一轮，并生成新的尝试 ID。HTTP 500–599 按 5xx 规则视为瞬时错误；状态码 600 是终止性错误。续锁和结算使用独立的重试策略。

- **请求** `ReceiveRequest`：`queue`、`max_messages`（int，默认 1，最大 256）、`wait_time_ms`（int，长轮询，最大 20000）、`receive_mode`（int：`0` 为 peek-lock，`1` 为 receive-and-delete；其他值返回 `400 invalid_argument`）、`receive_attempt_id`（string，可选幂等键；Peek-Lock 重试仅在所有已保存租约仍有效时重放相同批次；Receive-and-Delete 重放不含 token 的保存响应）。
- **响应** `ReceiveResponse`：`messages`（[Message]），每条都携带用于结算的 `lock_token`（peek-lock 模式）。

```bash
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data '{"queue":"orders","max_messages":1,"wait_time_ms":5000}' \
  "$BASE_URL/mqlite.v1.QueueService/Receive"
# → {"messages":[{
#      "seq_number":42,"lock_token":"lt_9f3a…","delivery_count":1,
#      "body":"aGk=","message_id":"order-42","group_id":"cust-7",
#      "enqueued_at_ms":1750000000000,"locked_until_ms":1750000030000
#    }]}
# settle it: POST .../Complete {"queue":"orders","seq_number":42,"lock_token":"lt_9f3a…"}
```

### Complete / Abandon / Reject / Defer / Renew

这些操作均接受 `SettleRequest`，返回 `SettleResponse` `{ "ok": true }`。使用过期或错误的 `lock_token` 结算会返回 `409 lock_lost`，除非有效结算回执与请求完全匹配：`queue`、`seq_number`、`lock_token`、操作，以及影响其效果的参数（`delay_ms`，或 Reject 的原因/说明）。此重放规则适用于 Complete/Abandon/Reject/Defer；Renew 延长的是仍有效的租约。新的结算或续锁效果要求 `locked_until_ms > now`：精确到达截止时间即算过期，即使后台 reaper 尚未运行。Broker 在获得本地写入准入后采样时间，并为每条语句和每次远程重试重新取时。有效的完全相同请求回执，可在原租约截止之后重放已经提交的结算；它不能授权另一项请求，也不能复活租约。回执在记录后 30 分钟到期。重放不刷新截止时间；资源删除或固定订阅到期可提前终止重放。回执到期后的 `lock_lost` 不能证明原结算失败；若对账需要超出该窗口，应保留应用侧证据。

| 方法 | 附加字段 | 效果 |
|---|---|---|
| `Complete` | — | 删除消息（处理完成） |
| `Abandon` | `delay_ms`（int，可选） | 释放锁且不增加 `delivery_count`：低于最大次数时在 `delay_ms` 后重投（有序队列中，延迟的队首仍占据所属组的队首位置）；达到最大次数时转入 DLQ |
| `Reject` | `dead_letter_reason`、`dead_letter_description`（可选） | 转入 DLQ |
| `Defer` | — | 暂存到一旁，之后按序号通过 `ReceiveDeferred` 取回 |
| `Renew` | — | 延长同一次有效租约，不改变状态、token 或 `delivery_count`；不能复活过期租约 |

`SettleRequest`：`queue`、`seq_number`、`lock_token`（以及上表附加字段）。

对于没有固定到期时间的队列或订阅，Renew 提交 `locked_until_ms = max(current locked_until_ms, broker_now + lock_duration_ms)`。它从不缩短租约，快速连续续锁也不叠加时长。对有固定寿命的订阅，其绝对到期时间会限制候选截止时间。必须在当前截止时间前续锁；租约过期后，Renew 返回 `409 lock_lost`。

`max_delivery_count` 在一次持锁尝试失败时判断，而不是在授予最后一次普通 Peek-Lock 领取 时判断。例如最大次数为 10 时，普通 Peek-Lock `Receive` 可返回 `delivery_count=10`；消费者仍可反复续锁并成功 Complete。如果改为 Abandon、让租约过期，或留下锁供显式嵌入式活租约回收，则消息进入 DLQ，不会按普通路径被 领取 第十一次。启动默认会保留租约尚未过期的最后一次尝试；到期后仍执行相同的 DLQ 边界规则。`ReceiveDeferred` 当前有所不同，见下文。

> **Defer 与顺序。** 延后处理的消息仍占据队首位置：在 `group_fifo`/`strict_fifo`（或其他带分组）队列中，后续消息——同组消息，或 `strict_fifo` 下的**整个队列**——会一直阻塞，直到通过 `ReceiveDeferred` 取回并结算该消息（其他组可继续）。普通 `Receive` 不返回 deferred 消息；没有 TTL 时，也不会自动恢复。若丢失 `seq_number`，可用 `Peek` 配合 `state=deferred` 找回。

> **Abandon 与顺序。** `delay_ms > 0` 时，消息会以 `scheduled` 状态停放到退避结束，并与 deferred 队首一样，在有序队列中继续占据队首位置：同组消息（`strict_fifo` 下为整个队列）不能抢先交付。低于最大次数且没有延迟时会立即重投；达到最大次数时，无论 `delay_ms` 如何，Abandon 都将消息转入 DLQ。Abandon 和调度器不增加 `delivery_count`，只有下一次 领取 才增加。由于 `Cancel` 仅适用于从未交付过的定时发送（`delivery_count=0`），无法移除停放于此的重试消息。

> **三个独立的截止时间。** 锁租约控制一次尝试。消息 TTL 控制普通交付资格，可能在持锁期间到期；到期默认转入死信，或根据队列策略丢弃。固定订阅寿命控制整个订阅，并限制其锁的截止时间。Renew 只改变租约，不延长消息 TTL 或订阅寿命。

### CompleteBatch（批量完成）

在**一次网络往返**中完成多条消息，结算整个接收批次，避免逐条 Complete 导致的 N+1 请求（适合低开销排空）。

- **请求** `CompleteBatchRequest`：`queue`、`messages`（[{`seq_number`, `lock_token`}]）。
- **响应** `CompleteBatchResponse`：`results`（[{`seq_number`, `ok`}]），该条目锁陈旧或过期时为 `ok=false`（不使整个批次失败）。每条都与 `Complete` 一样接受所有权校验并支持幂等重放。

Go SDK 要求结果数与请求消息数完全一致、顺序相同，完成结果中不得包含续锁截止时间。成功响应中的回执格式错误时返回 `ErrOutcomeUnknown`，因为部分完成操作可能已经提交。

### RenewBatch（批量续锁）

在**一次网络往返**中延长整个接收批次的锁租约。

逐条续锁每条需要一次请求，因此在慢链路上一轮续锁可能**比被续租的租约本身还长**：64 条消息、每次调用 50ms，需要 3.2s，而锁只有 2s，多数锁会在这一轮尚未完成时过期。

- **请求** `RenewBatchRequest`：`queue`、`messages`（[{`seq_number`, `lock_token`}]）。**每次最多 512 条消息**，超出返回 `400 invalid_argument`。
- **响应** `RenewBatchResponse`：`results`（[{`seq_number`, `ok`, `locked_until_ms`}]）。该条目锁陈旧或过期时为 `ok=false`（不使整个批次失败）；每条都像 `Renew` 一样按自己的 `lock_token` 校验所有权。

`locked_until_ms` 是实际提交的 broker 绝对截止时间，必须在它之前再次续锁。`ok=true` 表示租约在 **broker 语句结束时**有效，不是响应到达调用方时有效。结果还需要映射、编码并传回，因此极短的租约可能在传输中到期。当前 broker 返回与租约使用同一时钟的 `X-Mqlite-Server-Time-Ms`；托管 Receiver 结合该观测、本地单调时钟和保守的传输预算，而不是直接比较两台主机的墙上时钟。截止时间不可用时，它在派发前执行有界同步 Renew，将续锁节奏与请求看门狗分开，为下一次请求预留两个已观测往返时间，并且绝不会仅因本地墙上时钟落在很宽的不确定区间内就延长租约。精确确认的租约若短于 50ms 最小节奏，会安全拒绝，而不会进入续锁热循环。旧 broker 在可用时使用 HTTP `Date`；两个时间头都缺失时，保留公开的绝对截止时间，但不把它用作托管的本地调度依据。Receiver 会报告一次诊断，在派发前确认所有权，并保持保守的 250ms 节奏。该回退模式没有相对租约时长信息，因此应保留至少一个时间响应头。新建及重新配置的队列明确将锁时长限制为 1 秒至 1 小时；零表示默认 30 秒。范围外的旧配置仍可读取，但极短租约在无法证明可安全续锁时可能被安全拒绝。原始 `RenewBatch` 调用方也应进行 broker 时钟映射（或同步时钟），不能仅凭时钟偏移就认定 `ErrLockLost`。（如果写入本身超过了租约期限，会得到 `ok=false`，而不是一个实际上从未持有的锁。）与单条 Renew 一样，批量操作不改变 token、状态和 `delivery_count`，并提交“已有截止时间”与 broker 新计算的 `now + lock_duration` 候选值中的较晚者（受固定订阅寿命限制）。

Go SDK 要求每个请求条目恰好对应一个按原顺序排列的结果。成功续锁必须包含正的 `locked_until_ms`；续锁失败不能声称有截止时间。格式错误的续锁结果会被拒绝，不会视为已续锁。

> **为什么是 512？** 续锁是在声明*未来*的状态（“此租约有效”），只有在一条语句内才能兑现：跨多条语句时，第一批的租约可能在后续批次仍执行时到期并被回收。`Receive` 最多交出 256 条，因此消费者不会意外触及此上限。（`CompleteBatch` 没有此限制，因为完成是终结操作，报告的是已经发生的效果。）

### ReceiveDeferred（取回暂存消息）

按序号锁定此前通过 `Defer` 暂存的消息。

- **请求** `ReceiveDeferredRequest`：`queue`、`seq_numbers`（[int]）。
- **响应** `ReceiveResponse`：`messages`（[Message]）。
- 每次成功的按序号 领取 都会增加 `delivery_count`。目前**不会**仅因 deferred 消息的计数已达到 `max_delivery_count` 而拒绝取回；取回后仍适用正常的结算/DLQ 规则。因此，普通重试路径限于第 N 次 领取，而这一显式恢复路径可能产生超过 N 的计数。

### Schedule（定时发送）

将消息入队，供未来交付（线协议请求格式与 `Send` 相同）。

- **请求**：设置 `scheduled_enqueue_time_ms`（纪元毫秒数）的 `SendRequest`。
- **响应** `SendResponse`：`seq_numbers`。

### Cancel（取消定时发送）

删除从未交付过的定时发送（`delivery_count=0`）。延迟 `Abandon` 的消息也可能处于 `scheduled`，但不能用此操作取消。

- **请求** `CancelRequest`：`queue`、`seq_number`。**响应** `SettleResponse`。

### Peek（浏览）

浏览消息而不加锁或结算（用于排查，或找回 deferred 消息的序号）。

- **请求** `PeekRequest`：`queue`、`from_seq`（int，可选）、`state`（string，可选：`active`/`locked`/`deferred`/`scheduled`/`dead_lettered`）、`max`（int，默认 32，最大 1000）。
- **响应** `PeekResponse`：`messages`（[Message]，包含 `state` 和 `dead_letter_reason`/`description`）。

### Stats（统计）

- **请求** `MetricsRequest`：`queue`。
- **响应** `MetricsResponse`：`queue`、`active`、`locked`、`deferred`、`scheduled`、`dead_lettered`、`total`、`oldest_message_age_ms`。年龄从最旧的 active 或 locked 消息起算；这两种状态都没有消息时为零。

```bash
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data '{"queue":"orders"}' "$BASE_URL/mqlite.v1.QueueService/Stats"
# → {"queue":"orders","active":128,"locked":3,"deferred":0,"scheduled":5,
#    "dead_lettered":2,"total":138,"oldest_message_age_ms":41200}
```

## AdminService

所有路径为 `/mqlite.v1.AdminService/<Method>`。

### DeleteQueue（删除队列）

v0.4.0 使用下列修正后的仅按名称寻址契约。不兼容的请求格式曾随已撤回、不受支持的 v0.3.3 发布；其公开产物仅保留供取证或兼容性检查，不能部署。v0.4.0 为 Go 模块工具提供了 `retract v0.3.3` 指令。

删除一个**普通队列**，需要管理员/manage 权限。默认仅允许删除空队列；force 是独立、显式授予的丢弃保留工作的授权。

- POST `/mqlite.v1.AdminService/DeleteQueue`
- 请求：`{"name":"orders"}` 或 `{"name":"orders","force":true}`。
- 删除完成返回 `{"deleted":true,"state":"deleted"}`。仍有有界清理工作时，接受删除返回 `{"deleted":false,"state":"deleting"}`。两者都是成功且具有权威性的结果；客户端将其他任何回执格式视为 `outcome_unknown`。
- 不使用 force 时，任何保留的消息行都会阻止删除，包括 active、locked、scheduled、deferred、completed 和 dead-lettered 状态：HTTP 409，`queue_not_empty`。应先排空或结算。使用 force 则永久丢弃这些行。已锁定的交付可能已产生外部副作用，删除 broker 记录无法撤销该效果。
- 订阅 支撑队列 会被拒绝，返回 HTTP 400、`invalid_argument`；此操作不移除主题订阅。
- 接受删除的事务将队列改为 `deleting` 并启动有界清理。若清理完成，同一次提交会删除队列并返回 `deleted`；否则提交 `deleting` 标记。此后队列操作都会被拒绝且不生效。按名称寻址的 Send、Receive、Peek、Stats 等操作返回 `not_found`；陈旧锁的结算也可能报告 `lock_lost`。已有长轮询会被唤醒；同名 `CreateQueue` 返回 `name_conflict`；`ListQueues` 继续显示保留的名称，状态为 `state:"deleting"`。丢弃授权已经持久化，后台清理不需要再调用一次 delete。
- 一次前台调用最多删除 1,000 个物理上的队列所属行，目标字节预算约 8 MiB。单行超过目标时仍会删除，以保证进展。待完成的删除会唤醒后台清理，单次全局上限为 4,096 行、目标约 8 MiB。普通路径在本地存储中最多访问 32 个有数据的资源，在远程 Turso/libSQL 中最多访问一个，以限制写事务内的远程往返。独立的集合式路径可一次完成最多 512 个空订阅的清理，不占用该资源数量额度；其映射行和 backing 行仍消耗共享行预算。完整处理 512 个订阅的快速批次会在 10ms 后安排下一次处理；其他需要继续的批次间隔一秒。空闲 broker 不会轮询生命周期工作。持久游标在两种后端都公平轮转待删除名称，防止大型或突发删除独占唯一写入者。启动时会在崩溃恢复前先恢复一次有界清理。只有消息、去重、结算回执和接收尝试记录全部移除后，行与名称才会消失。消息序号不会重置，进程事件计数器仍保留历史意义。
- 队列不存在时返回 HTTP 404、`not_found`。待删除名称消失后，后续对账请求也以不存在表示删除完成。
- 退役队列前先停止生产者和消费者。事务内的仅空队列检查会阻止删除一个已有并发发送成功回执的队列。force 则明确以丢弃授权替代这项保护。
- 队列名称可复用，公开 API 刻意不引入寿命 token。必须由一个所有者串行化删除与同名重建。收到成功的 `state:"deleted"` 响应，或确认 `ListQueues` 不再包含此前 deleting 的名称后，才能创建替代资源。重建后绝不重放旧删除请求。
- SDK 与 MCP 客户端都只调用配置的 HTTP transport 一次，不跟随 HTTP 重定向。传输失败、重定向、所有 HTTP 5xx 响应（包括网关生成的响应）和无效成功回执都视为 `outcome_unknown`。配置自定义传输和代理时，应禁止重试这些破坏性路由。保留名称并检查 `ListQueues`。遵守单所有者规则时，不存在的行确认删除已完成；`deleting` 行表示仍在清理。绝不能用再次删除来查询状态，也不能自动重试。远程数据库提交结果不确定后，引擎最多执行 30 次、间隔一秒的发现扫描，使延迟可见的退役操作进入正常清理；启动恢复是持久化兜底。不支持并发的删除/重建控制器。
- 保留访问日志时，操作记录包含服务端请求 ID、安全的 actor 分类、队列、force 决策、接受状态和返回的生命周期状态。参见[破坏性操作证据](observability.md#access-logs-and-destructive-operation-evidence)。

Go SDK 的 `client.DeleteQueue(ctx, name) error` 以及等价嵌入式方法保留仅空队列的签名。删除一旦被接受就返回 `nil`，包括后台仍继续有界清理的情况。使用 `DeleteQueueWithOptions(ctx, name, mqlite.DeleteQueueOpts{Force: true})` 可授权丢弃，并取得 `Deleted` / `State` 结果。对 `deleting` 或未知结果，通过 `ListQueues` 只读对账；后台清理不需要再次删除就会继续推进。

公开身份仍是队列名称；force 不引入寿命 token。持久删除和固定寿命元数据使 v0.4.0 使用 schema token 7，它会拒绝 schema-5 和 schema-6 文件，而不是进行迁移。Schema 6 只属于中间的未发布构建，从未打过 tag。控制台在普通队列详情中提供**删除队列**，并要求准确输入名称确认。非空队列还需要勾选 force，并显示持锁交付可能已产生副作用的警告。已接受删除但仍在清理时，控制台使用 `ListQueues` 对账，不发出可能误删同名替代资源的第二次 delete。较旧 broker 会将该操作报告为不支持。

### DeleteSubscription（删除订阅）

从 v0.4.0 开始提供。

删除一个精确的主题/订阅对。它使用与 `DeleteQueue` 相同的持久、有界生命周期，但同时拥有主题清单映射和订阅 支撑队列。

仅空删除和强制删除都需要 `manage`。`force` 字段是明确的丢弃授权，不是另一个权限级别。

- POST `/mqlite.v1.AdminService/DeleteSubscription`
- 请求：`{"topic":"events","name":"worker"}`，或在同一对象上增加 `"force":true`。对于全局唯一的订阅名称，主题不匹配时返回 `404 not_found`，绝不会仅凭名称选择订阅。
- 响应：`{"deleted":true,"state":"deleted"}` 或 `{"deleted":false,"state":"deleting"}`。不使用 force 时，任何保留的消息状态都会导致 `409 subscription_not_empty`。Force 是调用方对丢弃所有状态（包括持锁交付）的持久授权。
- 接受删除的事务将 支撑队列 标为 `deleting` 并开始有界清理。完成时，同一次提交移除映射和 支撑队列，并返回 `deleted`；否则已提交的映射和名称继续用于对账，同时订阅被排除在 扇出 和直接队列操作之外。因此，退役最后一个 active 订阅，会立即使隐式主题不再能够 扇出。删除中的映射会保留主题地址，直到物理清理完成。
- SDK 方法为 `DeleteSubscription`（仅空删除）和 `DeleteSubscriptionWithOptions(..., DeleteSubscriptionOpts{Force:true})`。内置破坏性操作客户端只调用 HTTP transport 一次，将重定向、传输失败、所有 HTTP 5xx 和无效成功正文归类为不确定结果。应使用相同主题、配合 `include_deleting:true` 调用 `ListSubscriptionsPage` 对账，不要重放删除。
- 订阅身份仍只按名称表示。一个所有者必须串行化删除与重建；临时订阅名称应全局唯一，且仅用于一个生命周期。
- 保留的访问日志记录主题/订阅目标、force 决策、接受状态和返回的生命周期状态，不存储 Bearer token。参见[破坏性操作证据](observability.md#access-logs-and-destructive-operation-evidence)。

### CreateQueue（创建队列）

创建或**更新**队列（按 `name` 幂等 **创建或更新（upsert）**：同名且**同一 `kind`** 再次调用，会覆盖该队列配置，已有消息不变）。名称属于队列、订阅和主题共用的扁平命名空间：若 `name` 已作为**主题**存在，或属于**其他种类**的实体（例如在订阅 支撑队列 上创建普通队列），会返回 `409 name_conflict`，不会悄悄接管（[概念 → 资源预配](concepts.md#provisioning--what-you-create-vs-what-is-created-for-you)）。**响应**为 `{}`（Empty）。

**请求** `CreateQueueRequest`：`name`（合法 UTF-8，1–128 字节）加 `config`（`QueueConfigJSON`，所有字段可选，省略使用默认值）。所有时长均以**毫秒**为单位。配置是**队列级**的，在此设置，不是逐次 `Send`/`Receive` 设置。

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `kind` | string | `queue` | `queue` 表示普通队列。高级 engine/wire 接口中的 `subscription` 可重配置已有的合法 支撑队列，但不能创建没有主题映射的 支撑队列；创建请使用 `Subscribe`。 |
| `lock_duration_ms` | int（ms） | `30000`（30s） | **Peek-Lock 窗口**。到达 `locked_until_ms` 时，新的结算与续锁立即失败；reaper 随后在未达投递上限时将行返回 `active`，达到上限则转入死信。`Renew` 用此时长延长同一次有效尝试；提交后的截止时间从不早于现有值。**不支持按每次 `Receive` 覆盖**，它由队列固定。`0` 选择默认 30s；显式值必须在 `1000` 至 `3600000`（1s–1h）之间，含端点。含旧范围外值的数据库仍可打开，但显式重配置必须满足范围。升级和重配置不会改写或缩短已经签发给消费者的 `locked_until_ms`。 |
| `max_delivery_count` | int | `10` | 普通交付尝试预算。第 N 次普通 Peek-Lock `Receive` 仍是可用的最后一次尝试；只有该持锁尝试被 abandon、租约到期，或启动恢复时满足 `delivery_count >= N`，才以 `reason=MaxDeliveryCountExceeded` 转入死信。`ReceiveDeferred` 增加计数，但当前不使用 N 作为准入检查。`0` 使用默认值 10。 |
| `default_ttl_ms` | int（ms） | `0` = 不限 | 消息 TTL 的默认值**与上限**。Send 的较短正 `ttl_ms` 会生效；较长值被截到上限。定时 Send 的有效 TTL 从计划可见时刻起算。到期时结束普通交付，并转入 DLQ 或丢弃，参见 `dead_letter_on_expire`。 |
| `dead_letter_on_expire` | bool | `true` | TTL 到期时：`true` → 转入 DLQ；`false` → 静默丢弃。 |
| `dedup_window_ms` | int（ms） | `0` = **关闭** | 重复检测窗口。`0` 完全关闭去重（此时 `message_id` 只是元数据）。`>0` 合并窗口内相同 `message_id` 的重复发送，参见 [`Message` 对象 → `message_id`、去重与唯一性](#message_id-dedup--uniqueness)。 |
| `ordering_mode` | string | `standard` | `standard`（每个 `GroupID` 内 FIFO，跨组并行，无分组消息无序）· `group_fifo`（相同，但每次发送**必须**携带 `group_id`，否则为 `400 group_required`）· `strict_fifo`（整个队列共用一个全局队首 FIFO）。参见[一致性规范 §5](conformance.md#5--ordering-modes)。 |
| `dlq_max_age_ms` | int（ms） | `0` = 继承 | 队列级 DLQ 保留覆盖值：丢弃年龄超过该值的死信。`0` 继承 broker 默认值，`-1` 表示不限。参见 [retention.md](retention.md)。 |
| `dlq_max_count` | int | `0` = 继承 | 最多保留 N 条死信（先丢弃最旧的）。`0` 继承，`-1` 表示不限。 |
| `dlq_max_bytes` | int | `0` = 继承 | 限制死信**正文**总字节数。`0` 继承，`-1` 表示不限。 |

DLQ 值配置的是异步保留目标，不会拒绝新死信，也不会同步强制硬上限，因此队列可能在 worker 两次处理之间，或有界清理尚未追平时，暂时超过目标。

```bash
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data '{"name":"orders","config":{
            "lock_duration_ms":60000,
            "max_delivery_count":5,
            "dedup_window_ms":300000,
            "ordering_mode":"group_fifo"
          }}' \
  "$BASE_URL/mqlite.v1.AdminService/CreateQueue"
# → {}
```

### Subscribe（订阅）

将订阅 `name` 注册到 `topic` 下（并创建其 支撑队列）。需要 `listen`；`manage` 包含 `listen`。

这是 broker 范围的 创建或更新（upsert），不是只授予创建者所有权的 create-only 操作。知道已有 `(topic,name)` 的 listener 可以更新过滤器；新的永久或临时订阅会消耗共享容量并增加发布 扇出。订阅清单和显式删除仍需 `manage`。只有 listen 权限的客户端应为临时订阅设置固定 TTL，由管理者负责提前退役。

- **请求** `SubscribeRequest`：`topic`、`name`、`filter`（可选，`{"expr": "<predicate>"}`，即[基于消息的 expr 布尔表达式](concepts.md#subscription-filters-expr)；空或省略表示全部匹配）。主题和订阅名称必须是 1–128 字节的合法 UTF-8 字符串。无效表达式或名称返回 `400 invalid_argument`。**响应** `{}`。
- 同一路由还接受 `SubscribeWithOptionsRequest`，它从 v0.4.0 开始增加可选 `ttl_ms`。正整数表示从首次成功创建起算的固定寿命；省略或零在新名称上创建永久订阅，对已有订阅则保留原寿命。JSON `null`、小数、字符串、负值、整数溢出以及 Go SDK 中大于零但小于一毫秒的时长均返回 `400 invalid_argument`。Go 方法为 `Subscribe` 和 `SubscribeWithOptions(..., SubscribeOptions{TTL: 15*time.Minute})`；旧请求结构体和方法保持不变。
- 对同一 `(topic,name)` 再次订阅，省略或设 TTL 为零会保留原截止时间，同时允许更新过滤器。重复原来的正 TTL 是幂等的，也不会延长期限。另一个正 TTL（包括试图把永久订阅改为临时订阅）会在过滤器更改前返回 `409 name_conflict`。临时订阅不能原地改为永久订阅；应删除后创建新的生命周期。
- 在 `now >= expires_at_ms` 时，订阅立即退出主题 扇出 和所有 支撑队列 操作。到期是对强制有界清理的预先授权，包括清理保留消息。名称一直保留到物理清理完成。此保证不能撤销持锁交付已产生的外部效果。创建和执行使用 broker 主机的 UTC 时钟；应同步该时钟，因为向前跳变可提前使订阅到期，向后跳变则可能推迟尚未持久转为 `deleting` 的截止时间。
- 内置控制台将输入 TTL 限制为 3,650 个固定 24 小时日，以确保其毫秒值在浏览器 JavaScript 中仍能精确表示。直接 HTTP 和 Go SDK 客户端保留 API 更宽的、经过检查的整数范围。
- 名称冲突返回 `409 name_conflict`：`topic` 指向已有队列或订阅；`name` 属于普通队列、其他主题的订阅或有效主题；以及 `topic == name`。对相同 `(topic, name)` 再订阅是幂等的过滤器更新路径，能够成功。
- Active 和 deleting 订阅共用可配置的全局容量，默认 10,000。满额时创建新映射返回 `429 resource_exhausted`；更新已有 active 映射的过滤器仍允许。Deleting 映射只有在有界物理清理完成后才释放名额。
- 旧构建创建的数据库可能有 `kind=subscription` 的 支撑队列，却没有主题映射。容量可用时，针对正确的 topic/name 调用 `Subscribe` 修复；若需退役孤立资源，再使用 `DeleteSubscription`。不要直接编辑 MQLite 拥有的表。

```bash
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data '{"topic":"replies","name":"request-01J...","ttl_ms":900000}' \
  "$BASE_URL/mqlite.v1.AdminService/Subscribe"
# → {}
```

### ListQueues（列出队列）

下文的 `state` 字段和删除中资源可见性从 v0.4.0 开始提供。

- **请求** `{}`。**响应** `ListQueuesResponse`：`queues`（[{`name`, `kind`, `state`, `lock_duration_ms`, `max_delivery_count`, `default_ttl_ms`, `dedup_window_ms`}]）。`state` 为 `active` 或 `deleting`。删除中队列在名称保留期间仍列出，但其数据面不可用。固定寿命订阅一到截止时间就报告为 `deleting`，即使周期性转换尚未持久化该状态；旧字段不公开其截止时间。

### ListSubscriptions（列出订阅）

- 需要 `manage`，因为结果列举整个 broker 的名称和过滤器。
- **请求** `{}`。**响应** `{subscriptions: [{topic, name, expr}]}`：每个 active 订阅及其主题和[过滤表达式](concepts.md#subscription-filters-expr)（`expr` 为空表示全部匹配）。此兼容路由仅返回 active/未过期订阅，刻意不分页。由于无法显示 deleting 名称保留，不再建议用于管理和对账。配置的订阅上限限制其最大大小；新集成应使用下方分页路由。Go SDK 为此方法保留原来的三字段 `SubscriptionInfo` 类型。

### ListSubscriptionsPage（分页列出订阅）

从 v0.4.0 开始提供。

- 需要 `manage`，即使用于删除或到期对账也如此。
- POST `/mqlite.v1.AdminService/ListSubscriptionsPage`。
- 请求字段：`topic`（可选，精确主题）、`after`（上一响应中的不透明游标）、`limit`（`0` 或省略为 100，最大 1,000）以及 `include_deleting`（默认 false）。
- 响应：`{"subscriptions":[{"topic","name","expr","state","created_at_ms","expires_at_ms"}],"total":N,"next_after":"..."}`。`state` 为 `active` 或 `deleting`；最后一页省略 `next_after`。两个时间戳都是必需的纪元毫秒整数。`expires_at_ms=0` 表示永久，否则大于 `created_at_ms` 且从不移动。过期行立即报告为 `deleting`，即使周期性转换尚未持久化该状态。默认视图排除这些行；`include_deleting=true` 将其纳入以便对账。`total` 是本次请求使用的快照中整个选定范围的数量，与 `after`/`limit` 无关。Go 分页条目使用 `SubscriptionPageItem`，其必需 `State` 字段与旧 `SubscriptionInfo` 类型分开。
- 按 `(topic,name)` 排序，使用 keyset 分页。游标不透明，并绑定 `topic` 和 `include_deleting`；换范围复用返回 `400 invalid_argument`。页间可更改 `limit`。
- 每次请求内部一致，但一串请求不是冻结的数据库快照；并发创建和删除可改变后续页及其 `total`。需要稳定管理导出的消费者，应在遍历期间暂停订阅变更。
- Go SDK 与 MCP 工具会拒绝 null、不完整、过大、乱序、越出请求主题/状态范围，或与 `total`、页大小、游标推进不一致的成功分页响应。这类响应不是破坏性操作对账的有效证据。

### TestFilter（测试过滤器）

- 需要 `listen`；仅计算调用方提供的表达式和样本，不读取或修改 broker 数据。
- **请求** `{expr, message?}`：试运行一个[过滤表达式](concepts.md#subscription-filters-expr)，编译 `expr`；若提供 `message`（样本，正文 base64），则完全按发布 扇出 时的方式计算，但不入队。
- **响应** `{valid, error?, ran, matched}`：`valid` 表示已编译；`error` 是准确的编译错误或运行/求值错误；`ran` 表示已对样本求值；`matched` 表示样本会路由到使用该过滤器的订阅。

### Redrive（重新投递死信）

将死信消息移回 active（或另一个队列）。每个内部批次都是原子的：同队列状态变更整体提交；跨队列则源删除与目标插入一起提交。使用 `rate_per_sec` 时，每个限流分块是独立的原子批次。之后面向消费者的交付仍是至少一次，因此 处理函数 和外部效果仍必须幂等。

- **请求** `RedriveRequest`：`queue`、`target`（string，可选，跨队列）、`max`（int）、`older_than_ms`（int）、`rate_per_sec`（int）。**响应** `RedriveResponse`：`moved`（int）。

### Purge（清空死信）

永久删除死信消息。

- **请求** `PurgeRequest`：`queue`、`max`（int）、`older_than_ms`（int；两者都为零时清空整个 DLQ）。**响应** `PurgeResponse`：`purged`（int）。保留的访问日志包含请求的两个边界及确认清除数量；参见[破坏性操作证据](observability.md#access-logs-and-destructive-operation-evidence)。

### Status（状态）

供运维视图使用的脱敏运行时快照，从不包含连接字符串或认证 token。

- **请求** `{}`。**响应** `StatusResponse`：`version`、`backend`（`memory` | `local file` | `remote libSQL/Turso`）、`remote`（bool）、`location`（本地路径，或形如 `libsql://***.turso.io` 的掩码远程主机）、`schema_version`、`ping_ms`（一次 `SELECT 1` 读往返；失败为 `-1`）、`db_size_bytes`（本地磁盘占用：db + WAL + shm；内存/远程为 `0`）、`queues`、`subscriptions`、`server_time_ms`（生命周期截止时间所用 broker 时钟的 UTC 纪元毫秒数）、`uptime_ms`、`auth`（bool）。`server_time_ms` 缺失或为零表示时钟不可用；当前客户端连接省略此字段的旧 broker 时也可能如此。

## `Message` 对象

发送**输入**与 receive/peek **输出**共用一种结构（空字段会省略）。“方向”表示由*调用方在发送时设置*（**in**），还是由 *broker 在 receive/peek 时设置*（**out**）。

| 字段 | 类型 | 方向 | 含义与约束 |
|---|---|---|---|
| `body` | base64 | in | 消息负载，对 broker **不透明**（broker 从不解析它）。唯一有大小上限的字段，默认 **≤ 1 MiB**（超出为 `413`）。允许空正文。 |
| `message_id` | string | in | 可选的**去重/幂等键**。仅当队列启用去重（`dedup_window_ms > 0`）时才生效；为空时使用正文 SHA-256。不要求唯一。**参见下一节。** |
| `group_id` | string | in | **排序/会话键**，相同 `group_id` 内的消息保持 FIFO（等价于 SQS MessageGroupId / ASB SessionId）。向 `group_fifo` 队列发送时**每条必填**（否则 `400 group_required`）；`strict_fifo` 是全局 FIFO，**不需要** `group_id`。它不是消费者组。 |
| `subject` | string | in | 自由格式的**路由标签**（等价于 ASB Label）。**不唯一**，可重复或为空。按 `.` 拆分为过滤器的 `subject_parts`（`"orders.eu.new"` → `["orders","eu","new"]`）。 |
| `correlation_id`、`reply_to`、`content_type` | string | in | 自由格式的 ASB 风格元数据；broker 存储但不解释（`content_type` 仅提示过滤器如何进行 `body_json` 解码）。 |
| `properties` | object<string,string> | in | 自定义的**字符串→字符串**头，原样存储；过滤器通过 `properties["k"]` 访问。值必须是字符串。 |
| `ttl_ms` | int（ms） | in | 用于混合 TTL 批量 Send 的可选单条 TTL；没有正的批次级 TTL 时，零/省略使用队列默认值。正值至少为 1ms，且与正的批次级 `SendRequest.ttl_ms` 互斥；所有有效 TTL 仍受正的队列默认值限制。 |
| `seq_number` | int | out | broker 分配、严格递增、**永不复用**（可不连续）；消息存续期间用于结算/浏览的标识。 |
| `delivery_count` | int | out | 已授予的 `Receive` / `ReceiveDeferred` 领取 次数。结算、续锁和定时激活不增加此计数。 |
| `lock_token` | string | out | peek-lock `Receive` 的所有权隔离 token，用于结算。 |
| `state` | string | out | 仅 `Peek`：`active`/`locked`/`deferred`/`scheduled`/`dead_lettered`。 |
| `enqueued_at_ms`、`expires_at_ms`、`visible_at_ms`、`locked_until_ms` | int | out | 纪元毫秒时间戳。 |
| `dead_letter_reason`、`dead_letter_description` | string | out | 对 DLQ 消息填充。 |

### `message_id`、去重与唯一性

最常见的问题：**发送方能否设置 `message_id`，发生冲突时会怎样？**

- **可以，由发送方设置**（可选输入字段）。它**不要求**唯一，broker 也不会为此分配值；留空则字段继续为空（启用*去重*路径时回退到正文 SHA-256）。
- **Broker 如何处理它完全取决于队列的 `dedup_window_ms`：**

| 队列去重 | `message_id` 的作用 |
|---|---|
| **关闭**（`dedup_window_ms = 0`，**默认**） | 仅为信息性元数据。**不强制唯一，因此不存在去重冲突**：发送相同 `message_id` 一千次，会得到一千条独立消息（各有自己的 `seq_number`）。可以将它作为幂等提示，由*自己的*消费者检查。 |
| **开启**（`dedup_window_ms > 0`） | 在窗口内以 **`(queue, message_id)`** 为键：<br>• 同 ID **+ 同正文** → 合并为一次入队（重复项被静默丢弃，返回原 `seq_number`）。<br>• 同 ID **+ 不同正文** → **冲突**：单条 `Send` 返回 `409 already_exists`（`ErrDedupConflict`）；多条 `Send` 的该位置返回 `seq 0`（跳过），其他条目仍提交。<br>• ID 为空 → 使用正文 SHA-256 为键（内容寻址去重）。 |

- **窗口从该键最近一次新入队起算。** 重复发送不会使窗口滑动或刷新。精确到达窗口到期时间后，该键可再次入队新消息。完成原消息不结束去重窗口：窗口内重复仍返回原序号，即使消息本身已经删除。
- **冲突检查比较的是正文的字节。** Subject、properties、路由元数据、请求 TTL 和计划时间都不参与比较。同键同正文但元数据不同，不会更新原消息。重试不确定的发送时应保持整个请求不变。

- **去重以队列为范围。** 键是 `(queue, message_id)`，因此同一 `message_id` 出现在两个队列中，或 扇出 到两个订阅 支撑队列 时不会相互冲突；两者独立。
- **“自行指定会有问题吗？”** 只有同时满足 (a) 队列**开启**去重，(b) 窗口内复用 ID 且**正文不同**时，才会出现有意设计的冲突信号。去重关闭（默认）或正文相同则没有这个问题。

## 错误

错误使用 JSON 信封 `{"code": "...", "message": "..."}` 加 HTTP 状态码。`not_found` 响应可附加可选的 `resource` 鉴别字段（`"queue"` 或 `"subscription"`）；旧客户端会安全忽略该新增字段：

| HTTP | `code` | 条件 |
|---|---|---|
| 400 | `invalid_argument` | JSON 格式错误、非对象或 `null` 正文、**未知字段**、对象之后的额外数据、无效过滤表达式、空队列名称或未知枚举（`kind` / `ordering_mode`）。解码器严格校验：字段拼错返回 400，不会被静默忽略成无操作（`mqlite.ErrInvalidArgument`）。 |
| 400 | `group_required` | 向 `group_fifo` 发送时没有 `group_id` |
| 401 | `unauthenticated` | 缺失/无效 Bearer token（认证默认启用，仅 `MQLITE_TOKENS=off` 关闭） |
| 403 | `permission_denied` | 有效密钥缺权限，或关闭认证时尝试密钥管理（`mqlite.ErrPermissionDenied`） |
| 404 | `not_found` | 队列、精确主题/订阅对或消息不存在，或路径未知。能识别资源时，缺失队列和订阅包含对应 `resource`。 |
| 409 | `already_exists` | 单条消息去重冲突（同 ID、不同正文） |
| 409 | `name_conflict` | 创建时队列/订阅/主题名称冲突，包括删除中队列保留的名称；命名空间统一且互斥（`Subscribe`/`CreateQueue`） |
| 409 | `key_conflict` | 托管密钥 ID 或 token 摘要已注册（`mqlite.ErrKeyConflict`）；不返回已有秘密值 |
| 409 | `lock_lost` | 使用过期或错误 `lock_token` 结算 |
| 409 | `queue_not_empty` | 删除发现至少一种状态仍有保留消息 |
| 409 | `subscription_not_empty` | 删除订阅发现至少一种状态仍有保留消息 |
| 429 | `resource_exhausted` | active 与 deleting 订阅容量已满（`mqlite.ErrSubscriptionLimit`） |
| 413 | `message_too_large` | 正文超过 `MaxMessageBytes`（默认 1 MiB），或请求解码超过 `server.MaxBodyBytes`（默认 32 MiB） |
| 499 | `canceled` | 请求 context 被取消。托管 Receiver 自身 context 仍有效时，将收到的 499 视为瞬时错误并重试同一 Receive 尝试。调用方取消会停止 Receive 重试并取消 处理函数 context；`Run` 返回前仍会等待活动 处理函数、续锁和有界的清理结算结束。参见[消费者停止边界](operations.md#consumer-stops-and-host-interruptions)。 |
| 503 | `unavailable` | Broker 优雅排空在 `Receive` 第一次 领取 前阻止了它。响应包含 `Retry-After: 1`（启用 CORS 时也向浏览器代码公开）；应使用**同一** `receive_attempt_id` 重试，因为本请求本身可能正重放此前响应丢失的 领取。已经完成一次确认空轮次的长轮询则以 `200` 和空 `messages` 列表唤醒。 |
| 503 | `outcome_unknown` | 远程（Turso/libSQL）写入丢失提交回执，**可能已生效，也可能未生效**。**不要盲目重试**；按 `message_id`/去重进行消息对账，或按保留的公开密钥 ID 对账密钥操作（`mqlite.ErrOutcomeUnknown`）。只会发生于远程存储，不会发生于本地文件/`:memory:`。 |
| 500 | `internal` | 非预期服务端错误 |

`503 outcome_unknown` 一行描述的是 broker 自己生成的响应。Go SDK 对生命周期删除收到的任何 HTTP 5xx 都视为 `ErrOutcomeUnknown`，即使信封代码为 `internal`，因为中间层可能在 broker 已提交后生成该响应。

Go SDK 重新导出 `mqlite.ErrLockLost`、`ErrDedupConflict`、`ErrInvalidArgument` 和 `ErrOutcomeUnknown` 等 sentinel 错误，使 `errors.Is` 在嵌入式和客户端模式下都能工作。队列或订阅删除一旦被接受，即使类型化 HTTP 结果为 `state:"deleting"`，该操作也属于成功。

连接具备资源感知能力的 broker 时，缺失队列同时匹配 `mqlite.ErrQueueNotFound` 和更宽泛的 `mqlite.ErrNotFound`，与嵌入式模式使用相同层级。新客户端连接旧 broker 时，收到的是不含 `resource` 的旧信封，只能匹配 `ErrNotFound`。

Go SDK 将普通成功响应正文限制为 64 MiB，错误正文限制为 64 KiB。除生命周期删除明确规定的 `ErrOutcomeUnknown` 情况外，非 2xx 响应可通过 `errors.As` 作为 `*mqlite.HTTPError` 获取；即使中间层未返回 JSON 错误代码，其 `StatusCode` 和 `HTTPStatus()` 仍保留 HTTP 状态。重定向错误只报告状态，不会把不可信的 `Location` 值复制进错误。

