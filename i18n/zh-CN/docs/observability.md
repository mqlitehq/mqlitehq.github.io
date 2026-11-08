# 可观测性

规范的 `Observe` 接口、配置式监控凭据和监控入门栈要求 **v0.3.2 或更高版本**。
更早版本只暴露[兼容性](#compatibility-and-v040-migration)一节描述的原始指标。

MQLite 通过 `AdminService/Observe`、Go SDK、CLI、MCP、控制台和 Prometheus `/metrics`
暴露同一份规范观测。队列快照和已提交消息效果来自引擎。
HTTP 请求测量来自 server；纯嵌入式使用将此领域标记为 `not_applicable`。
Grafana 从这些值派生速率、时间窗口和百分位数，不维护另一套消息计数器。

Prometheus 抓取默认关闭。使用 `MQLITE_METRICS=on` 或 `mqlite serve --metrics`，
在现有 API 端口启用需要身份验证的 `/metrics`：

```sh
MQLITE_DB=file:/data/mq.db \
MQLITE_TOKENS="$ADMIN_TOKEN" \
MQLITE_MONITOR_TOKENS="$MONITOR_TOKEN" \
MQLITE_METRICS=on \
mqlite serve --addr 127.0.0.1:6754
```

这个本地示例将 API 和指标都绑定在 loopback 上。
导出器与 broker 共享进程、引擎和计数器，不需要额外端口或虚拟机。
Go SDK 将 `WithMetrics(true)` 与 `WithTokens(...)` 配合使用，
也可增加 `WithMonitorTokens(...)`。未启用管理员身份验证时，启用指标会被拒绝。

启用后，`GET /` 自动包含 `"metrics":"/metrics"`；客户端按同源解析它。
禁用后，服务发现不包含该字段，即使凭据有效，`/metrics` 也返回 `404`。

生产环境使用私有 broker 地址，或配置入口阻止公网访问 `/metrics`，同时允许私有采集器访问。
API 和指标共用端口，因此端口级防火墙无法区分两者。
Bearer 身份验证保护数据，但不会隐藏公开可达的路由。
即使在私有网络内，也仍须提供监控凭据。

可直接运行的 broker、Prometheus 和 Grafana 栈见
[本地可观测性演示](../ops/observability/README.md)。
接入已有平台时，参见[云与 Kubernetes 指南](observability-cloud.md)。

## 访问日志与破坏性操作证据

`mqlite serve` 默认将请求日志写入 stderr。
每条输出记录都有 broker 生成的 32 字符 `request_id`；同一个值也通过
`X-Request-ID` 响应头返回，并向已配置的 CORS 客户端暴露。
broker 不信任、也不复制调用方提供的请求 ID。
启用 CORS 后的 preflight 请求有意不记录；成功的空 `Receive` 按 Debug 级别输出，
因此 Info 级别处理器可以过滤它。
该 ID 用于关联一次 HTTP 尝试与一条日志，不是幂等键，也不授权重试破坏性请求。

`actor_kind` 区分 `anonymous`、`unverified`、`static_admin`、
`static_monitor` 和 `managed_key`。
成功验证的受管理密钥还会记录公开的 `actor_key_id`，除非该 ID 等于已配置的静态凭据。
静态管理员和监控凭据没有公开 ID；无效、过期或已撤销凭据也无法安全归属，
因此这些记录不会凭空生成 ID。
身份验证请求头、token 摘要、消息正文和新生成的密钥秘密值，不会复制进访问日志字段。
资源名称和公开 ID 按设计会被记录；两者都不要包含密钥。

以下管理记录除状态、错误码、操作者、请求 ID 和耗时之外，还包含操作专属证据：

| RPC | 字段 |
|---|---|
| `DeleteQueue` | `queue`、`force`、`acceptance`（`accepted`、`rejected` 或 `unknown`），接受的结果另含 `result_state` 和 `deleted` |
| `DeleteSubscription` | `topic`、`sub`、`force`，以及相同的接受状态和结果字段 |
| `Purge` | `queue`、请求中的 `max` 和 `older_than_ms` 边界，以及确认的 `purged` 数量 |
| `CreateKey`, `RevokeKey` | 语法有效且可安全记录的公开 `key_id`；与已配置静态凭据相同的值会省略；成功操作增加 `result_state=created` 或 `revoked` |

这些记录是运维证据，不是持久化审计表。
成功记录描述 broker 结果；`acceptance=unknown` 的删除仍需只读对账。
日志不会取消“由单一所有者串行执行删除和同名重建”的规则。
资源名和公开密钥 ID 本身也可能是敏感运维元数据，因此应限制日志访问权限。

默认访问日志只存在于 stderr。容器和服务平台可能很快丢弃它，
而 `MQLITE_DIAGNOSTIC_LOG` 有意不包含常规请求。
将 stderr 转发到外部日志存储，保留时长应覆盖故障响应和破坏性请求对账窗口。
嵌入式 broker 必须通过 `WithRequestLog` 提供可保留日志的 logger；
机器消费证据时，推荐 JSON `slog` handler。
日志投递及存储耐久性仍由运维人员负责。

## 维护失败诊断

v0.4.0 为 Observe 增加可选的 `maintenance[].diagnostics` 和
`storage.operations[].last_error` 字段。
v0.3.2 及更早的快照仍然有效；缺少诊断表示**未报告**，不是健康。
现有 Prometheus 标签与累计错误桶不变。

每个维护任务报告最近结果（`never`、`ok`、`failed` 或 `interrupted`）、
上次运行时间、连续失败轮次、恢复时间和最近八个失败步骤。
一轮可能有多个步骤失败，但失败计数器只增加一次。被取消／已关闭操作仍算中断。
成功轮次清除连续失败数并记录恢复，但不清除累计失败或历史。
所有快照计数器和历史在 broker 进程重启时归零。
轮询失败会使控制台先前数据过时。

错误详情包含时间戳、生成的解释、分类、可获取的 HTTP 状态或 SQLite 错误码，以及不透明指纹。
分类区分提供方身份验证、限流、提供方可用性、DNS、TLS、超时、协议、约束、schema 和存储失败。
这些描述总结观察到的错误；仅有 HTTP 503 不能确定提供方根因。
未知提交结果仍明确属于不确定结果，必须先对账再重试。
诊断改动不会扩大写入重试范围。

某个存储桶的计数涵盖该历史桶中的**所有**发生次数，`last_error` 仅描述其最近一次失败。
历史计数或成功维护轮次都不能证明消息完整性或高可用性。
空队列仍运行后台数据库维护，因此没有客户端收发时，也可能出现失败。

### 私有诊断日志

结构化 stderr 事件 `maintenance.failure`、`maintenance.interrupted`、
`maintenance.recovered`、`storage.interrupted` 和 `storage.failure` 记录任务／步骤或操作。
失败事件包含与 Observe 相同的指纹，以及有长度上限、已遮蔽常见凭据和 URL 的提供方错误解释。
公开监控响应只包含生成的解释，绝不包含原始提供方／SQL 错误。
私有日志仍可能含敏感数据库错误上下文，仅限运维人员访问。

若要让证据保留时间超过平台 stderr 保留期，可启用单独文件：

```sh
MQLITE_DIAGNOSTIC_LOG=/data/mqlite-diagnostics.jsonl mqlite serve
# Equivalent: mqlite serve --diagnostic-log /data/mqlite-diagnostics.jsonl
```

父目录必须存在。该文件默认禁用；配置的路径无效时启动失败。
文件跨重启追加，权限模式为 `0600`，每条记录执行同步，并在 4 MiB 时轮转，
保留三个归档（`.1` 至 `.3`，新的在前）：最多保留 16 MiB 诊断记录，不承诺按时间保留。
常规请求和成功维护轮次不写入该文件；每段连续失败的恢复只记录一次。
磁盘写入失败时，原事件仍输出到 stderr，并对每段连续日志写入失败发出一次警告。

将文件挂载在持久化存储上，才能跨机器替换／部署保留；Fly 临时根文件系统不足以满足要求。
证据必须在卷丢失后仍保留，或持续错误可能填满轮转预算时，应将归档导出到别处。
该文件独立于队列数据库，重启后不会重放进 Observe 历史。
它是诊断证据，不是消息备份或故障切换机制。
嵌入式应用可通过 `WithLogger` 提供自己的 logger。

## 只读监控访问

在 `MQLITE_MONITOR_TOKENS` 配置单独的抓取器凭据，同时在 `MQLITE_TOKENS` 配置管理员凭据。
监控凭据可读取 `/metrics` 和 `AdminService/Observe`。
它们不能发送、接收、查看消息正文、管理队列、检查管理员配置或签发密钥。
管理员凭据和受管理的 `manage` 密钥保留监控访问权限。

已配置监控凭据在身份验证时不查询数据库，因此可以观测存储失败。
受管理密钥仍须检查其当前撤销和到期状态；任何监控缓存都不能绕过该检查。
不要把管理员 token 复用为监控 token。
配置变更要求重启 broker；演示的启动包装程序读取分离的密钥文件。

Prometheus 任务应引用挂载的密钥文件：

```yaml
scrape_configs:
  - job_name: mqlite
    # The native listener is plain HTTP. Use https only when a TLS proxy
    # terminates TLS in front of the private broker.
    scheme: http
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout: 10s
    authorization:
      type: Bearer
      credentials_file: /run/secrets/mqlite-monitor.token
    static_configs:
      - targets: [mqlite.internal.example:6754]
```

listener 前面有 TLS 代理时，应使用正确 TLS CA，不要禁用证书校验。
Grafana 连接 Prometheus，不需要 MQLite token。
参见 [Prometheus 授权参考](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)。

## 可用性与新鲜度

原生快照包含 `server_time_ms`、`sampled_at_ms`、采集状态、上次成功采集时间和采集耗时。
`server_time_ms` 是在响应组装附近读取的 broker 生命周期时钟，
用于参考 TTL、调度和租约截止时间。队列读取失败意味着不可用，不是“健康的空队列列表”。
Prometheus 仍响应可用的进程内测量和 `mqlite_collection_success 0`，
但省略无法采集的队列 gauge。
端点之前的失败（包括无效抓取凭据）则使 Prometheus `up` 变为零。

队列 gauge 来自在所报告 `sampled_at_ms` 时刻执行的精确分组数据库查询。
原生 `Observe`、`/metrics` 和控制台请求在进程内共享一份约 10 秒的 gauge 快照。
缓存命中保留原始时间戳，不会将缓存行呈现为新采集数据。
每个原生 Observe 响应都在组装测量后读取新的 `server_time_ms`，
因此它不是缓存的一部分，不能拿它替代队列采样时间。
消息写入和轮询不会延长固定缓存期限；创建或删除队列会使快照失效。
期限从刷新结束开始，因此异常慢扫描后，gauge 可能比当前消息状态落后“扫描耗时加约一个缓存窗口”。
逐队列 `Stats` 仍是新鲜、带索引的读取。

当前 broker 的控制台五秒循环只调用 `Observe`。
受管理队列和订阅拓扑在连接时加载，由显式刷新或配置变更触发更新；
发布、接收和结算不会扫描拓扑。订阅页面包含 deleting 行，并在浏览器按 topic 分组。
打开或刷新一个订阅详情，会执行限定于该 topic 的有界查找。
不支持 Observe 的 broker 则为缓存队列集轮询 `Stats`，使用旧版订阅列表，
不会反复探测分页路由。

计数描述采样时的存储状态，不保证消息立刻具备投递资格：可见时间、TTL、
等待维护的租约到期和排序规则都可能影响领取。
运行时探针、进程计数器和队列 gauge 在不同时刻采样。
观测并不是覆盖所有数据库、HTTP 和进程内计数器的原子事务。
采集耗时指产生 `sampled_at_ms` 的那次 gauge 刷新经过的时间；缓存命中时保持不变。

`/healthz` 是公开的进程存活检查。
`mqlite_storage_read_available` 表示真实存储读取探针；成功不能证明写入、端到端投递或数据完整性。
读取失败时不提供其延迟，而不是报告零。
内存／远程后端的本地存储大小不可用，不会伪造一个零字节数据库。

### 采集成本与间隔

每次观测都运行存储读取探针。
缓存刷新还会通过一次分组消息扫描采集完整队列清单。
按状态过滤的聚合避免为每一行更新每个状态计数，但精确刷新仍需读取所有保留行。
并发刷新共享该扫描，成功行复用约 10 秒；失败扫描不缓存，因此后续请求可重试。
刷新成本因此随当前积压和队列数量共同增长。
这里“保留”指采样时仍在 `messages` 中的行，不是历史累计吞吐量。
完成的消息通常立即删除；active、locked、deferred、scheduled 和 dead-lettered 行会保留到各自
生命周期操作发生，异常保留的 `completed` 行仍计入 `total` 和 `unexpected`。
精确逐队列 `Stats` 为每种消息状态使用一个字面量分支和现有队列前缀部分索引，
因此不扫描无关队列。

缓存保留一份队列 gauge 切片，其大小随队列清单增长，而不是随积压深度增长。
每个请求取得自己的切片，仍需分配并序列化完整响应。

本地文件数据库在一个专用的 `mode=ro` 加 `query_only` 连接上运行 `Stats`、
`SELECT 1` 存储探针和全局刷新。它无法写入或执行 checkpoint，WAL 读取也不占用唯一写入连接，
因此深积压刷新不会排在 Send、Receive 或结算之前。
读取工作在这个连接上串行执行。刷新仍消耗 CPU 和存储带宽，并在结束前持有 WAL 快照；
长扫描可能延迟 checkpoint 进度并增大 WAL。
`:memory:` 不能使用第二个连接，否则就会变成另一个数据库，因此其刷新和探针仍共享唯一写入连接。
远程 Turso/libSQL 观测使用现有小型提供方连接池，消耗提供方查询资源。

生产抓取初始间隔可设为 15 秒，按预期保留积压测量采集耗时和实际发送／接收延迟，
再调整抓取、原生接口和控制台轮询间隔。
约 10 秒 gauge 窗口内的请求共享快照，但每个请求仍执行存储探针并构建响应；频繁轮询并非没有成本。
Grafana 仪表盘刷新查询 Prometheus，不额外直接请求 broker。
本地演示使用更快间隔，使状态变化可见；生产频率应由实测工作负载需求决定。

RPC／结果和存储／错误维度采用固定词表，但其初始化为零的计数器和直方图桶仍会产生很多时间序列。
队列维度随配置清单增长，包括 active 的订阅后备队列。
默认 10,000 个订阅的上限是元数据防护，不保证包含 10,000 个实体的观测成本低。
增加清单规模或轮询频率前，应测量抓取响应大小、耗时、内存和序列数量；
小型演示可运行，不能据此确定大规模部署容量上限。

## 指标契约

Prometheus 使用 text exposition 0.0.4 格式。
除配置的实体名称外，标签均为有界类别。
凭据、密钥 ID、消息 ID、负载、表达式、原始 URL 和自由文本错误绝不作为标签。
时长以秒计；Prometheus 时间戳使用 Unix 秒，原生 JSON 使用 epoch 毫秒。

| 指标族 | 类型 | 标签／含义 |
| --- | --- | --- |
| `mqlite_info` | gauge，值为 1 | `version`、`backend`、`schema_version` |
| `mqlite_start_time_seconds` | gauge | 引擎启动时间戳 |
| `mqlite_sample_timestamp_seconds` | gauge | 快照时间戳 |
| `mqlite_collection_success` | gauge | 队列采集成功为 1，否则为 0 |
| `mqlite_collection_status` | gauge，值为 1 | `state`、有界 `error_code` |
| `mqlite_collection_last_success_timestamp_seconds` | gauge | 最近成功采集时间，首次成功前为 0 |
| `mqlite_collection_duration_seconds` | gauge | 最近队列 gauge 刷新耗时；缓存命中时不变 |
| `mqlite_entities` | gauge | `kind=queue|subscription`；队列计数不包含订阅和主题路由名称 |
| `mqlite_queue_messages` | gauge | `queue`、`state=active|locked|deferred|scheduled|dead_lettered` |
| `mqlite_queue_retained_messages` | gauge | `queue`；所有保留行，包含异常状态 |
| `mqlite_queue_unexpected_messages` | gauge | `queue`；五种正常状态之外的保留行 |
| `mqlite_queue_oldest_message_age_seconds` | gauge | `queue`；最旧 active/locked 行从原始入队时间算起的年龄，无消息时为 0 |
| `mqlite_message_events_total` | counter | `queue`、`event`；下文定义的已确认效果；`queue=""` 合并已退役队列 |
| `mqlite_rpc_requests_total` | counter | `rpc`、`code`；已注册 RPC 请求，含身份验证拒绝 |
| `mqlite_rpc_request_duration_seconds_total` | counter | 相同标签；整个请求累计耗时，包含身份验证 |
| `mqlite_rpc_duration_seconds` | histogram | `rpc`；身份验证后 handler 延迟，保留原计时范围 |
| `mqlite_authentication_total` | counter | `outcome=success|missing|invalid|expired|revoked|permission_denied|backend_error` |
| `mqlite_storage_operations_total` | counter | `operation`、`outcome`、`error_code` |
| `mqlite_storage_operation_duration_seconds` | histogram | 相同标签；存储操作耗时 |
| `mqlite_storage_retries_total` | counter | 相同标签；观测操作内的安全重试次数 |
| `mqlite_storage_pool_connections` | gauge | `state=max_open|open|in_use|idle`；本地文件合并一个写入连接和一个观测读取连接 |
| `mqlite_storage_pool_waits_total` | counter | 连接池等待次数 |
| `mqlite_storage_pool_wait_duration_seconds_total` | counter | 累计连接池等待时间，区别于 SQL 执行时间 |
| `mqlite_storage_read_available` | gauge | 存储读取探针是否成功，0 或 1 |
| `mqlite_storage_ping_seconds` | gauge | 读取往返时间；失败时省略 |
| `mqlite_storage_size_available` | gauge | 能否报告本地存储占用，0 或 1 |
| `mqlite_storage_size_bytes` | gauge | 本地 DB 加 WAL／共享内存占用；不可用时省略 |
| `mqlite_maintenance_enabled` | gauge | `task`；禁用／不适用任务为 0 |
| `mqlite_maintenance_runs_total` | counter | `task`、`outcome=success|error|interrupted` |
| `mqlite_maintenance_duration_seconds` | histogram | `task`；维护轮次耗时 |
| `mqlite_maintenance_last_success_timestamp_seconds` | gauge | `task`；最近成功轮次，首次成功前为 0 |
| `mqlite_filter_failures_total` | counter | 路由失败，`stage=compile|evaluate`；正常过滤不匹配不是错误 |

直方图序列化有限的累计 `_bucket` 样本、`+Inf` 桶、`_count` 和 `_sum`。
整个请求耗时目前提供总和与请求数，不提供直方图：两者比值是平均值，绝不是百分位数。

存储操作为 `read`、`write` 和 `transaction`；结果为 `ok`、
`error`、`rejected` 和 `outcome_unknown`。
`rejected` 加错误码 `application` 表示操作被应用／事务回调逻辑拒绝，
不是数据库故障的证据。计数表示逻辑上的引擎存储包装调用，不是逐条消息数，也不是事务中的每条 SQL。
重试单独计数，内部维护和观测读取也包含在内；采集快照本身会增加读取／探针操作。
错误类别在成功时为空，失败时为
`canceled`、`closed`、`busy`、`connection`、`full`、`corrupt`、`io`、
`application`、`outcome_unknown`、`other` 之一。
固定的存储结果／错误组合以及已注册 RPC／结果组合会初始化为零，
因此先前有成功抓取时，就能检测第一个事件。
已确认的空闲事务回滚仍归入现有 `connection` 计数器类别；可选错误详情使用更精确的
`transaction_expired` 类别。这样既保留必需的计数器矩阵，又让旧 broker 的观测数据仍可原样解码。
对已观察样本使用 `rate`/`increase`；
事件之后才开始的首次抓取无法重建事件发生时间。
维护任务为 `locks`、`scheduled`、`ttl`、
`dedup`、`receipts`、`retention`、`reclaim`、`subscription_expiry`、`lifecycle`。
`subscription_expiry` 是每秒对到期固定寿命订阅执行的索引化状态转换；
完整的 1,000 行到期批次在让出 10 ms 后继续，数据面到期不等待扫描。
`lifecycle` 是对已标记 deleting 的队列和订阅后备队列执行的事件驱动有界清理轮次。
完整的 512 行空订阅批次在让出 10 ms 后继续。
带消息的清理、错误和确认轮次仍按一秒间隔节流；空闲存储不运行该任务，
因此 `last_success` 时间戳长期不变属于预期。
远程删除提交结果不确定时，即使首次清单读取为空，也会临时安排最多 30 次、每秒一次的发现轮次。
依据最后成功时间告警前，先检查启用状态和各任务实际频率。
正常关停时取消的轮次是 `interrupted`，不算成功轮次或维护错误，也不推进最后成功时间戳。
过滤器计数器覆盖发布消息路由时的编译／求值失败。
无效 `Subscribe` 配置属于 RPC `invalid_argument` 结果；显式 `TestFilter` 验证不是路由失败。

### 消息效果

计数器在事务提交后，按已确认效果增加。
回滚、事务重试或精确的接收／结算重放，不会制造第二次已提交效果。
不确定的远程结果不会被归类为已知回滚。
计数器仅存在于进程内，重启后归零；崩溃前未被观察的活动可能丢失。
它们是运维测量，不是持久化计费或业务审计账本。

物理队列或订阅删除完成后，MQLite 移除其后备队列按名称区分的计数序列，
并将已有计数折叠到一个有界的退役聚合中。
原生观测与 Prometheus 用 `queue=""` 暴露该聚合；空标签不是可寻址队列名称。
它合并所有已退役队列名，以及旧队列拓扑时期的任何延迟事务效果。
同名重建会开始新的具名序列，旧计数仍保留在聚合中。
查询进程总活动时应包含 `queue=""`；若查询只描述当前具名队列，则过滤掉它。

v0.4.1 修正官方 Go 解码器和内嵌控制台，使其接受这个文档规定的空标签。
v0.4.0 已输出该聚合，但严格客户端会在此类退役发生后拒绝其余内容完整的观测。
v0.4.1 不改变退役聚合的事件语义和 schema token。
同一版本增加可选 `server_time_ms`；旧客户端忽略它，
当前客户端在旧 broker 缺少该字段时，将该时间值视为不可用。

通过 `EngineTx.SQL` 执行原始 SQL 仅支持调用方拥有的表；此类写入不产生消息效果事件。
不支持直接访问 mqlite 自有表，这可能绕过生命周期与可观测性不变量。

| 事件 | 含义 |
| --- | --- |
| `enqueued` | 新队列副本；主题扇出计算实际副本，不是生产者请求数 |
| `scheduled` | 入队时即定时的副本；是入队活动的子集 |
| `deduplicated`, `dedup_conflict` | 被抑制的重复发送与冲突的去重尝试 |
| `delivered`, `redelivered` | 已提交领取；重投是子集，不是额外的唯一消息 |
| `completed`, `receive_deleted` | 成功完成移除与 receive-and-delete 移除 |
| `abandoned`, `deferred`, `rejected` | 已确认的结算效果 |
| `dead_lettered` | 进入 DLQ 的状态转换，包含自动路径 |
| `ttl_discarded`, `retention_deleted` | TTL 丢弃与死信保留清理删除 |
| `purged`, `canceled`, `redriven` | 管理型 DLQ 清除、定时取消及 redrive 效果 |
| `lock_expired`, `recovered`, `activated` | 过期租约处理、启动恢复与定时激活 |

某些事件相互重叠。例如，拒绝也可能使消息进入 DLQ；不要将所有事件相加作为消息账本。
领取不能证明响应已到达客户端；完成表示消费者报告成功，不表示已经独立验证业务处理。
broker 重投、客户端 HTTP 重试和存储重试是不同概念。

### 兼容性与 v0.4.0 迁移

自 v0.3.2 起，Prometheus 抓取默认关闭。
升级时，启用 `MQLITE_METRICS=on` 或 `--metrics` 以继续在同一 API 端口抓取，
并为采集器配置监控 token。

v0.4.0 移除了两个含义不明确、且已在 v0.3.2 宣布计划移除的别名。
替换 broker 前，更新 recording rules、告警、仪表盘和直接 PromQL 查询：

| v0.4.0 中移除 | 替代项 |
| --- | --- |
| `mqlite_queue_total` | `mqlite_queue_retained_messages`（相同 gauge 值） |
| `mqlite_queue_oldest_message_age_ms` | `mqlite_queue_oldest_message_age_seconds`（原阈值除以 1,000） |

原生 `Observe` JSON 契约不变：`queues[].oldest_message_age_ms` 仍以毫秒为单位。
以下原有 Prometheus 指标族继续作为规范测量的兼容投影，不维护单独计数器：

| 现有指标族 | 规范映射 |
| --- | --- |
| `mqlite_queue_messages` | 相同队列状态 gauge |
| `mqlite_messages_completed_total` | `mqlite_message_events_total{event="completed"}` |
| `mqlite_rpc_duration_seconds` | 相同身份验证后 handler 直方图 |

没有新增独立的历史累计完成计数器。

## 仪表盘与实用查询

预配置仪表盘提供实例／队列选择、流量、积压、请求／身份验证结果、存储、维护和当前告警。
空样本仍显示“No data”或“Not available”，不会替换为表示健康的绿色零值。

```promql
# Stored queue states, not immediate claim eligibility
mqlite_queue_messages{state="active"}

# Observed completion throughput; rate handles observed counter resets
sum by (instance, queue) (rate(mqlite_message_events_total{event="completed"}[5m]))

# Handler p95; Receive includes intentional long-poll waiting
histogram_quantile(0.95, sum by (instance, rpc, le) (
  rate(mqlite_rpc_duration_seconds_bucket[5m])))

# Whole-request arithmetic mean, including authentication
sum by (instance, rpc) (rate(mqlite_rpc_request_duration_seconds_total[5m]))
/
sum by (instance, rpc) (rate(mqlite_rpc_requests_total[5m]))

# Newly observed dead-letter transitions, not net DLQ depth change
increase(mqlite_message_events_total{event="dead_lettered"}[5m])
```

对计数器使用 `rate`/`increase`，不要对队列深度 gauge 使用它们。
深度的 `delta` 表示保留状态净变化，不能衡量失败吞吐量。
不要用发送减接收推断丢失、将 locked 行算作活跃消费者，或重复累加多个采集器中的同一数据库快照。
请求可能包含批次。告警阈值应与应用 SLA 和最低请求量匹配。

## 运维处置手册

### 抓取或采集失败

首先检查 Prometheus 目标的 `lastError`。
目标不可用可能表示 broker 停止、路由／TLS 故障、抓取凭据无效或端点失败。
配置式监控凭据有效时，`up=1` 且 `collection_success=0` 表示指标端点可达，但队列快照失败。
检查有界存储错误和 broker 日志；不要将省略的 gauge 当成零。
干预前保留证据。恢复后验证新鲜的成功快照，并执行受控 send/receive/complete canary。

### 队列积压与死信

将最旧 active/locked 年龄、深度、投递和完成趋势，与应用的预期调度进行比较。
检查消费者、租约时长和排序。scheduled/deferred 工作可能是有意保留。
检查死信原因，并先修复故障再 redrive。
即使新失败仍在持续，retention、purge 和 redrive 也可能降低深度。
异常保留状态需要调查，而不是为了让曲线恢复正常就删除。
过滤器失败与正常不匹配是不同情况。

### 身份验证与集成

使用聚合结果区分缺失／无效凭据、已撤销或过期密钥，以及权限不足。
从未到达 MQLite 的客户端连接失败，需要客户端遥测。
Grafana 数据源失败与 Prometheus 抓取失败属于不同链路。
轮换已配置监控 token 时，临时同时允许新旧两份独立监控 token，重启 broker，
更新抓取器文件，确认至少两次抓取成功，再移除旧 token 并重启。
不要为了修复路由错误而授予抓取器 send/manage 权限。

### 存储与维护

检查读取探针、操作结果、错误类别、重试数和连接池等待。
`outcome_unknown` 要求幂等对账；盲目重发可能造成重复。
读取健康不能证明写入可用。宣告维护任务停滞前，检查任务启用状态和执行频率。
复用主机／容器监控，检查剩余磁盘、CPU、OOM 和卷健康。
磁盘已满、恢复或完整性事件的处置，遵循 [operations.md](operations.md#incident-actions)。

## 日志、告警与验证

请求日志保留操作／状态上下文、队列和条目数量；空 Receive 响应默认属于 Debug 噪声。
日志有助于诊断缓慢的非空请求，无需将负载、凭据或无界错误放入指标标签。
正常 long-poll 可能提高 Receive 延迟，并不一定表示存储问题。

[规则示例](../ops/observability/prometheus/rules.yml)覆盖持续抓取失败、采集／存储失败、过时采集、
异常状态、积压年龄、保留 DLQ、反复身份验证失败、不确定结果、维护和过滤器失败。
生产前应调整这些规则。Prometheus 负责条件求值；Alertmanager 或平台通知接收端需要单独配置。
本地演示中的短时 `MQLiteDemoDeadLetter` 规则明确是测试规则，不是生产策略。

[真实栈验证器](../test/observability/verify.py)检查带身份验证的抓取、监控权限隔离、规范／原生数据一致性、
实际消息身份和正文、重放、重投、定时／延后工作、DLQ 告警触发／恢复、TTL 丢弃／转死信、
保留清理删除、配置／路由过滤器错误、凭据结果、Grafana provisioning 和每个面板查询。
刻意构造的无效查询与缺失数据源，用于验证检查器会拒绝失败。
`--faults` 还会仅中断该隔离栈，验证抓取身份验证恢复、Grafana 连接失败／恢复，
以及 broker 重启后的持久化／计数器归零。
托管云／Kubernetes 部署验证仍须针对具体环境执行。

DeleteQueue、DeleteSubscription 和 ListSubscriptionsPage 是增量增加的 RPC 观测扩展。
新 broker 包含它们的请求计数器，以及 `queue_not_empty`、`subscription_not_empty`
和 `resource_exhausted` 结果。
识别仍在等待清理的资源，应使用 `ListQueues.state` 和带
`include_deleting=true` 的分页订阅清单，而不是规范观测中的队列 gauge。
`subscription_expiry` 和 `lifecycle` 维护行报告状态转换与清理健康情况；
由 force 或到期授权的丢弃，不会伪装为正常完成或保留清理消息效果。
必需解码基线不变，因此新客户端继续接受旧 broker 的观测。
资源被占用或容量不足的拒绝属于应用结果，不是存储失败。
