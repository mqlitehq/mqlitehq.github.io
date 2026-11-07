# CLI 参考（`mqlite`）

本文档跟随 `main`，包含尚未发布的更改。下文所述的跨调用本地结算和保留租约的维护行为不包含在 v0.4.2 中；如果使用该版本的已安装二进制程序，请参阅[该 tag 对应的 CLI 参考](https://github.com/mqlitehq/mqlite/blob/v0.4.2/docs/cli.md)。另见 [CHANGELOG.md](../CHANGELOG.md#unreleased)。

一个二进制程序，**两种模式**——同一组命令既可访问本地 SQLite 数据库（嵌入式模式），也可访问运行中的 broker（客户端模式），由环境变量决定：

- **嵌入式模式**：设置 `MQLITE_DB`（例如 `file:./mq.db`、`:memory:`、`libsql://…`）。命令会在当前进程内打开数据库。
- **客户端模式**：设置 `MQLITE_ENDPOINT`（以及 `MQLITE_TOKEN`）。命令通过 HTTP 与指定 broker 通信。**设置了 `MQLITE_ENDPOINT` 时，优先使用客户端模式。**

```bash
mqlite <command> [flags] [args]
```

## 连接配置（环境变量）

| 环境变量 | 含义 |
|---|---|
| `MQLITE_DB` | 嵌入式数据库 DSN：`file:./mq.db` / `:memory:` / `libsql://<db>.turso.io` |
| `MQLITE_DB_AUTH_TOKEN` | 远程 libSQL/Turso DSN 的认证 token |
| `MQLITE_ENDPOINT` + `MQLITE_TOKEN` | 客户端模式：运行中的 broker 及其 Bearer token |
| `MQLITE_MONITOR_TOKENS` | 可选的逗号分隔只读凭据，用于 `observe` 和 `/metrics`；要求启用管理员认证，且凭据必须与管理员凭据不同 |
| `MQLITE_TOKENS` | broker（`serve`）的管理员 Bearer token；**未设置 → 生成并打印一个 `mqk_…` token**；`=off` 禁用认证；其他托管密钥存放在数据库中 |
| `MQLITE_METRICS` | 在 API 端口上提供经过认证的 Prometheus `/metrics`；`on`/`true`/`1` 启用，`off`/`false`/`0` 禁用（默认）；要求启用管理员认证 |
| `MQLITE_DIAGNOSTIC_LOG` | `serve` 可选的私有轮转 JSONL 故障/恢复日志路径；父目录必须已存在；应使用持久存储 |
| `MQLITE_SYNC` | `NORMAL`（默认）/ `FULL` / `OFF` / `EXTRA` 持久性级别（嵌入式模式/serve）。无法识别的值会在**启动时被拒绝**——拼写错误绝不会静默降级为 `NORMAL`。 |
| `MQLITE_MAX_SUBSCRIPTIONS` | 活跃订阅和正在删除的订阅的总容量（默认 10,000；适用于嵌入式模式/serve，以及直接访问嵌入式数据库的 CLI 命令） |
| `MQLITE_DLQ_MAX_AGE` · `MQLITE_DLQ_MAX_COUNT` · `MQLITE_DLQ_MAX_BYTES` | broker 的异步死信队列保留目标（`serve`）；默认启用 broker 级默认值，`MQLITE_DLQ_RETENTION=off` 禁用这些默认值，但各队列的正数限制仍然生效 |

数据库连接字符串**绝不会编译进程序**——它来自环境变量。端点也来自环境变量，或下文所述的 `--endpoint`；后者会覆盖环境变量。

## 全局参数（数据和管理命令）

| 参数 | 含义 |
|---|---|
| `--endpoint <url>` | 客户端模式：运行中的 broker（覆盖 `MQLITE_ENDPOINT`） |
| `--token <bearer>` | 用于 `--endpoint` 的 Bearer token（覆盖 `MQLITE_TOKEN`） |
| `--output text\|json` | `text`（默认，供人阅读）或 `json`（机器可读，供脚本使用） |

这些参数适用于数据和管理命令。**`serve`、`version` 和 `help` 均不接受它们**（broker 本身不是客户端），而 **`vacuum` 仅支持本地执行**——它直接拒绝 `--endpoint`，因为回收数据库页需要直接打开数据库文件。

环境中的 `MQLITE_TOKEN` 只会发送给该环境指定的端点。如果 `--endpoint` 指向*另一个* broker，程序会保留 token 不予发送（并发出警告），避免泄露到其他主机——请通过 `--token` 为该目标提供认证信息。`--token=`（空值）明确表示不发送任何凭据。同一 broker 的两种写法（尾部斜杠、`mqlite://h` 与 `http://h:6754`）视为同一目标，仍会发送 token。

### `--output json` 使用线协议的字段名

CLI 在 `--output json` 模式下输出的每条消息**就是** HTTP API 的消息对象——二者使用同一结构体，因此字段名和编码相同（`seq_number`、base64 编码的 `body`、纪元毫秒时间戳）。CLI 绝不会自创或重命名字段。

有两处行为由 CLI 自己定义，*不代表* HTTP 响应的结构：

- **外层结构。**`receive`/`peek` 输出不带外层对象的消息 JSON **数组**；HTTP API 返回 `{"messages": [...]}` 对象。
- **锁 token**。仅在后续结算需要它时输出——即 `receive --no-ack` 和 `receive-deferred`。默认自动确认的 `receive` 已经对消息执行 Complete，因此不再输出 `lock_token`；原始 Peek-Lock Receive 则始终返回它。

CLI 也没有暴露*全部* HTTP 操作（例如批量发送和 attempt ID）。完整契约——所有路由和字段——请参阅 [api-reference.md](api-reference.md)。

> **跨调用结算。**`receive --no-ack` 锁定一条消息并打印其 `lock-token`；之后可用 `complete/abandon/reject/defer/renew <queue> <seq>
> <token>` 结算或续锁。broker 和本地嵌入式 CLI 的后续调用都会在截止时间前保留该 token。多进程消费者应优先使用 broker：本地数据库同一时刻仍只允许一个拥有它的进程，过期 token 也无法恢复。

## 命令

### `serve`——运行 broker

```bash
MQLITE_DB=file:/data/mq.db MQLITE_TOKENS=mqk_dev mqlite serve --addr :6754
```
| 参数 | 默认值 | |
|---|---|---|
| `--addr` | `:6754` | 监听地址 |
| `--diagnostic-log <path>` | `MQLITE_DIAGNOSTIC_LOG`（否则禁用） | 私有故障/恢复日志；4 MiB × 4 个文件；参阅[诊断日志](observability.md#private-diagnostic-log) |
| `--metrics` | `false` | 在 API 端口上启用经过认证的 `/metrics`；覆盖 `MQLITE_METRICS`；`--metrics=false` 可禁用 |
| `--insecure-allow-remote` | `false` | 认证禁用时，允许绑定非环回地址（否则拒绝） |

监听地址也可以来自 **`MQLITE_ADDR`**（优先级：`--addr` > `MQLITE_ADDR` > `:6754`；空白值会被拒绝）。禁用认证（`MQLITE_TOKENS=off`）时，除非传入 `--insecure-allow-remote`，否则 broker **拒绝绑定非环回地址**，且 **`MQLITE_CORS` 默认关闭**。

提供 RPC API、公开的 `/` 和 `/healthz`，以及嵌入式管理控制台 `/ui`（除非设置 `MQLITE_UI=off`）。启用控制台时，在交互式浏览器中打开 `/` 会重定向到 `/ui/`；curl 和 JSON 客户端仍收到机器可读的服务发现信息。只需一个参数，即可在同一 API 端口启用 Prometheus：

```bash
MQLITE_DB=file:./mq.db MQLITE_TOKENS=mqk_dev mqlite serve \
  --addr 127.0.0.1:6754 --metrics
```

等效环境配置是 `MQLITE_METRICS=on`。`on`/`true`/`1` 启用指标；`off`/`false`/`0` 禁用指标。值不区分大小写；未设置或为空时禁用指标。无效值会导致启动失败。`--metrics=false` 会覆盖环境变量中的启用设置。必须保持管理员认证启用。抓取指标时可使用已配置的管理员凭据、托管的 `manage` 密钥或已配置的监控凭据；send/listen 密钥不能抓取指标。

启用后，公开的服务发现信息包含 `"metrics":"/metrics"`，该路径相对于同一源解析。禁用后，该字段省略，且即使凭据有效，该路由也返回 `404`。无需配置独立地址或 URL。如果 API 可从公网访问，此路由也同样可访问；应通过入口路径过滤或仅限私网的 broker，避免从公网入口暴露指标。

### `key create|list|revoke`——管理持久化访问密钥

v0.3.1 及后续版本可用。客户端模式下，使用环境配置的管理员凭据或托管的 `manage` 密钥作为 `MQLITE_TOKEN`。创建或撤销密钥时，broker 可以持续运行。嵌入式模式直接管理配置的数据库，要求独占所有权；不能打开正在运行的本地 broker 所持有的数据库。

```bash
# MQLITE_ENDPOINT and MQLITE_TOKEN already select the broker and administrator.
mqlite key create --name producer --permissions send --output json
mqlite key create --name worker --permissions listen --output json
mqlite key create --name processor --permissions send,listen --output json
mqlite key create --name operator --permissions manage --output json
mqlite key list --limit 100 --output json
mqlite key list --sort created_desc --limit 25 --output json
mqlite key revoke --id <public-key-id>
```

| 子命令 | 参数 | 结果 |
|---|---|---|
| `create` | 必填 `--name`、`--permissions`；可选 `--id`、`--expires-at-ms` | 密钥元数据及仅返回一次的秘密值 |
| `list` | 可选 `--after-id`、`--limit`（默认 100，最大 1000）、`--sort id_asc\|created_desc`（默认 `id_asc`） | 元数据和后续分页游标；不包含秘密值或摘要 |
| `revoke` | 必填 `--id` | 幂等撤销一个已存在的数据库密钥 |

`--id` 是公开的 32 字符小写十六进制 ID；省略时，CLI 在联系 broker 前生成它。创建失败时会报告该 ID，便于核对结果不明确的操作，而无需凭名称猜测。秘密值是单独的 `mqk_` token，后跟 64 个小写十六进制字符。返回后请安全保存；之后无法再次获取。`--expires-at-ms` 使用纪元毫秒；零值（默认值）表示永不过期。密钥名称不要求唯一。

列表默认按公开 ID 升序排列。`--sort created_desc` 会在跨页范围内按创建时间从新到旧列出密钥；创建时间戳相同时，以 ID 降序作为次级排序。将 `next_after_id` 作为 `--after-id` 传入，并在每一页保持相同的 `--sort`；文本输出包含完整的后续分页命令。按创建时间排序时，游标必须是已存在的密钥 ID（已撤销和已过期的密钥仍可作为有效游标）。按 ID 排序时也接受不存在的前驱 ID，便于核对丢失的创建响应。

`send` 允许发送、定时发送和取消定时消息；`listen` 允许消费、结算、续锁、查看消息、查询队列统计、创建或更新订阅以及测试过滤条件；`manage` 包含这两类权限及其余管理操作，包括查看/删除订阅和签发其他 `manage` 密钥。权限适用于整个 broker。403 表示权限不足，不表示 token 无效；普通 send/listen 密钥不能使用 `key`、`list`、`status` 或管理控制台。现有的已配置管理员 token 保持原有格式和权限。

轮换托管密钥时，先创建替代密钥，让应用切换到新 token，然后撤销旧 ID。无需重启 broker。参阅[认证契约](api-reference.md#auth)和[对备份/恢复的影响](operations.md#consistent-backups)。

### `create-queue <name>`——创建或更新队列

```bash
mqlite create-queue orders --lock 30s --max-delivery 5 --dedup 10m --ordering strict_fifo
```
| 参数 | 默认值 | |
|---|---|---|
| `--lock` | 0 → 30s | Peek-Lock 时长（`0` 采用引擎默认值 30s；显式值必须介于 1s 和 1h 之间，含两端） |
| `--max-delivery` | 0 → 10 | 普通 Peek-Lock 的领取次数预算：第 N 次领取仍是可正常使用的最后一次尝试；只有这次持锁尝试失败才会将消息送入死信队列（`0` 采用默认值 10） |
| `--ttl` | 0（无限制） | 消息 TTL 的默认值**和上限**；Send 提供更短的 TTL 时遵从该值，提供更长的 TTL 时按此上限截断 |
| `--dedup` | 0（关闭） | 去重窗口 |
| `--ordering` | `standard` | `standard` / `group_fifo` / `strict_fifo` |
| `--dlq-max-age` | 0（继承） | 每队列死信保留策略：删除早于此期限的死信 |
| `--dlq-max-count` | 0（继承） | 每队列：最多保留 N 条死信（`-1` = 无限制） |
| `--dlq-max-bytes` | 0（继承） | 每队列：限制死信消息体的总字节数（`-1` = 无限制） |

### `delete-queue <name>`——退役队列

```bash
mqlite delete-queue orders             # succeeds only when every state is empty
mqlite delete-queue orders --force     # explicitly discard every retained state
```

| 参数 | 默认值 | |
|---|---|---|
| `--force` | false | 即使队列中仍保留 active、locked、scheduled、deferred、completed 或 dead-lettered 状态的行，也退役该队列 |

默认情况下，只要存在任何保留行，就会返回 `queue_not_empty`，且不改变队列。强制删除会永久丢弃这些行，以及队列拥有的去重/重试记录。持锁投递可能已产生外部副作用；删除无法撤销这些副作用。

两种输出模式都会报告有界清理是否已完成。文本输出 `ok: name=orders deleted=true state=deleted` 或 `ok: name=orders deleted=false state=deleting`；JSON 输出同样的三个字段。正在删除的队列立即停止接受数据面操作，并继续保留其名称。使用 `mqlite list` 观察其 `state`；不要再执行一次删除来查询状态。最初的强制删除授权在删除被接受时已持久化。运行中的 broker 或嵌入式引擎无需再次接收删除请求就会继续清理。单次执行的嵌入式 CLI 进程会在命令结束后退出；之后每次打开数据库都会执行一次有界恢复清理。只有名称从列表中消失后，才可重新创建同名队列。

### `subscribe <topic> <name>`——创建订阅
*（别名：`create-subscription`）*

要求 `listen` 权限。这是 broker 范围内的创建或更新操作：相同 `(topic,name)` 会更新原订阅的过滤条件，而不会创建调用方私有的资源。

```bash
mqlite subscribe orders eu-orders --expr 'subject_parts[0]=="orders" && properties["region"]=="eu"'
mqlite subscribe replies instance-7 --ttl 15m
```
| 参数 | | |
|---|---|---|
| `--expr` | "" | 订阅过滤条件——[expr](concepts.md#subscription-filters-expr) 布尔谓词；为空表示匹配全部 |
| `--ttl` | `0` | 从首次成功创建起计算的固定存活期；零值表示创建永久订阅，或保留现有存活期 |

对现有订阅，省略 `--ttl` 或传入零值会保留其存活期。重复传入最初的正数值是幂等操作；传入不同的正数值会返回名称冲突，且不会改变过滤条件。过期时间意味着预先授权系统在有界清理期间丢弃保留消息。这是仅有 listen 权限的临时客户端的清理途径；拥有管理权限的调用方也可在正常完成后提前显式退役订阅。

### `delete-subscription <topic> <name>`——退役订阅

无论是否使用 `--force`，均要求 `manage` 权限。

```bash
mqlite delete-subscription orders eu-orders
mqlite delete-subscription orders eu-orders --force
```

主题和全局唯一的订阅名称必须完全匹配。默认仅允许删除空订阅；`--force` 会永久丢弃 支撑队列 中所有状态的保留消息。删除被接受的订阅会立即退出扇出，并报告 `state=deleted` 或 `state=deleting`。待完成的清理会继续保留映射和名称。通过 `mqlite list-subscriptions --topic orders --include-deleting` 核对状态；发生传输失败、重定向、HTTP 5xx 响应或格式错误的回执后，绝不能重放删除请求。应配置代理，使其不重试资源生命周期删除路由。

### `send <queue> <body>`——将消息入队
`body` 为 `-` 时从标准输入读取；也可使用 `--file`。

```bash
mqlite send orders '{"id":1}' --group order-1 --message-id m1
echo '{"id":2}' | mqlite send orders -
```
| 参数 | | |
|---|---|---|
| `--file` | 从文件读取消息体 |
| `--message-id` | 去重/幂等键 |
| `--group` | 分组 ID（顺序/会话键） |
| `--subject` | 主题标签 |
| `--reply-to` | 回复地址 |
| `--ttl` | 每条消息的 TTL；从消息首次可见时开始，且受队列正数默认值的上限约束 |

### `receive <queue>`——消费消息（Peek-Lock）
默认接收后自动执行 Complete。使用 `--no-ack` 可使消息保持锁定，并打印每条消息的 `lock-token`（之后结算——参阅下文的结算命令）；使用 `--delete` 则采用至多一次的 broker 移除语义。

```bash
mqlite receive orders --max 10 --wait 5s
```
| 参数 | 默认值 | |
|---|---|---|
| `--max` | 1 | 最大消息数 |
| `--wait` | 0 | 长轮询等待时间（例如 `5s`） |
| `--no-ack` | false | 使消息保持锁定（不执行 Complete） |
| `--delete` | false | 接收并删除（至多一次的 broker 移除语义，无锁） |

**自动确认绝不会确认你看不到的输出**。只有在消息体成功写入标准输出*之后*，才会对该消息执行 Complete。如果写入失败（管道断开），消息会保持锁定，之后重新投递；如果标准输出根本无法传递内容（在执行时已关闭，或指向 `/dev/null`），命令会事先拒绝执行——不会领取任何消息。如需显式清空队列，请使用 `--delete`；如只需要锁 token，请使用 `--no-ack`。

### `peek <queue>`——不加锁浏览消息

```bash
mqlite peek orders --state dead_lettered --max 20
```
| 参数 | 默认值 | |
|---|---|---|
| `--state` | "" | `active`/`locked`/`deferred`/`scheduled`/`dead_lettered` |
| `--from` | 0 | 起始序列号 |
| `--max` | 16 | 最大消息数 |

### `metrics <queue>`——队列计数器
默认打印适合人阅读的一行文本；使用 `--output json` 获取 JSON 对象。（**0.3.0 中的变化：**`metrics` 以前总是输出 JSON——解析旧版默认输出的脚本必须添加 `--output json`。）

```bash
mqlite metrics orders                 # active / locked / deferred / scheduled / dead_lettered / total
mqlite metrics orders --output json   # machine-readable
```

### `list`——列出队列和订阅

```bash
mqlite list
```

每行包含 `state=active` 或 `state=deleting`。正在删除的普通队列仍会列出，因为其名称仍被保留；但对它的队列操作会被拒绝，无法生效。

### `redrive <queue>`——将死信移回活跃状态

```bash
mqlite redrive orders --max 100              # back to source
mqlite redrive orders --to orders-replay     # to another queue
```
| 参数 | 默认值 | |
|---|---|---|
| `--to` | "" | 目标队列（默认移回源队列） |
| `--max` | 0（全部） | 最大消息数 |
| `--older-than` | 0 | 仅处理早于此期限的消息 |

### `purge-dlq <queue>`——删除死信
这是破坏性操作。**不设范围上限**的清理必须显式传入 `--all`；否则必须提供限制条件（`--max`/`--older-than`）。负数限制值会被拒绝（否则它们会被解释为“无限制”）。必须恰好提供一个位置参数 `<queue>`——多余参数会报错，不会被忽略。

```bash
mqlite purge-dlq orders --older-than 24h    # bounded
mqlite purge-dlq orders --all               # delete the entire DLQ (explicit)
```
| 参数 | 默认值 | |
|---|---|---|
| `--max` | 0 | 最多删除的消息数（0 = 无限制 → 要求 `--all`） |
| `--older-than` | 0 | 仅删除早于此期限的消息（**最小 1ms**——不足一毫秒的值会被舍入为“无限制”） |
| `--all` | false | 删除整个死信队列（执行无范围限制的清理时必填） |

### `vacuum`——向操作系统归还空闲数据库页
本地维护操作（嵌入式模式；**先停止 broker**——否则独占写入锁会拒绝打开）。新的本地数据库使用 `auto_vacuum=INCREMENTAL`，因此默认操作会执行检查点，并回收当前增量空闲页列表中的全部页面；`--full` 执行完整的 `VACUUM`（重写文件，持有全局锁）。运行中的 broker 也会在至少有 256 个空闲页时，每 60 秒执行一次有界回收。不适用于远程 Turso/libSQL 存储。为执行 vacuum 而打开已停止的 broker 数据库，会保留所有未过期投递及其所有权隔离 token。

```bash
MQLITE_DB=file:/data/mq.db mqlite vacuum          # incremental
MQLITE_DB=file:/data/mq.db mqlite vacuum --full   # full rewrite
```

### `complete` / `abandon` / `reject` / `defer` / `renew`——结算消息
结算之前通过 `receive --no-ack` 接收的消息（该命令会打印 `lock-token`）。位置参数始终为 `<queue> <seq> <lock-token>`。并发消费者推荐使用 broker；只要租约仍有效，本地嵌入式调用也可结算 token（参阅全局参数一节的说明）。

```bash
mqlite complete orders 42 lt_9f3a…                 # done
mqlite abandon  orders 42 lt_9f3a… --delay 60s     # retry after backoff, or DLQ at the limit
mqlite reject   orders 42 lt_9f3a… --reason bad    # dead-letter it (--detail …)
mqlite defer    orders 42 lt_9f3a…                 # set aside for receive-deferred
mqlite renew    orders 42 lt_9f3a…                 # extend the same live delivery's lease
```

`renew` 不会产生另一次投递尝试或增加 `delivery_count`，也无法在租约过期后将其恢复。

### `schedule <queue> <body>`——入队并在将来投递

```bash
mqlite schedule orders '{"id":1}' --at 30m                     # a duration from now
mqlite schedule orders '{"id":1}' --at 2027-01-02T15:04:05Z    # or an absolute RFC3339 time (must be future)
```
| 参数 | | |
|---|---|---|
| `--at` | 必填 | 投递时间：RFC3339 格式或时长（`30m`、`2h`） |
| `--file` · `--message-id` · `--group` · `--subject` | | 与 `send` 相同 |

尚未投递过的定时 Send（`delivery_count=0`），可在激活之前通过 **`cancel <queue> <seq>`** 取消。由延迟 `Abandon` 暂放在 `scheduled` 状态的重试消息已经投递过，不能通过这种方式取消。

### `receive-deferred <queue> --seq …`——按序列号获取延后处理的消息

```bash
mqlite receive-deferred orders --seq 42,57      # re-locks them and prints tokens to settle
```

### `observe`——规范化观测数据

**v0.3.2 及后续版本**可用。远程模式要求 broker 版本为 v0.3.2 或更高；配置式监控凭据也是 v0.3.2 新增的功能。

```bash
mqlite observe --output json
MQLITE_ENDPOINT=http://127.0.0.1:6754 MQLITE_TOKEN="$MONITOR_TOKEN" mqlite observe
```

两种输出模式都会打印完整的规范化 JSON 快照，包括采集可用性/新鲜度、队列瞬时值、已提交的消息操作效果、存储操作、维护、过滤失败，以及 HTTP 请求/认证测量值。它与 SDK `Observe`、MCP `observe` 以及 HTTP `Observe` 路由使用同一数据契约；`/metrics` 将这些测量值序列化为 Prometheus 格式。

解读队列计数之前，应先检查 `collection.state`。采集不可用时是 `queues: null`，不表示消息数为零；只要配置的凭据可以通过认证，进程计数器仍可使用。时长以秒为单位，时间戳使用纪元毫秒，进程计数器在重启时归零。嵌入式模式将 HTTP 标记为 `not_applicable`。运行时的 `read_available` 和 `db_size_available` 用于区分未知或不支持的测量值与真正的零值。参阅 [observability.md](observability.md)。

配置的 `MQLITE_MONITOR_TOKENS` 凭据只能调用 `observe` 和 `/metrics`。它还可打开控制台的只读概览/指标视图。`manage` 包含观测权限；托管的 `send`/`listen` 密钥不会因此获得整个 broker 的监控权限。监控凭据在启动时配置，不能通过 `key create` 创建。

### `status`——后端快照

```bash
mqlite status                 # backend, broker UTC clock, schema, ping, size, queue/subscription counts
```

当前 broker 会将生命周期时钟打印为 `broker time`；JSON 输出通过 `server_time_ms` 暴露同一值。这是 TTL、定时发送和租约截止时间所使用的时钟。兼容的旧版 broker 会省略此字段，表示该值不可用，而不是 Unix 纪元零点。

### `list-subscriptions`——列出订阅及其主题和过滤条件

要求 `manage` 权限；它会暴露整个 broker 的订阅名称、过滤条件和生命周期。

```bash
mqlite list-subscriptions                                      # all active (legacy-compatible)
mqlite list-subscriptions --topic orders --limit 100
mqlite list-subscriptions --topic orders --include-deleting
```

不传分页参数时，该命令保留原有的完整活跃订阅输出和 JSON 数组。传入 `--topic`、`--after`、`--limit` 或 `--include-deleting` 中任意一项，会选择分页 API，返回包含 `subscriptions`、`total` 和可选的 `next_after` 的分页对象。默认每页 100 条，最多 1,000 条。游标是不透明的，且绑定于主题/是否包含删除中订阅的范围。每一页都是当前快照；并发发生的订阅名单变化可能影响后续页面。每条记录都包含必填的 `created_at_ms` 和 `expires_at_ms` 字段；过期时间为零表示永久。使用 `--include-deleting` 时，过期行即使尚未完成物理清理，也会以 `deleting` 状态显示。

### `test-filter <expr>`——试运行订阅过滤条件
要求 `listen` 权限；不读取 broker 数据，也不产生任何持久化变更。

编译表达式；若提供示例消息，则报告它是否会匹配（不会将任何消息入队）。

```bash
mqlite test-filter 'subject == "ord.created"'                       # just validate
mqlite test-filter 'subject == "ord.created"' --subject ord.created # validate + test a sample
```
| 参数 | | |
|---|---|---|
| `--subject` · `--group` · `--prop k=v,k=v` · `--file` | | 构造示例消息 |

### `version` / `help`

```bash
mqlite version
mqlite help
```

## 端到端示例

```bash
# embedded: produce + consume against a local file, no broker
export MQLITE_DB=file:./mq.db
mqlite create-queue jobs
mqlite send jobs "hello"
mqlite receive jobs --wait 2s

# client: same commands against a running broker
export MQLITE_ENDPOINT=https://your-mqlite.fly.dev MQLITE_TOKEN=mqk_prod_xxx
mqlite list
mqlite metrics jobs
```

另见：[api-reference.md](api-reference.md)（HTTP）、[mcp.md](mcp.md)（智能体）、[examples.md](examples.md)（Go SDK）。

