# Turso / libSQL：并发与嵌入式副本（MQLITE-4）

本指南对应 `main`，包含尚未发布的驱动加固。使用已安装的
v0.4.2 版本时，请阅读[该标签下的 Turso 指南](https://github.com/mqlitehq/mqlite/blob/v0.4.2/docs/turso.md)；
待发布的行为变化见 [CHANGELOG.md](../CHANGELOG.md#unreleased)。

MQLite 在本地 SQLite 文件和远程
[Turso](https://turso.tech)/libSQL 数据库上运行同一套引擎——设置 `MQLITE_DB=libsql://<db>.turso.io`
（以及 `MQLITE_DB_AUTH_TOKEN`）即可。远程路径**不依赖 CGO**：它通过 `libsql-client-go` 使用
基于 HTTP 的 Hrana 协议，因此单个静态二进制仍然没有原生依赖。
本文记录并发处理方式，以及为何**不采用**嵌入式副本。

## 基于 Rust 的 Turso 技术预览

尚未发布的 `main` 也接受 `turso://<database>.turso.io`，用于连接基于 Rust 的
Turso 数据库。与 `libsql://` 数据库一样，通过 `MQLITE_DB_AUTH_TOKEN` 或
`WithDBAuthToken` 提供 token。MQLite 使用服务的
[HTTP v2 兼容端点](https://github.com/tursodatabase/turso/blob/65a31536512e3ae906277796f520785b7d68ba93/serverless/PROTOCOL.md#2-overview)，
沿用现有纯 Go 驱动和连接有效性适配层；适配层会在驱动连接字符串内转换 URI scheme。
不需要原生库，也不提高 Go 源码版本下限。

Rust 服务目前属于技术预览。采用前，应使用自己的工作负载验证队列操作、重复打开、
恢复和查询性能。MQLite 仍使用普通 `BEGIN` 事务，每个数据库只允许一个 broker / `Engine`。
提供方支持并发写入，并不意味着 MQLite 启用了 `BEGIN CONCURRENT`，也不意味着可以安全地
同时运行多个 MQLite 所有者。新提供方的 SQL 兼容性和优化器与 libSQL 相互独立；
不要假定两者具有相同的吞吐量或查询计划。

## 后端语义一致性契约

存储选择属于部署细节，不是另一种 API 模式。在已提交状态、broker 时间和请求相同的前提下，
本地 SQLite 和远程 Turso/libSQL **必须**产生相同的成功结果、校验结果、消息／资源
状态转换和逻辑哨兵错误。因此，运维人员更换 broker 的数据库 DSN 后，HTTP 状态／错误码映射
以及 Go SDK 的 `errors.Is` 行为都不会改变。具体而言，调度、投递计数、结算（settlement）、
排序、去重、主题扇出、删除和 TTL 使用同一套引擎契约。

这里的一致性指确定性的队列行为，并不表示本地文件和网络服务具有相同的故障或性能边界。
已记录的差异属于运维或故障边界：

- 远程往返造成的延迟、吞吐量和暂时可用性差异；
- 远程传输／存储故障，包括写入可能已经提交、但确认回执丢失时的 `ErrOutcomeUnknown`；
- 存储故障期间的重试和取消机制——尤其是远程事务发件箱的回调可能执行多次，其效果必须
  限定在事务内；
- 部署和维护控制：本地文件锁、SQLite 同步模式、文件大小统计和压缩整理在远程端没有
  完全相同的操作；Turso 仍然要求只有一个逻辑上的 MQLite 所有者，但无法使用本地操作系统锁；
  以及
- 明确属于运维观测的信息，例如后端标识和连接池数据。

这些差异**不得**悄然改变成功操作的队列语义，也不得将文档规定的逻辑错误变成后端特有的错误。
每个 PR 都运行不依赖外部环境的测试，约束共享引擎与错误映射；需要凭据的 nightly 测试则通过
真实 Turso 数据库，对比具有代表性的生命周期、并发、结算、访问密钥和 TTL 契约。

## 并发模型

两种模式下 MQLite 都只有**一个逻辑所有者**：每个数据库恰好有一个活跃的 MQLite broker 或
嵌入式 `Engine`。替换所有者时，必须先停止旧进程、确认其已经退出，再启动新进程。
不要让滚动替换中的新旧进程同时访问同一个数据库。不同存储模式的区别在于连接池：

| | 本地文件 / `:memory:` | `libsql://` / `turso://`（HTTP Hrana） | `ws://` / `wss://` |
|---|---|---|---|
| 写入所有权 | 1 个连接 = 本地写入器（文件锁，MQLITE-6） | 一个所有者每次只准入一次写入尝试 | 相同的远程所有权要求 |
| 提供方连接池 | MaxOpen=1, MaxIdle=1 | MaxOpen=4, MaxIdle=0 | MaxOpen=4, MaxIdle=2 |
| 观测 | 文件：1 个只读连接；`:memory:`：写入连接 | 由提供方支持的连接池 | 由提供方支持的连接池 |
| 生命周期 | ConnMaxLifetime=0 | 每次 `database/sql` 连接租借使用一个逻辑 Hrana 连接 | IdleTime=3s, Lifetime=55s |
| 物理连接复用 | SQLite 连接保持打开 | `http.DefaultTransport` 仍然复用 TCP/TLS 连接 | 对 WebSocket 连接本身进行池化 |

远程变更在获取 SQL 连接之前，先等待一个可取消的写入许可。该许可覆盖一次尝试，
直到提交或回滚结束；重试退避期间会释放许可。续锁与结算各自按 FIFO 排队，续锁优先于结算，
每个优先级的连续执行次数都有上限，以保证普通写入和维护也能取得进展。
读取仍可使用四连接池。该机制不能抢占已经运行的事务，也不能让重叠运行的 broker 或 `Engine`
实例变得安全。

公开 `Tx` 回调持有写入许可，直到该次尝试结束。应让回调保持简短，并使用提供的
`EngineTx` 执行业务 SQL 和入队。先完成回调，再等待同一个所有者上的另一项变更。

对于 HTTP Hrana，直接队列批量发送会将参数化语句分为有界组一起传输，同时让整个 Send
保持在同一个事务内，并只提交一次。扇出和具有固定到期时间的订阅仍使用原有的隔离路径。
网络延迟仍计入事务和租约预算。

对于 `libsql://`，一次连接租借
覆盖一个普通操作或一个完整事务。归还租借连接时，会先丢弃其逻辑 Hrana 连接，防止它进入空闲槽位
或直接交给等待中的调用方；这**不会**关闭共享 HTTP 传输层及其 TCP/TLS 保活连接。
无论使用本地还是远程后端，每个 broker 进程都会将成本较高的全队列观测查询结果共享约 10 秒；
不同 broker 不共享该缓存。逐队列 `Stats` 和每次观测的轻量存储探针仍然使用上表列出的后端。

## 连接恢复能力（远程路径加固）

HTTP Hrana 响应可能成功返回，同时 baton 为 null，这表示服务端已经关闭该逻辑流。
固定版本的 `libsql-client-go` 会记录关闭状态，但没有实现 `driver.Validator`。
如果没有 MQLite 适配层，`database/sql` 因而可能将已知关闭的连接放入空闲槽位，或直接交给等待中的
调用方；下一次操作在发送 HTTP 请求之前，就会在本地因包装后的 `driver.ErrBadConn`
（`"stream is closed: driver: bad connection"`）失败。显式取得的 `*sql.Conn` 也不能在调用方不知情的情况下
更换其绑定的驱动连接。

MQLite 对 `libsql://` 阻止了这种失效连接交接：兼容适配层会在 `database/sql` 连接租借结束时，
将每个逻辑连接标为无效。事务从开始到提交或回滚始终持有同一次不间断的连接租借。
这是连接有效性规则，不是扩大重试范围、缓存或 singleflight；物理 HTTP/TLS 连接复用仍由 Go 的
共享传输层负责。正常故障处理仍遵循以下有界规则：

- **仅对瞬时错误进行有界重试**——`maxConnAttempts = 6`。
- **读取在传输中断或确定的远程中止后重试。**
  `retryable = remote && (isConnErr || isBusyErr || isExpiredRemoteTransactionErr)`
  控制 `query`/`queryRowScan`：读取具有幂等性，因此在新的池连接上重放读取总是安全的。
  `isConnErr` 覆盖整个传输故障族——`driver.ErrBadConn`、关闭的 Hrana 流，以及同类的
  `EOF` / `broken pipe` / `i/o timeout`（位于 Fly 等代理后面时，连接中断表现为 `EOF`，而不是 `RST`）。
  仅包含一个提供方 HTTP 错误叶节点、且状态为 408、429、499 或 5xx 的错误，也遵循此策略。
  在尝试 COMMIT 之前，`inTx` 会丢弃失败事务，并可在相同的六次尝试上限内重新执行整个回调。
  提供方的数字状态码优先于其响应正文中的 SQLite 错误字样。
- **写入和 COMMIT 仅在能够证明请求已被拒绝时重试。** 只有真正发生于发送之前的
  `driver.ErrBadConn`，或带类型码的 `SQLITE_BUSY` 证据，才允许透明重放。
  `database is locked` 这类纯文本、Rust 预览的精确文本 `Tursodb error: Database is busy`，
  或空闲事务已回滚的提示，都不能证明已发送的写入或 COMMIT 被拒绝。
  固定版本的驱动可能丢弃非 200 HTTP 状态，只返回与普通 SQL 拒绝完全相同的文本。
  这些已发送写入会返回 `ErrOutcomeUnknown`，并保留其原始原因；不会自动重复可能已经提交的效果。
  在 COMMIT 开始之前，回调错误仍可使整个事务被丢弃，并在六次尝试预算内重试。
  本地 SQLite 行为保持不变。受支持的回调只能通过 `EngineTx.SQL()` 执行业务语句；
  不得调用其 `Commit`/`Rollback` 方法，也不得发出事务控制 SQL。事务边界由 Engine 管理。
  调用方提前提交会绕过这一分阶段契约。
- **空闲事务到期按所处阶段处理。** 提供方明确说明交互式事务因流空闲而回滚的精确提示，
  可用于识别读取和 COMMIT 前回调重试中的已知到期条件。这些路径会重新打开整个事务，
  并重新构造时间敏感参数。重试耗尽仍归入现有 `connection` 计数器类别，可选详情为
  `transaction_expired`。在独立写入或 COMMIT 已发出后收到同一非类型化文本，结果仍然未知，
  因为驱动已无法提供足够的协议信息来证明其来源。泛化的超时／回滚文本、合并原因以及
  checkpoint 失败都不能授权额外重试。
- **写入确认回执丢失表示 _结果未知（outcome-unknown）_，不进行重试**（MQLITE-59）。写入／提交时
  发生的其他传输中断——主节点可能已经持久化提交，只是回执丢失——会以 `ErrOutcomeUnknown`
  （HTTP `503 outcome_unknown`）返回，而不是盲目重放造成重复插入。
  调用方应先依据 `message_id`／去重进行对账，再决定是否重试；透明恢复需要持久化的逐操作幂等机制，
  该能力已延后。**`errors.Is(err, mqlite.ErrOutcomeUnknown)` 在嵌入式模式和客户端模式中均有效。**
  独立写入或 COMMIT 已发出后收到提供方瞬时 HTTP 响应，结果也属于未知：代理返回 502
  不能证明主节点拒绝了该效果。此类操作绝不自动重放；错误保留提供方原因和 `HTTPStatus()`，
  用于对账与诊断。HTTP 认证错误和其他非瞬时响应直接返回，不盲目重试。
  提供方 HTTP 故障仍归入现有 `connection` 存储计数器类别；可选详情携带安全的状态码及
  `provider_unavailable` 描述，而对于不确定写入，`outcome_unknown` 仍是权威分类。
  回退解码丢弃 HTTP 状态时，诊断信息不会凭空补出状态码。
  带代码的回退错误不能把远程写入提升为可安全重试的 `ErrBadConn`。
  受支持的远程变更会持有显式连接或事务；MQLite 不通过 `sql.DB.ExecContext` 发出独立写入。
- **绝不重试逻辑存储错误。** 约束冲突或 `no such table` 在引擎内直接作为最终错误返回。
  HTTP 客户端边界上的生命周期删除更为保守：所有 HTTP 5xx 都视为 `ErrOutcomeUnknown`，因为网关
  可能在 broker 已提交、但确认回执丢失后生成该响应。本地存储始终不重试（单个连接就是唯一写入器）。

> **传输层注意事项。** 结果未知保证适用于文档规定的远程传输 `libsql://`（基于 HTTP 的 Hrana）。
> `ws://`/`wss://` 传输可能将响应读取失败包装为 `ErrBadConn`，从而使丢失提交回执后的操作被*重放*——
> 远程写入需要至少一次语义时，优先使用 `libsql://`。

null-baton、空闲池、直接交接等待者、身份验证和事务连接租借契约，由
`TestHranaClosedStreamIsDiscardedBeforeFreshReuse` 与
`TestHranaTransactionKeepsOneLease` 进行隔离测试。
分类规则由 `engine/storage_test.go` 中的
`TestIsConnErr` / `TestRetryableWrite` / `TestRetryableAndAttempts` 锁定；
broker→SDK 的错误传递由 `TestFailOutcomeUnknown`（server）和 `TestRemoteOutcomeUnknownPropagates`（根包）验证，
因此没有外部凭据时，重试契约也不会悄然漂移。

`Receive` 的普通事务和带 AttemptID 的事务，都会先执行带隔离条件的
`UPDATE messages ... RETURNING`，然后才读取队列或接收尝试元数据。
这避免了其他池连接提交写入后，再将延迟读取快照升级为写事务。
第一次更新还会验证队列生命周期、订阅绝对到期时间以及与领取相关的缓存配置。
如果没有返回行，同一个写事务会读取当前元数据，以区分空队列、删除／到期、过时配置和 AttemptID 重放。
批次后续部分使用较小的、带索引的领取语句。

这种先写后读的结构解决的是单个 broker 或嵌入式 `Engine` 内的领取事务。
远程重试仍然有界，其他操作仍可能返回 `SQLITE_BUSY`；该改动不意味着
多个 broker 可以安全地同时访问同一个数据库。

## 嵌入式副本——已评估，未采用

Turso 嵌入式副本保留一份**从远程主节点同步的本地 libSQL 文件**：读取访问本地副本，写入提交至
主节点，再同步回来。它们非常适合以读取为主、跨地域分布的*读取*工作负载。
但它们不适合 MQLite，原因有两点，且彼此独立：

1. **异步同步破坏队列一致性。** 队列读取（`claim`、`peek`）针对刚刚写入的*同一批*行，
   需要写后读一致性：领取必须原子地观察到自身的状态变化。即使副本只落后主节点一个同步周期，
   也可能重新发出已经领取的消息，或看不到刚入队的消息——这正是 Peek-Lock 模型要防止的正确性问题。
   broker 是唯一逻辑所有者，因此为自身写入使用读取副本并无收益。
2. **它们需要 CGO。** 嵌入式副本位于原生 `go-libsql` 绑定中，不在 MQLite 使用的纯 Go
   `libsql-client-go` Hrana 客户端中。采用它们会重新引入 CGO 和交叉编译的困难，
   背离本项目不依赖 CGO、单个静态二进制的核心目标。

**高可用／跨地域部署建议：** 将 broker 部署在 Turso 主节点附近（低延迟 Hrana），
或每个地域运行相互独立的 broker + 数据库组合。只有在有受维护的纯 Go 驱动同时满足
同步写后读语义、Go 1.21 下限和所有受支持发布目标时，才重新评估这个决定。

## 验证状态

功能检查使用[尚未发布的兼容性候选版本](https://github.com/mqlitehq/mqlite/commit/e01577ec938902bf853026461e27bf86dcc9511f)，
通过兼容 libSQL 的 HTTP/Hrana，验证了 MQLite 在标准 Turso 与基于 Rust 的技术预览后端上的
队列和消息契约。

- **传输：** MQLite 使用纯 Go 驱动 `github.com/tursodatabase/libsql-client-go`，
  固定版本为 `v0.0.0-20251219100830-236aa1ff8acc`。MQLite 的 Go 源码下限仍为 Go 1.21。
  Rust 预览检查使用尚未发布的 URI 适配层，将 `turso://` 映射到同一 HTTP/Hrana 传输。
  对于 v0.4.2，请使用文档规定的 `libsql://` URI。
- **所有权与事务：** 每个数据库只运行一个活跃 broker 或嵌入式 `Engine`。
  MQLite 使用普通事务，而不是 `BEGIN CONCURRENT`；提供方的并发写入功能不改变此所有权模型。
- **写入确认：** COMMIT 确认回执丢失时返回 `ErrOutcomeUnknown`。
  重试之前应先对账；响应中断不能证明写入是否已经提交。
- **部署：** 将 broker 部署在 Turso 主节点附近。使用自己的消息体、并发数与批次大小测量
  延迟和吞吐量，再据此选择租约时长与请求截止时间。

### 可重复运行的测试套件

```
hermetic (always, CI)       engine/storage_test.go  retry classifiers and connection lifecycle
live (credentials-gated)   engine/turso_test.go    representative lifecycle contracts
```

在线兼容性结论仅指针对所述后端与源码候选版本，已经完成的真实在线检查。

仅可在专用、可丢弃的测试数据库上运行真实远程测试。
即使 `-run` 仅选择一个测试，`TestMain` 也会在选中的测试开始前删除所有 MQLite 管理的表，
因此重置必须得到显式确认：

```sh
MQLITE_TEST_DB=libsql://<db>.turso.io MQLITE_TEST_DB_AUTH_TOKEN=<jwt> \
  MQLITE_TEST_DB_RESET_CONFIRM=1 \
  go test ./engine -run TestTurso -v
```

未设置 `MQLITE_TEST_DB` 时，真实远程测试会跳过；隔离环境中的分类规则测试始终运行。
