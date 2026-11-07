# Turso / libSQL：并发与嵌入式副本（MQLITE-4）

本指南对应 `main`，包含尚未发布的驱动加固。使用已安装的
v0.4.2 版本时，请阅读[该标签下的 Turso 指南](https://github.com/mqlitehq/mqlite/blob/v0.4.2/docs/turso.md)；
待发布的行为变化见 [CHANGELOG.md](../CHANGELOG.md#unreleased)。

MQLite 在本地 SQLite 文件和远程
[Turso](https://turso.tech)/libSQL 数据库上运行同一套引擎——设置 `MQLITE_DB=libsql://<db>.turso.io`
（以及 `MQLITE_DB_AUTH_TOKEN`）即可。远程路径**不依赖 CGO**：它通过 `libsql-client-go` 使用
基于 HTTP 的 Hrana 协议，因此单个静态二进制仍然没有原生依赖。
本文记录并发处理方式，以及为何**不采用**嵌入式副本。

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

| | 本地文件 / `:memory:` | `libsql://`（HTTP Hrana） | `ws://` / `wss://` |
|---|---|---|---|
| 写入所有权 | 1 个连接 = 本地写入器（文件锁，MQLITE-6） | 一个 broker 拥有 4 连接池；Turso 串行提交 | 相同的远程所有权要求 |
| 写入连接池 | MaxOpen=1, MaxIdle=1 | MaxOpen=4, MaxIdle=0 | MaxOpen=4, MaxIdle=2 |
| 观测 | 文件：1 个只读连接；`:memory:`：写入连接 | 由提供方支持的连接池 | 由提供方支持的连接池 |
| 生命周期 | ConnMaxLifetime=0 | 每次 `database/sql` 连接租借使用一个逻辑 Hrana 连接 | IdleTime=3s, Lifetime=55s |
| 物理连接复用 | SQLite 连接保持打开 | `http.DefaultTransport` 仍然复用 TCP/TLS 连接 | 对 WebSocket 连接本身进行池化 |

在单个 MQLite 进程内使用小型远程连接池是安全的，因为 Turso 主节点会将各连接的写入串行化；
这不意味着同时运行两个 broker 或嵌入式 `Engine` 实例也是安全的。对于 `libsql://`，一次连接租借
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
- **读取在任何传输中断后重试。** `retryable = remote && (isConnErr || isBusyErr)`
  控制 `query`/`queryRowScan`：读取具有幂等性，因此在新的池连接上重放读取总是安全的。
  `isConnErr` 覆盖整个传输故障族——`driver.ErrBadConn`、关闭的 Hrana 流，以及同类的
  `EOF` / `broken pipe` / `i/o timeout`（位于 Fly 等代理后面时，连接中断表现为 `EOF`，而不是 `RST`）。
- **只有能够证明语句从未生效时才重试写入**——`retryableWrite =
  remote && (ErrBadConn || isBusyErr)`。关闭的流（`ErrBadConn`）或 `SQLITE_BUSY`
  （从未取得锁）保证写入没有执行，因此重放 `exec` / `inTx` 的提交不会重复生效。
  重试次数受 `maxConnAttempts` 限制；耗尽后向调用方返回错误。
  DSN 中的 `busy_timeout(5000)` pragma 仅适用于本地 modernc SQLite 连接，不适用于 Turso/libSQL。
- **写入确认回执丢失表示 _结果未知（outcome-unknown）_，不进行重试**（MQLITE-59）。写入／提交时
  发生的其他传输中断——主节点可能已经持久化提交，只是回执丢失——会以 `ErrOutcomeUnknown`
  （HTTP `503 outcome_unknown`）返回，而不是盲目重放造成重复插入。
  调用方应先依据 `message_id`／去重进行对账，再决定是否重试；透明恢复需要持久化的逐操作幂等机制，
  该能力已延后。**`errors.Is(err, mqlite.ErrOutcomeUnknown)` 在嵌入式模式和客户端模式中均有效。**
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

```
hermetic (always, in CI)   engine/storage_test.go    conn-error retry classifier
live  (creds-gated, nightly) engine/turso_test.go     full lifecycle vs real Turso
```

仅可在专用、可丢弃的测试数据库上运行真实远程测试。
即使 `-run` 仅选择一个测试，`TestMain` 也会在选中的测试开始前删除所有 MQLite 管理的表，
因此重置必须得到显式确认：

```sh
MQLITE_TEST_DB=libsql://<db>.turso.io MQLITE_TEST_DB_AUTH_TOKEN=<jwt> \
  MQLITE_TEST_DB_RESET_CONFIRM=1 \
  go test ./engine -run TestTurso -v
```

未设置 `MQLITE_TEST_DB` 时，真实远程测试会跳过；隔离环境中的分类规则测试始终运行。
