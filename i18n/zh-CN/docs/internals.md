# mqlite 的工作原理：在一个 SQLite 文件上构建可靠队列

本文跟随 `main`，包含尚未发布的改动。使用已安装的 v0.4.2 发行版时，请阅读[该标签对应的内部原理](https://github.com/mqlitehq/mqlite/blob/v0.4.2/docs/internals.md)；待发布的行为变化见 [CHANGELOG.md](../CHANGELOG.md#unreleased)。

> 这是一份原理讲解：逐表、逐项决策说明 mqlite 的实际构造，以及这种构造*为什么*能支撑可信赖的队列。使用 mqlite 不必先读本文，但它有助于预测系统行为。配套阅读：[concepts.md](concepts.md) 从外部介绍模型；[conformance.md](conformance.md) 以测试固定下文的每项承诺。

---

## 1 · 基本判断：队列由数据行与约束规则构成

将任何消息队列还原到基本结构，都会看到三个要素：

1. 一个消息的**持久化列表**；
2. 一个**领取**（claim）操作，同一时刻只把一条消息交给一个消费者；
3. **失败处理规则**：消费者再也不回来时，系统如何处理。

Kafka 用复制日志实现这些要素，RabbitMQ 用具备自有存储引擎的定制 broker 实现。mqlite 的判断是，对后台任务、事务发件箱、扇出、流水线等大量工作负载，这三个要素都可以放进一个已有可靠基础的组件：**具有 ACID 事务的 SQLite 数据库**。

一条消息是一行记录，一种状态是一个列值，一次转换是由 `WHERE` 条件保护的 `UPDATE`；在事务内，这相当于原子的比较并交换（compare-and-swap）。只要 schema 和转换规则正确，可靠性就不再依赖复杂巧妙的代码，而是建立在**数据库不变量**上。

下文按这些不变量逐步发挥作用的顺序展开。

## 2 · Schema：八张表，其中一张承载核心数据

全部数据存放在八张 `STRICT` 表中（`engine/schema.go`）。七张承载运行机制，一张承载用户数据：

| 表 | 职责 |
|---|---|
| `messages` | **队列本身**，包含每条消息及其所有状态 |
| `queues` | 各队列配置，持久化的 `active` / `deleting` 生命周期状态、删除开始时间，以及订阅的固定绝对到期时间 |
| `subscriptions` | 主题扇出清单：`topic → subscription` 与可选过滤器 |
| `dedup` | 重复检测窗口 |
| `settlement_receipts` | 使结算确认具有幂等性，第 7 节详述 |
| `receive_attempts` | 使接收重放具有幂等性，第 7 节详述 |
| `meta` | 一行 schema 保护令牌，第 9 节详述 |
| `access_keys` | SHA-256 令牌摘要、权限集、到期与撤销元数据，v0.3.1 引入 |

核心表的简化定义：

```sql
CREATE TABLE messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- SQLite rowid = the sequence number
    queue          TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'active'
                       CHECK (state IN ('active','locked','deferred',
                                        'scheduled','completed','dead_lettered')),
    visible_at     INTEGER NOT NULL DEFAULT 0,   -- delivery time (epoch ms)
    locked_until   INTEGER NOT NULL DEFAULT 0,   -- lock lease expiry
    lock_token     TEXT,                         -- the fencing token (§4)
    delivery_count INTEGER NOT NULL DEFAULT 0,
    expires_at     INTEGER NOT NULL DEFAULT 0,   -- TTL deadline; 0 = none
    body           BLOB NOT NULL,
    -- ... message_id, group_id, subject, properties, dead_letter_reason ...
) STRICT;
```

表中有四项有意设计：

- **`id INTEGER PRIMARY KEY AUTOINCREMENT` 就是 SQLite 的 rowid**：严格递增，即使记录删除也绝不复用，允许有间隙。仅这一列就为 mqlite 提供序列号、FIFO 顺序，以及它能使用的最快索引，无需额外结构。
- **状态是数据，不是内存对象。** 消息“已锁定”体现为行中的值，而非 broker 对象或 TCP 连接。随时终止进程，队列的确切状态仍保留在文件中；恢复过程（第 6 节）依赖 `SELECT`，而非重新推导状态。
- **队列退役由带索引的父记录保护机制约束。** 每次受支持的消息插入，都会先在同一事务中解析一个有效的 `queues` 行。更新队列键也要求父记录存在；仍有任何消息时，父记录不能重命名或删除。父记录保护为每个队列前缀局部索引分别执行一个明确状态探测。常规外键若没有额外的完整 `(queue, id)` 索引，就会在每次删除父记录时扫描整个 `messages` 表；增加该索引则使每条消息承担重复索引成本。逐次插入触发器同样会给每次 Send 增加开销。直接写入 mqlite 自有表不属于受支持的 `EngineTx.SQL` 契约。订阅引用仍使用原生外键，并具有子键索引。
- **每个时间戳都以 epoch 毫秒存入普通 `INTEGER` 列**，且时钟可注入；因此测试中的失败路径可以确定性执行，无需依靠 `sleep()`。

## 3 · 单写入者模型：通过减少并发交错控制并发

这是其余设计共同依赖的决定。SQLite 同一时刻只允许一个写入者；多数系统试图绕开它，mqlite 则**以它为基础**：

- **进程内写入连接池大小为一**（`SetMaxOpenConns(1)`）。`database/sql` 将每次变更排入该连接，因而*所有写入在进入 SQLite 前就已串行化*。没有写锁争用，无需 `SQLITE_BUSY` 重试循环，也无需分析写入交错。两个 goroutine 不可能各自领取同一消息的一部分，因为语句不能重叠执行。
- **跨进程时，建议性文件锁直接拒绝第二个所有者。** 嵌入式本地文件还会对 `<db>.lock` 辅助文件加操作系统锁，键取自*规范化*路径，因此 `./mq.db` 和指向它的符号链接会冲突。第二个进程打开同一文件时立即返回 `ErrDBLocked`，而不是破坏领取语义。需要多进程访问时应运行 broker，一个 broker 就是唯一写入者。
- **文件使用 WAL 模式**，因此在文件层面，读取者不会阻塞写入者，也不会看到撕裂状态。监控探针、实时的单队列 `Stats` 和全局观测刷新使用另一个 `mode=ro` 加 `query_only` 的连接；全局队列指标共享约 10 秒的快照，并合并并发刷新。普通引擎读取和全部变更保留既有的写入连接顺序。内存引擎无法共享该读取连接，仍使用唯一连接。默认耐久性设置为 `synchronous=NORMAL`；当每次提交一次 fsync 值得付出本地吞吐量约 4–11 倍的代价时，可选择 `FULL`（`MQLITE_SYNC`）。远程 Turso 忽略此设置，其耐久性由服务端负责。
- **远程 Turso/libSQL** 保留四连接池用于读取，并在变更尝试获取连接之前进行单写入准入。续锁工作按 FIFO 排队，以有界优先级先于结算执行；结算相对其他写入也只有有界优先级，以保证维护工作取得进展。许可持续到提交或回滚结束、SQL 连接租借归还后，再于重试退避前释放。这也是唯一会重试瞬时错误的路径。本地失败语句未产生执行效果，没有需要重试的内容。对于 HTTP Hrana（`libsql://`），一个逻辑驱动连接只维持一次 `database/sql` 连接租借，或一个完整事务，结束后即丢弃；Go 的共享 HTTP transport 仍会复用底层 TCP/TLS 连接。WebSocket transport 保留有界连接池，本地 SQLite 路径保持不变。

## 4 · 领取：Peek-Lock 是一条原子 UPDATE

消费者请求工作这一热路径只需一条语句，以下为 `engine/claim.go` 的简化形式：

```sql
UPDATE messages
   SET state = 'locked',
       locked_until   = :now + :lock_duration,
       lock_token     = :random_128_bit_token,
       delivery_count = delivery_count + 1
 WHERE id = (
       SELECT m.id FROM messages m
        WHERE m.queue = :queue AND m.state = 'active'
          AND m.visible_at <= :now
          AND (m.expires_at = 0 OR m.expires_at > :now)
          -- head-of-line probes for grouped messages (§5) go here
        ORDER BY m.id ASC
        LIMIT 1)
RETURNING id, body, delivery_count, ...;
```

一条语句完成三项工作：

1. **选择**符合条件的队首，即最早的 `active` 消息，已经可见且未过期。
2. **领取**它：切换为 `locked`，写入租约和令牌，并计入一次尝试。
3. 向调用方**返回**完整消息。

单写入者原子执行此操作，因此“选择后领取”不会发生竞争：谁的 UPDATE 先执行，谁就获得这一行，下一次操作获得下一行。批量 `Receive` 在**一个事务内**循环执行此操作，整个批次只需一次提交和一次 fsync。仅这项改动就曾使1 vCPU broker 的持续排空吞吐量从 591 提高到 1,507 msg/s。

`ReceiveDeferred` 使用独立的按序号领取路径，但同样在将 `deferred → locked` 的 UPDATE 中增加 `delivery_count`。它目前没有 `max_delivery_count` 条件：最大次数在失败锁被 Abandon、回收或恢复时执行，不作为显式暂缓消息恢复的领取准入检查。结算、续锁和调度器都不会增加计数。

**锁由租约与隔离令牌（fencing token）组成。** `locked_until` 是时间戳，不是连接，也不是心跳，因此消费者失效后，其锁会自然*过期*。`lock_token` 是只交给领取者的 128 位随机值，每次结算确认都必须出示：

```sql
DELETE FROM messages
WHERE id = :seq AND queue = :q AND lock_token = :token
  AND state = 'locked' AND locked_until > :now;
```

当前令牌和未过期租约缺一不可。到达截止时间的相等边界就已过期，包括后台 reaper 尚未执行时。broker 在本地写入准入之后采样时间，并在每条结算语句及每次远程重试时重新采样。过期消费者发起的新结算影响零行，并返回 `lock_lost`。消息重投后，改变的令牌还会隔离前一个所有者。`Renew` 和 `RenewBatch` 要求同一有效租约，绝不恢复已过期租约；令牌、状态和 `delivery_count` 都保持不变。没有固定到期时间的队列或订阅采用 `locked_until = MAX(locked_until, broker_now + lock_duration)`，候选值受固定订阅存续期限制。因此，续锁不会缩短租约，快速重复调用也不会累加时长。有效的精确请求回执可重放已经提交的结算，见第 7 节。

租约仅表示一次尝试的所有权窗口。消息 TTL 是独立的正常投递截止时间，消息在锁定期间也可能到期；默认到期进入死信，仅配置为丢弃时才删除记录。队列默认 TTL 同时也是显式消息 TTL 的上限。有效 TTL 锚定在消息最初的 `visible_at`，因此等待定时投递不消耗 TTL，带延迟的 Abandon 也不重新开始计时。订阅存续期是资源级截止时间，限制每次租约，并最终移除支撑队列。续锁不会延长后两者中的任何一个。

接收即删除（receive-and-delete）在同一事务中删除领取的记录，不授予租约：创建响应或 attempt 记录前，会清空令牌和截止时间。因此，SDK 在此模式返回零值的 `LockedUntil` 时间。

## 5 · 保持性能：局部索引与一次 O(n²) 故障

领取操作必须找到“最早的活动消息”，而不受周围锁定、定时或死信记录数量影响。使用的工具是 SQLite 的**局部索引（partial index）**：

```sql
CREATE INDEX idx_msg_active ON messages(queue, id) WHERE state = 'active';
```

索引中只有 active 行，且已按 `(queue, id)` 排序。因此，领取中的内部 SELECT 只需一次索引查找，复杂度为 O(log n)，即使某个锁后积压了 200k 行也如此。各后台扫描同样有专属局部索引：按过期时间查锁定记录，按到期时间查定时消息，按队列查 DLQ，按截止时间查 TTL。

促成这一设计的故障（MQLITE-22）：FIFO 模式中的分组消息，以及 `standard` 队列中带 `group_id` 的消息，还必须检查同组是否有*更早*的消息仍在处理中，即队首探测。
直观写法是一个大的 `NOT EXISTS (... WHERE ((b.state='locked' AND
b.locked_until > :now) OR b.state IN ('deferred','scheduled')) AND b.id < m.id)`，但 SQLite 规划器无法将 `OR`/`IN` 混合条件匹配到任何局部索引，退回到**反向 rowid 扫描**：每个候选 O(n)，排空被阻塞积压时达到 O(n²)。在有 49k 条消息的队列上，*每次领取*需要 1.29 秒。看清原因后，修复方式很直接：**每种状态一个 `EXISTS`**，每个都使用规划器可匹配局部索引的单一 `state = '...'` 等值条件：

```sql
   ... AND NOT (
       EXISTS (SELECT 1 FROM messages b WHERE b.queue=m.queue
                 AND b.group_id=m.group_id AND b.state='deferred'  AND b.id<m.id)
    OR EXISTS (... b.state='scheduled' ...)
    OR EXISTS (... b.state='locked'    ...))
```

逻辑相同，性能却快了三个数量级：在 20k 条阻塞消息的积压上，每次领取从 29.7 秒降至 24 毫秒。自 v0.2.0 起，`locked` 探测有意忽略租约是否过期，因此消费者崩溃后，其分组仍*保持顺序*，由 reaper 首先重投队首，而不会让后继消息越过它。

mqlite 从中获得的更重要经验是：**查询计划属于行为，因此必须测试**。`TestClaimPlanPinning` 在 CI 中运行 `EXPLAIN QUERY PLAN`；领取不再查找 `idx_msg_active`，或任何探测被规划为扫描时，测试就失败。O(n²) 问题不能悄然回归。

## 6 · 将失败视为正常路径

以上设计都假定故障会不断发生。吸收故障的机制有意保持小而常规：

**后台循环**全部通过同一个连接写入：

| 循环 | 频率 | 工作 |
|---|---|---|
| 生命周期 | 事件驱动；完整空订阅批次后等待 10 ms，其他续清理批次间隔 1 s | 继续对已持久标为 `deleting` 的队列及订阅支撑队列执行有界物理清理 |
| 订阅到期 | 每 1 s 发现到期项；完整到期批次之间间隔 10 ms | 通过索引转换一批达到固定绝对截止时间的记录；数据平面隔离不等待此扫描 |
| reaper | 1 s | 过期锁移回 `active`；`delivery_count ≥ max` 时进入 DLQ |
| scheduler | 1 s | 到期的 `scheduled` 行移为 `active`；`delivery_count` 不变 |
| TTL 扫描 | 10 s | *所有*非终态中的过期消息移入 DLQ，或按配置丢弃 |
| janitors | 60 s | 删除旧回执和去重条目；本地空闲页累计达到 256 页后，每次最多回收 256 页 |

**资源删除是持久化状态机。** 仅空资源可删除的队列/订阅删除操作，会在将支撑 `queues.lifecycle_state` 从 `active` 改为 `deleting` 的同一事务中检查所有消息状态；force 跳过空检查，因为调用方已明确授权丢弃。该事务也启动有界物理清理。清理完成时，同一次提交移除资源，不会出现可观测的中间 `deleting` 状态；否则提交该标记，使缓存配置失效、唤醒 long-poll、拒绝后续队列工作，并继续占用命名空间。订阅在该次提交中停止参与扇出。后续清理轮次先删除消息、去重记录及两张回执表中的记录，再删除队列行；订阅映射和支撑队列在同一事务中显式删除。

临时订阅在首次创建时保存一个 `queues.expires_at`。每次操作都在事务产生效果时，使用新的 broker 时间检查；相等即过期。锁被限制在该时刻之前，long-poll 也在此时唤醒。带索引的到期循环会将到期行持久标记为 `deleting`，但它是清理机制，并非正确性隔离本身。到期时间就是已保存的 force 授权，不会随重试、过滤器更新或消息活动改变。

接受删除的前台调用最多删除 1,000 行物理记录，目标字节预算约为 8 MiB。每轮生命周期清理在全局最多处理 4,096 行，目标字节预算同为约 8 MiB。普通逐资源路径在本地最多访问 32 个支撑队列，在远程 Turso/libSQL 最多访问一个；远程上限用于限制单个写事务内的 Hrana 往返，持久化游标则提供公平轮转。`Open` 在锁恢复之前执行一轮，因此该标记既是重启游标，也是 force 授权；崩溃不能使队列重新激活，也不要求运维人员再次授权丢弃。为保证进展，单个超大行允许超过字节目标。已接受而未完成的删除会唤醒工作循环，突发请求合并为一个信号。完整的 512 个空订阅快速批次在 10 ms 后继续；其他未完成轮次在一秒后继续。没有正在删除的资源时，工作循环不启动事务，避免远程存储上的空闲轮询往返。唯一例外是远程删除或清理事务的提交回执不确定：立即执行一轮后，工作循环再以一秒间隔执行 30 次延迟探测，从而发现第一次清单快照之后才变为可见的提交。此窗口结束后，重启恢复仍是持久化后备机制。普通资源扫描前，另一个集合式路径优先处理常见的空资源场景：一次事务最多删除 512 个订阅映射及其支撑队列，不占用普通路径本地 32 个/远程 1 个的资源数量额度。每个订阅的这两行仍消耗共享的 4,096 行预算。准确的受影响行数检查确保即使关闭外键也安全。有任何保留状态的订阅，仍走普通的公平行数/字节预算路径。

**启动租约恢复只需一条语句。** Open 保留 `locked_until` 仍在未来的记录，因为新进程无法证明远程或进程外处理函数已不再持有该持久化隔离令牌。默认仅回收有效资源上的过期记录。单进程嵌入式所有者若已知所有先前处理函数均已结束，可显式回收仍有效的租约。资源生命周期和消息 TTL 仍具有最终约束力。每个回收行返回 `active`；如果已使用最后一次允许尝试，则直接进入死信状态。规则与 reaper 相同，保留有效尝试不会增加 `delivery_count`。

**普通重试上限由持久化数据保证。** `delivery_count` 在领取 UPDATE 内部、*领取时*就增加，因此任何失败模式都不会丢失计数。到达最大次数不会中断当前领取：`max_delivery_count=10` 时，第 10 次普通 Peek-Lock 领取是完整的最后尝试，可反复续锁并完成。如果被 Abandon、锁过期，或嵌入式所有者显式回收仍有效租约，该转换会看到 `delivery_count >= max_delivery_count`，进而移入 `state='dead_lettered'`，而不是允许第 11 次普通 Peek-Lock 领取。默认启动保留最后尝试至截止时间，到期后适用同一转换。
`ReceiveDeferred` 是第 4 节所述的明确例外：增加计数，但不做最大次数准入检查。DLQ 不是另一条队列，而是一个可 `Peek`、`Redrive`（回到 active 并重置计数）或 `Purge` 的状态；它有年龄、数量和字节保留限制，避免无人管理的 broker 无限增长。

## 7 · 明确的至少一次交付与两张回执表

跨崩溃的恰好一次交付无法仅靠承诺实现：崩溃后，“断电前回执是否已到达”可能无法判断，因此必须有人重试，也就可能有人再次看到同一消息。mqlite 明确承认这一点：**默认 Peek-Lock 采用至少一次交付，处理函数必须幂等**，再尽力缩小*不确定窗口*并使*重试安全*：

- **`settlement_receipts`**：结算（Complete/Abandon/Reject/Defer）成功时，*同一事务*为该*请求*写入回执，自记录起逻辑有效期 30 分钟，重放不延长有效期。资源删除或固定订阅到期可能提前终止重放。若客户端丢失响应并在窗口内重试，结算即使匹配零行，也能找到未过期回执并返回成功，而非误报 `lock_lost`。因此确认重试具有幂等性。

  回执以完整请求为键：`queue`、`seq_number`、`lock_token`、`operation`，以及改变结算*效果*的参数，如 Abandon 的延迟、Reject 的原因/描述，因为重放必须是同一个请求。若键过于宽松，回执就会为未发生的调用背书：令牌为另一条消息背书，Abandon 为 Complete 背书，或退避时间已改变却被报告为已应用。这些都是虚假成功，至少一次语义不允许如此。任一字段不同，调用都会得到 `lock_lost`。到期检查使用语句执行时的新时间；仅因尚未到下一轮 janitor 而物理保留的回执不能用于重放。有效回执可在原租约过期后重放原效果，但不能授予新效果或续延已过期租约。
- **`receive_attempts`**：客户端可为 `Receive` 标记一个 `attempt_id`，领取批次在同一事务中记录到该 id 下。Peek-Lock 只保存有序的序号/令牌/截止时间清单，再从锁定行重建不可变消息字段，并通过一次查询校验整个批次，避免在重放表中重复存储每条有效消息的正文。只有记录尚未到期，且每个令牌仍持有有效租约，重试才能重放完全相同的消息与锁令牌。若显式嵌入式有效租约回收、启动时过期租约恢复、普通租约过期或结算使任何令牌失效，同一事务会删除过时响应并安全地重新领取；调用方绝不会得到过时或仅部分拥有的批次。不带令牌的 ReceiveAndDelete 保留完整响应，因为消息行已经删除。两种模式的记录保留期都是记录时“五分钟与队列锁时长的较大值”，并受固定订阅到期限制。重放和续锁都不延长记录截止时间。记录到期后，即使原令牌经续锁仍有效，同一个 ID 也可能领取新的工作。
  托管的本地和远程接收器都保留 AttemptID 重放；即使是进程内的数据库提交，也可能返回不确定结果。
- **`dedup`**：在生产端，队列去重窗口内的 `message_id` 会使重发合并到原行；没有 id 时，使用正文的 SHA-256 作为内容寻址键。同一 id 携带*不同*正文会明确冲突，绝不悄然覆盖：单条发送得到 `409`；批量发送跳过冲突项，返回序号 `0`，其余项提交。去重默认关闭。启用后，窗口从该键最后一次新入队开始计算，重复发送不会刷新窗口，完成消息也不会删除去重身份。冲突检查只覆盖正文字节，不比较元数据、TTL 或计划时间，因此重复发送不会更新原消息。

可以看到共同模式：每种幂等机制都是**在所保护操作的同一事务内写入一张小表**。不依赖超时后的猜测，也不需要分布式协调；ACID 事务本身就是协调机制。

## 8 · 收益：队列与业务共用同一个事务

队列本身是 SQLite 数据库，因此嵌入式模式能提供外部 broker 无法加入的事务能力：

```go
err := mq.Tx(ctx, func(tx *engine.EngineTx) error {
    // tx.Context(), not the outer ctx: on a local store an interrupted statement
    // inside the transaction leaks the connection and wedges the database.
    if _, err := tx.SQL().ExecContext(tx.Context(),
        `INSERT INTO orders(id, total) VALUES(?, ?)`, 42, 1999); err != nil {
        return err            // rollback: no order, no event
    }
    _, err := tx.SendOne("order-events",
        engine.OutMessage{Body: []byte(`{"order":42}`)})
    return err                // commit: order AND event, atomically
})
```

业务表与 `messages` 表位于同一文件，一个 `*sql.Tx` 同时覆盖二者。“业务记录已提交，但事件没有入队”的双写问题并非仅得到缓解，而是**在这一事务内无法形成**。这就是无需 outbox 表、轮询器或 CDC 流水线的事务发件箱模式。

本地存储中的 `tx.Context()` 保护 SQL，避免语句执行中途被中断。原始 `tx.SQL()` 调用绕过 mqlite 的逐语句取消保护，因此应在业务语句之间检查原始 `ctx.Err()`，取消后立即返回。提交前观察到取消，会回滚业务写入和入队，即使回调返回 nil；但它无法强行停止一个持续运行的回调。见[取消契约](conformance.md#13--cancellation-context-deadlines)。

## 9 · 如何维持这些保证

本文的每项承诺都有明确失败的检查机制：

- **一致性测试集**（[conformance.md](conformance.md)）：令牌隔离、跨锁过期的顺序、恢复边界、幂等重放、命名空间互斥等不变量各自引用固定其行为的隔离测试；CI 在三种操作系统上启用 race detector 执行。
- **查询计划固定测试**：对 `EXPLAIN QUERY PLAN` 输出作断言，使性能特征成为防回归契约，而非期望，见第 5 节。
- **Schema 黄金测试**：固定完整规范 DDL。保护令牌不匹配的数据库会被拒绝（`ErrSchemaVersionMismatch`），绝不迁移已有表布局；不兼容改动必须更换令牌。一项范围严格受限的兼容修复，会在同一事务内将两个已识别的旧消息父项触发器替换为等价的索引化谓词，使其也能在基于 Rust 的 Turso 上编译。发现未知触发器定义时，Open 会在执行 DDL 前拒绝打开；该修复不改变消息数据或 schema 令牌。独立的 `access_keys` 增加最初保留令牌 5，并持续属于规范 schema，其 DDL 另有黄金测试。持久化资源生命周期与固定订阅到期使当前规范 schema 升至令牌 7；真实 schema-5 文件及中间 schema-6 文件在升级和回退两个方向都被拒绝。
- **完整性扫描**：随机发送、接收、崩溃工作负载断言每条消息到达（无缺失）、正文完整（内容哈希），且不超过投递次数上限。
- **崩溃注入层**：真实 worker 在事务中途被强杀（`SIGKILL`）后重启，验证发件箱跨崩溃仍保持原子性，以及测试程序已收到确认的每次生产端提交均能保留。崩溃 worker 使用嵌入式恢复，将孤儿锁移回 active，或在投递次数耗尽时移入 DLQ。它重新执行测试二进制，因此位于 `crash_injection` 构建标签之后，由 Linux 独立 CI 任务运行：启用 race detector 的 `make crash`，与默认包矩阵分开执行。这测试的是*进程*终止，不是断电。

## 10 · 设计的明确边界

带来可靠性的同一组选择也决定了上限，项目应明确说明：

- **单写入者、单节点。** 不提供集群、故障切换副本或横向写扩展。（远程 Turso 增加存储层耐久性和地理复制。一次[历史同地域对照](https://github.com/mqlitehq/mqlite/pull/67)测得单条持久化 `Send` 的 p50 约 45 ms；规划容量前应重新测量当前版本、数据库和地域。它提供的是安全性，而非更高速度。）
- **写放大是存储结构的代价。** 单条 256 字节发送约产生 9.7 KB 的 WAL 与索引写入，批量发送可摊薄至约 1 KB。这是 SQLite B-tree 特征带来的批处理收益，应尽量批量操作。
- **不是流式日志。** 完成的消息会删除，不保留用于回放；针对历史记录的消费组应由 Kafka 一类系统承担。

如果需求落在这些边界内：单节点、每秒数千条、结果必须可信，那么队列下的整个栈就是一个约 30 MB 的进程、一份 SQLite 数据库，以及一组可通过 `go test` 再次验证的承诺。停止时应复制完整 DB/WAL/SHM 集合；在线热备份使用只读 `VACUUM INTO`，见[运维手册](operations.md#consistent-backups)。

## 11 · 附录：替换引擎时，新存储必须满足的契约

这些能力一定要依赖 SQLite 吗？不是。引擎需要一组**保证**，不依赖某个品牌；SQLite 只是能在一个纯 Go 文件体系中提供全部保证的实现。如果要将 mqlite 移植到另一个数据库、嵌入式 KV 存储或自建引擎，以下就是该存储必须满足的契约。每项都对应依赖它的前文章节。

**八项核心保证：**

| # | 存储必须提供 | 原因 |
|---|---|---|
| G1 | **持久化、有序入队**，序列号严格递增且永不复用 | 第 2 节：seq 同时是排序锚点和结算句柄 |
| G2 | **原子领取**：选择符合条件的队首并加锁，作为不可分割操作；两个消费者不可能同时获得同一消息 | 第 4 节：领取 UPDATE |
| G3 | 深积压中的**逐状态有序查找，复杂度 O(log n)**：队列 Q 最早的活动消息、过期锁、到期定时消息，以及逐组查找 | 第 5 节：局部索引 |
| G4 | **辅助查找**：按消息 id 去重、DLQ 扫描、按截止时间判断到期 | 第 6–7 节 |
| G5 | **多行 ACID 事务**，且*应用可以将自己的表加入同一事务* | 第 7 节回执，第 8 节发件箱 |
| G6 | **仅从数据恢复崩溃状态**：`kill -9` 后，已提交状态完整一致；锁必须是数据行而非内存对象 | 第 2、6 节 |
| G7 | **范围删除与空间回收**：保留清理和 purge 必须归还磁盘空间，而非仅写墓碑 | 第 6 节 |
| G8 | **可嵌入**：进程内、无 CGO、无 sidecar，理想情况下是一份可复制的文件 | 整个设计目标 |

**正文细节还隐含四项保证**，容易忽略，却不能省略：

- **条件写入（CAS）。** 每个新结算要求当前令牌、锁定行和 `locked_until > now`，见第 4 节。存储需要原子的按字段比较后更新，否则令牌隔离失效，过期消费者就可能确认属于他人的投递。
- **领取路径的串行化保证。** mqlite 将所有写入汇入一个连接以获得原子性，见第 3 节。替代存储要么遵循同样的单写入者约束，要么提供真正可串行化事务；可能发生写偏差的快照隔离，*不足以*保证“恰好一个领取者胜出”。
- **辅助写入属于同一事务。** 第 7 节的幂等回执成立，是因为回执与所保护操作*原子提交*。不能将回执放入同一次提交的存储，只能提供“通常幂等”，而非幂等保证。
- **可调耐久性设置**，对应第 3 节 `NORMAL`/`FULL`，以及**跨进程保护**，对应第 3 节建议性文件锁；或为各项提供有文档说明的等价机制。

**已有迁移测试集可复用。** [一致性 TCK](conformance.md) 面向行为编写，而非面向 SQLite；启用 race detector 后通过它的存储，证明了 G1–G7。有两类测试*不能*直接移植，必须为每个引擎重做：查询计划固定测试，第 5 节的 `EXPLAIN QUERY PLAN` 断言采用 SQLite 方言，替代引擎必须提供等价性能约束，否则 O(n²) 一类问题可能悄然重现；以及 schema 黄金测试，需要固定替代引擎自己的布局产物。

**常见替代项如何满足这些要求：**

- **另一个嵌入式 SQL 数据库**：结构上可满足全部要求；主要工作是移植 SQL 方言和性能固定测试。
- **嵌入式 KV/LSM 存储**，如 bbolt、Badger、Pebble：G1/G2/G6 没有问题，但 G3/G4 意味着必须手工构造 schema 原本直接提供的每一个索引；G5 的后半部分无法满足，应用不能把*自己的*表放进*这些存储*的事务，因此**事务发件箱这一核心特性会丢失**。LSM 引擎中的 G7 空间回收也需谨慎处理。
- **外部存储**，如 Redis、托管 Postgres 或 broker：可能满足 G1–G7，但不满足 G8，同时失去同库事务发件箱和“一份可以 `cp` 的文件”这一运维形态。此时，Postgres 原生队列（pgmq、River）更合适。
- **自建日志/BTree**：以上全部保证都需要自行实现，包括只有在 `kill -9` 下才会发现的保证。结果是为了省掉最容易的 80%，重写 SQLite 最困难的 20%。

这就是 mqlite 目前采用 SQLite 的原因：对六个候选进行加权评估时，它是唯一满足八项保证的方案，同时独有地提供共享事务发件箱与 Turso 远程存储这两个差异点。引擎通过狭窄的存储边界保持替换可能，边界包括入队、领取、结算、恢复和事务内操作；但替代实现必须满足本附录，并由一致性测试集判定。

---

*想从外部理解模型？请读 [concepts.md](concepts.md)。线协议细节见 [api-reference.md](api-reference.md)。性能论据对应的测量记录见 [benchmark.md](benchmark.md)。*
