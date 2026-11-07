# 核心概念与订阅过滤器

本文跟随 `main`，包含尚未发布的改动。使用已安装的 v0.4.2 发行版时，请阅读[该标签对应的核心概念](https://github.com/mqlitehq/mqlite/blob/v0.4.2/docs/concepts.md)；待发布的行为变化见 [CHANGELOG.md](../CHANGELOG.md#unreleased)。

> 目标：清晰、完整地说明 MQLite 模型，并与 Azure Service Bus、AWS（SQS + SNS）和 GCP Pub/Sub 的相应服务对照。MQLite 从基本原则出发设计，强调单个 SQLite 文件、可嵌入和对智能体友好；在概念上最接近 Azure Service Bus，因此以 ASB 为主要参照，并在重要之处明确差异。第 1–5 节介绍模型，第 6–11 节介绍**订阅过滤器语言**（`expr`）。

---

## 1. 用一张图理解全貌

```
  ┌──────────────────────────── two delivery targets ─────────────────────────┐
  │                                                                            │
  │   A) send straight to a Queue        B) publish to a Topic, fan out        │
  │                                                                            │
  │   producer                           producer                              │
  │      │ send "orders"                    │ publish "events"                 │
  │      ▼                                  ▼                                   │
  │   ┌────────────┐                ┌──── topic "events" ────┐                 │
  │   │ queue      │                │ (just a set of subs;   │                 │
  │   │  orders    │                │  stores nothing itself)│                 │
  │   │ ┌────────┐ │                └─┬─────────┬──────────┬─┘                 │
  │   │ │ active │ │       filter match│  match  │  no match│                  │
  │   │ ├────────┤ │                  ▼         ▼          ✗ (no copy)         │
  │   │ │ locked │ │            sub "audit"  sub "billing"                     │
  │   │ ├────────┤ │            ┌────────┐   ┌────────┐                        │
  │   │ │  DLQ   │ │            │backing │   │backing │  ← each subscription   │
  │   │ └────────┘ │            │ queue  │   │ queue  │    is an independent   │
  │   └────────────┘            └────────┘   └────────┘    queue (+ own DLQ)   │
  │      consumer                  consumer     consumer                       │
  └────────────────────────────────────────────────────────────────────────────┘
```

记住一句话：**主题（Topic）本身不存储消息，它只是路由规则，将消息复制到若干订阅队列。真正存储消息、供消费者读取并容纳死信的始终是队列（Queue）**，包括订阅背后的支撑队列（backing queue）。

---

## 2. 五个概念

### 队列（Queue）
队列是有名称的消息容器，也是唯一真正存储消息的实体。消息遵循以下状态机；一行记录在任一时刻恰好处于一种状态。图中的 `count` = `delivery_count`，`max` = 队列的 `max_delivery_count`，`✗ removed` 表示记录已从数据库删除：

```
                   ┌───────────┐
  Send(scheduled)  │ scheduled │   scheduler, when due ─► active
  ───────────────► └─────┬─────┘   cancel ─► ✗ removed (never-delivered only)
  Abandon(delay_ms>0) ───┘  (backoff parking: holds its group on ordered queues)
                         │
                         ▼
  Send             ┌──────────┐ ◄── requeue: immediate abandon / lock expiry, count < max
  ───────────────► │  active  │ ◄── redrive: from dead_lettered (count → 0)
                   └────┬─────┘
                        │ receive / claim (count++)
                        ▼
                   ┌──────────┐ ──── defer ──────► ┌──────────┐
                   │  locked  │ ◄─ ReceiveDeferred  │ deferred │
                   └────┬─────┘    (by seq)         └──────────┘
                        │ complete ─► ✗ removed
                        │ renew ─► (same attempt; count unchanged)
                        │ reject, or abandon / lock-expiry, count ≥ max:
                        ▼
                   ┌───────────────┐ ◄── TTL expiry (active/locked/deferred/scheduled;
                   │ dead_lettered │      ✗ removed if dead_letter_on_expire = 0)
                   └───────┬───────┘
                           │ purge / DLQ retention ─► ✗ removed
```

以下逐项列出所有状态转换、触发方式及生效条件：

| 原状态 | 触发条件 | 新状态 | 生效时机 |
|---|---|---|---|
| _（新消息）_ | `Send` | active | 立即可投递 |
| _（新消息）_ | 定时 `Send` | scheduled | 入队时间在未来 |
| scheduled | 调度循环 | active | 到达入队时间；`count` 不变 |
| scheduled | `Cancel` | ✗ removed | 激活前取消；仅适用于从未投递的记录（`delivery_count=0`） |
| active | `Receive` / 领取 | locked | `count`++；取得锁 |
| locked | `Complete` | ✗ removed | `lock_token` 匹配且租约未过期 |
| locked | `Abandon` | active | `count < max`，没有退避延迟（立即重投）；`count` 不变 |
| locked | `Abandon` | scheduled | `count < max` 且 `delay_ms > 0`：暂存以等待重试退避，到期自动重新激活；在有序队列中持续占据所属组的队首；`count` 不变 |
| locked | `Abandon` | dead_lettered | `count ≥ max`；`count` 不变 |
| locked | 锁过期（reaper 回收） | active | `count < max`；自动重投 |
| locked | 锁过期（reaper 回收） | dead_lettered | `count ≥ max`（`MaxDeliveryCountExceeded`） |
| locked | `Reject` | dead_lettered | 显式拒绝，并附原因 |
| locked | `Defer` | deferred | 暂缓处理，之后按序号取回 |
| locked | `Renew` / `RenewBatch` | locked | 延长同一有效租约，不增加 `count`；不能恢复已过期租约 |
| deferred | `ReceiveDeferred` | locked | 显式按序号取回；`count`++（目前不进行 `max` 领取准入检查） |
| active / locked / deferred / scheduled | TTL 到期 | dead_lettered | 队列设置了 `dead_letter_on_expire=1`（`TTLExpired`） |
| active / locked / deferred / scheduled | TTL 到期 | ✗ removed | 队列设置了 `dead_letter_on_expire=0`（丢弃） |
| dead_lettered | `Redrive` | active | 回到本队列或目标队列；`count` 重置为 0 |
| dead_lettered | `Purge` | ✗ removed | 手动删除 |
| dead_lettered | DLQ 保留策略 | ✗ removed | 异步后台清理以年龄、数量、字节数为目标，可能暂时滞后；**只**处理死信记录 |

- **`delivery_count` 统计领取次数，不统计续锁或退避。** 每次新授予的 `Receive` 或 `ReceiveDeferred` 领取会增加计数。`Renew`、`RenewBatch`、`Abandon`、锁过期和调度器都不会增加计数。设置 `max=10` 时，返回 `count=10` 的普通 Peek-Lock `Receive` 仍是一次完整的最后投递尝试：可以反复续延其有效租约，也可以 `Complete`。到达 10 本身不会移动记录。如果放弃这次尝试、租约过期，或嵌入式所有者显式回收仍有效的租约，记录会进入 DLQ，而不会获得第 11 次普通 Peek-Lock 尝试。默认启动会在租约仍有效时保留它；到期仍适用同一边界。显式 `ReceiveDeferred` 目前有所不同：它增加 `count`，但目前不会依据 `max` 拒绝领取，因此不能将配置的最大次数视为这条按序号恢复路径的领取准入限制。
- **DLQ 不是独立队列。** 它是同一队列中 `state='dead_lettered'` 的消息。失败的锁定尝试在 `delivery_count >= max_delivery_count` 时被放弃、回收或恢复，显式调用 `Reject`，或消息 TTL 到期且队列的 `dead_letter_on_expire=1`，都会使消息进入此状态。可用 `peek state=dead_lettered` 查看，用 `redrive` 移回，或用 `purge` 删除。
- **Redrive 的原子性限于内部数据操作。** 每个数据库批次要么完整移动，要么完全不移动；跨队列移动时，源记录删除与目标记录插入也属于同一批次。消费者对移回的消息仍采用至少一次交付，因此处理函数和外部副作用仍须保持幂等。
- **租约截止时间隔离每一次结算和续锁。** 产生新效果必须持有当前令牌，且满足 `locked_until_ms > now`；相等即已过期，即使 reaper 尚未执行。必须在该截止时间前续锁。对于没有固定到期时间的队列或订阅，提交后的截止时间为 `max(current deadline, broker now + lock_duration)`：续锁绝不缩短租约，但快速重复调用不会将时长逐次累加。订阅的固定存续期会限制候选截止时间。续锁保持相同令牌、状态和投递尝试，不能恢复已过期租约。有效回执（receipt）仅能重放同一队列、序号、令牌、操作及影响效果的参数所对应的已提交结算，包括原租约已过期后的重放。回执自记录起 30 分钟到期；重放不延长该截止时间，资源删除或固定订阅到期还可能提前终止重放。
- **租约、消息 TTL 和订阅存续期使用不同的时钟边界。** 租约暂时隔离一次投递尝试。消息 TTL 限制正常投递资格，消息在锁定期间也可能到期；默认到期进入 DLQ，而 `dead_letter_on_expire=false` 会丢弃记录。队列的正数默认 TTL 同时也是显式 Send TTL 的上限。有效消息 TTL 从最初的 `visible_at` 开始计算；对于定时 Send，这是计划投递时间。带延迟的 Abandon 不会重新开始计时。固定订阅存续期约束整个支撑队列，并限制其锁截止时间。`Renew` 只改变租约，不延长消息 TTL 或订阅存续期。
- **两条重投路径。** `Abandon` 是显式、由客户端发起的结算；**锁过期**则自动发生：reaper（约每 1 秒）回收超过 `lock_duration` 仍未结算的锁。二者在 `count < max` 时重投，在 `count ≥ max` 时进入死信。
- **带延迟的 Abandon 复用 `scheduled` 状态进行重试退避。** 它不会创建或计算另一次尝试。同一行在该状态等待到期，调度器再将它移回 `active`，不改变 `count`；下一次领取才增加计数。`Cancel` 有意只接受从未投递的定时发送（`delivery_count=0`），不接受由 Abandon 暂存等待重试的消息。
- **锁过期后仍保持顺序。** 在有序路径中（`group_fifo`、`strict_fifo`，以及 `standard` 队列中带分组的消息，它们共用同一领取规则），已过期但尚未被回收的锁仍阻塞所属组；严格模式下阻塞整个队列。后继消息绝不会越过已过期的队首先行投递。reaper 执行后，队首按 id 顺序首先重投；如果已耗尽 `max_delivery_count`，则立即成为死信，并解除对该组的阻塞。代价是消费者超时会使所属组额外停顿最多一个 reaper 周期（约 1 秒），SQS FIFO 也采用同一取舍。仍存活但处理较慢的消费者应 `Renew` 锁，而不是任其到期。显式 `Abandon` 会立即释放队首；指定 `delay_ms` 退避时，队首暂存于 `scheduled` 直到退避结束，并像定时发送一样持续阻塞所属组；严格模式下阻塞整个队列。它随后仍首先重投，因此退避期间也保持顺序（MQLITE-66）。
- 可拥有任意数量相互独立的普通队列。

### 主题（Topic）
主题是一个**逻辑名称**，代表“附属于该主题的订阅集合”。

- 主题**不是显式创建或存储的对象**：它存在，当且仅当 `subscriptions` 中存在 `topic=<name>` 的记录。**没有任何订阅的主题不存在。**
- 主题**不持有自己的消息**：没有收件箱、缓冲区或保留存储。

### 订阅（Subscription）
订阅是将主题绑定到支撑队列的关系，可附带一个过滤器（Filter）。

- 每个订阅拥有**独立的支撑队列**，独立消费、独立 `seq_number`s、独立 DLQ。
- 一个订阅恰好属于**一个**主题，由 `ErrNameConflict` 保护。
- “一个主题有多个队列”的准确含义是：**每个订阅拥有一个队列，主题通过这些订阅扇出消息。**

### 过滤器（Filter）
过滤器是订阅上的**单个 expr-lang 布尔表达式**，在发布时逐消息求值。

- 空表达式匹配所有消息。
- 例如 `subject_parts[0] == "orders" && properties["tier"] == "gold"`。
- 在 `Subscribe` 时编译并进行类型检查；无效表达式会被拒绝（`ErrInvalidFilter` → 400）。完整过滤器语言和表达式环境见下文第 6–11 节。

### 资源准备：需要显式创建什么，系统自动创建什么
| 实体 | 如何产生 | 原语 |
|---|---|---|
| 普通队列 | **显式创建**；向不存在的队列 `Send` 会报错，不会自动创建 | `CreateQueue(name)` |
| 主题 | **隐式存在**，没有创建调用；创建第一个订阅时出现，最后一个订阅移除后消失 | *（没有 `CreateTopic`）* |
| 订阅**及其支撑队列** | **一次调用共同创建**；`Subscribe` 自动准备支撑队列 | `Subscribe(topic, name, filter)` |

- **没有“创建主题”操作**，也**没有主题背后的同名队列**。支撑队列以**订阅**命名，而非以主题命名。
- 不需要预先创建队列再绑定订阅；一次 `Subscribe` 就会建立支撑队列和扇出映射。
- **命名空间是扁平的，并按设计保证不同类别互不重叠。** 普通队列名、订阅名（即支撑队列名）和主题名绝不重叠；创建时的双向冲突都会明确返回 `ErrNameConflict`（HTTP 409）：`Subscribe` 会拒绝以下情况：**主题名**已属于队列或订阅；**订阅名**已属于普通队列、其他主题的订阅或有效主题；以及 `topic == name` 的退化情况。`CreateQueue` 会拒绝当前作为主题使用的名称，也会拒绝**跨类型 upsert**（在订阅支撑队列上创建普通 `CreateQueue`，或以 `kind=subscription` 覆盖普通队列）；有意进行的同类型重配置仍然允许。（ASB 也是如此：队列和主题共享实体命名空间，同名创建会冲突，不会悄然改变发送路由。）这些保护及其创建事务共同维持此不变量。手工修改数据库造成队列/主题名称冲突，属于公开契约不支持的状态；对于这种无效内部状态，不规定路由行为。
- 在受支持的命名空间中，发布/发送时的名称解析没有歧义：有效普通队列或支撑队列的名称定位该队列；隐式主题名定位其有效订阅记录；其他名称返回 `ErrQueueNotFound`。借助 `errors.Is`，该哨兵错误同时匹配更宽泛的 `ErrNotFound`；嵌入式模式和支持资源类型标识的远程 broker 行为一致。有效名称绝不会同时是队列和主题，因此 `Send` 不会被悄然改道。

```
You only ever do two kinds of "create":
  CreateQueue(name)             -> one independent work queue (must exist before Send)
  Subscribe(topic, sub, filter) -> auto-creates backing queue=sub + attaches to topic
                                    (the topic comes into being as a side effect)
```

> 与 ASB 的区别：ASB 的主题和订阅都需要显式创建；MQLite 将“创建主题”设为隐式操作，将“创建订阅队列”设为自动操作，少了两个步骤。

### 资源名称、复用与请求/响应

队列和订阅名称是路由地址，不是不可变的生命周期 ID。`DeleteQueue` 作用于当前使用该名称的普通队列，默认只允许删除空队列；显式 force 授权丢弃所有保留状态的消息。因此，控制器必须串行执行删除和同名重建：停止旧队列的使用者，等待删除成功，确认 `ListQueues` 中已无该名称，然后才能创建替代队列。替代资源一旦存在，绝不能重放属于旧队列的请求。响应不确定时，应继续保留该名称的使用权，先完成核对再继续。这是 API 明确规定的 ABA 边界。

订阅可显式删除。默认操作仅在支撑队列所有状态都没有保留消息时成功；force 是有意授权丢弃这些消息。接受删除的事务会立即将订阅移出主题扇出和数据平面，并启动有界清理。若清理完成，同一次提交会删除映射和支撑队列；否则提交 `deleting` 标记，为后续核对保留名称。隐式主题的最后一个有效订阅退役后，主题立即无法继续扇出；只有仍保留正在删除的映射时，地址才继续被占用。

创建订阅时可以指定**固定存续期**。broker 从首次成功创建开始，保存一个绝对 `expires_at_ms`。普通重试、过滤器更新、消息流量和重启都不会延长它。省略 TTL 会使新订阅永久存在，并保留已有订阅的存续期。提供相同的正 TTL 是幂等操作；提供不同的正 TTL 会冲突。若要更改或移除存续期，应删除订阅，等待物理清理完成，再用新的全局唯一名称创建新的生命周期。

到达准确截止时间时，无论后台扫描是否已持久化 `deleting`，订阅都无法参与扇出或直接队列操作。到期代表预先授权强制清理，包括保留的锁定、定时、暂缓和死信消息。它不能撤销已由锁定投递产生的外部副作用。映射和名称在有界清理完成前仍被占用，因此，大量未消费积压在逻辑到期后仍可能继续占用磁盘和订阅容量名额。

为每个请求创建一个订阅，仍会给单写入者增加元数据和清理工作。高频请求/响应流量应为每个应用实例创建一个稳定的响应订阅，并为每个请求使用全局唯一的 `correlation_id`。分发器从该订阅接收消息，将响应交给对应等待方，同时处理重复响应和等待方超时后才到达的响应。TTL 应作为防止遗忘清理的后备措施，而不是正常成功路径。

应用将订阅视为临时资源时，其名称应是仅用于一个生命周期的应用身份：为该生命周期生成全局唯一名称，不要并发竞争同名重建。先创建接收端，再发送请求；收到响应或超时后删除订阅，并在释放所有权前核对 `deleting` 或未知结果。将地址放入 `reply_to`，将请求的 `correlation_id` 复制到响应中；不要假设 broker 会替应用实现 RPC 等待器或拒绝迟到响应。到期后的迟到发布不会再路由到该订阅；主题没有其他有效订阅时，发布将找不到有效目标。清理完成后，旧名称不再有持久身份可区分延迟重试与有意复用。高请求速率应优先使用上述稳定分发器模式。

broker 默认最多接受 10,000 个有效或正在删除的订阅。正在删除的条目在物理清理完成前仍计入总数，从而对资源频繁创建和删除施加背压，避免被遗忘的工作绕过数量上限。这是元数据安全上限，不是吞吐量承诺；单次发布的工作量和存储副本数仍与匹配订阅数量成正比。

### 消息 ID 与序列号：容易混淆的两个标识
| | 分配者 | 扇出到 N 个订阅时 | 用途 |
|---|---|---|---|
| `message_id` | 可由应用提供 | **每个副本完全相同** | 幂等/去重键，去重按队列进行：`(queue, message_id)` |
| `seq_number` | 由 broker 分配，全局单调递增 | **每个副本各不相同** | 消费时用于定位和结算的句柄，对应 ASB 的 SequenceNumber |

---

## 3. 常见问题的直接解答

**问：一条消息扇出到两个订阅，ID 相同吗？**
`message_id` **相同**，原样复制；`seq_number` **不同**，broker 从数据库范围的同一单调序列中为每个副本分配不同 id。它们是完全独立的两行记录，分别使用自己的 `seq_number` + `lock_token` 进行结算。

**问：在主题下新增一个带过滤器的订阅，历史消息会路由给它吗？**
**不会。** 扇出**只在发布时**进行，依据当时存在的订阅。没有历史回放，也不能回退 offset。新订阅只接收它创建**之后**发布且匹配过滤器的消息。（与 Kafka 不同，与 ASB / SNS+SQS 相同。）

**问：向当时没有订阅的主题发消息，会丢弃、缓冲，还是进入默认收件箱？**
**没有收件箱，消息不会被保留。** 分两种情况：① 存在订阅，但没有任何订阅匹配，消息会被**直接丢弃**，不报错；② 完全没有任何订阅以该名称为目标，则退回到“必须是已有队列”的查找逻辑：存在队列则投递，否则报错。**要保留消息，必须在发布前已有匹配订阅。**

---

## 4. 与云服务比较

### 概念对应
| MQLite | Azure Service Bus | AWS | GCP Pub/Sub |
|---|---|---|---|
| 队列（Queue） | Queue | SQS Queue | 大致相当于 Topic + 单个 subscription |
| 主题（Topic） | Topic | SNS Topic | Topic |
| 订阅（Subscription） | Subscription | SNS→SQS subscription | Subscription |
| 过滤器（expr-lang） | SQL/Correlation Filter | SNS Filter Policy | Subscription Filter |
| peek-lock + complete | Peek-Lock + Complete | Visibility Timeout + Delete | ack / nack |
| `seq_number` | SequenceNumber | 无 | 无，只有 ackId |
| DLQ（子状态） | DLQ（子队列） | Redrive Policy → DLQ | Dead-letter Topic |
| 去重窗口 | Duplicate Detection | SQS FIFO 去重，5 分钟 | 无原生功能，需自行实现 |
| group_id 顺序 | Session | SQS FIFO MessageGroupId | Ordering Key |

### 重要的行为差异
| 维度 | MQLite | ASB | SNS+SQS | GCP Pub/Sub | Kafka |
|---|---|---|---|---|---|
| 新订阅获得历史消息 | ❌ | ❌ | ❌ | ⚠️ seek + retention 可回放 | ✅ 可从 offset 0 开始 |
| 主题存储消息 | ❌ 仅路由 | ❌ | SNS ❌，由 SQS 存储 | ✅ 主题保留存储 | ✅ 日志即存储 |
| 没有匹配订阅者 | 丢弃 | 丢弃 | 丢弃 | 丢弃 | 仍在日志中 |
| 扇出副本相互独立 | ✅ 独立 seq + DLQ | ✅ | ✅ | ✅ | ⚠️ 一个日志，多个消费组 |
| 部署形态 | **单个 SQLite 文件 / 可嵌入** | 托管集群 | 托管 | 托管 | 集群 |
| 顺序模型 | 可选 group_id FIFO | Session | FIFO queue | Ordering Key | 按分区有序 |

### 一句话定位
- **接近 ASB**：peek-lock、DLQ、Topic/Subscription、Filter、SequenceNumber、dedup 几乎一一对应。熟悉 Azure Service Bus 时，学习成本很低。
- **不同于 Kafka 和 GCP Pub/Sub 的部分功能**：MQLite **基于订阅、不保留日志、不能回放历史**。它是“工作队列 + 主题扇出”，不是“消息日志/流”。需要回放或事件溯源时，应选择 Kafka 一类系统。
- **MQLite 自己的取舍**：整个 broker 是一个 SQLite 文件，可在进程内嵌入、无需运维额外服务，并对智能体友好，附带 MCP server。代价正是上述“不回放、不保留主题消息”的简化；这是有意选择，不是功能遗漏。

---

## 5. 容易踩到的误区

- 将主题当作“存放消息的收件箱”；主题不存储消息，应先订阅。
- 认为扇出副本共享一个 `seq_number`；实际并非如此，必须分别结算。
- 认为新订阅会补发历史；它不会。
- 将 DLQ 当作需要单独创建的队列；它是同一队列中的一种状态。
- 向没有订阅的主题名称发布，并期待它缓冲消息；实际会查找同名队列，找不到则报错。

---

# 订阅过滤器（expr）

**订阅过滤器**逐消息决定*当前*订阅是否接收已发布消息的一个副本。过滤器是单个 [expr-lang](https://expr-lang.org) 布尔表达式，例如：

```
subject_parts[0] == "orders" && properties["tier"] == "gold"
```

**空过滤器匹配所有消息。** 表达式在**订阅时进行一次类型检查和编译**，无效表达式会立即返回 `400 invalid_argument`；随后在**发布时逐消息执行一次**，作为第 1–3 节主题扇出中的逐消息判定：

```
 Subscribe ──► compile + type-check ──► cache the program     (bad expr → 400)
 Publish   ──► for each subscription: run program(message) ──► route when true
```

过滤器环境包含消息自身的字段和时间戳。需要可重复的路由决策时，以 `enqueued_at` 作为发布时刻的参照。上游 `now()` 内置函数也可使用，它读取墙上时钟（wall clock），因此使用它的表达式可能对同一消息得到不同结果。

## 6. 设置过滤器

| 接口 | 用法 |
|---|---|
| CLI | `mqlite subscribe orders orders-gold --expr 'properties["tier"]=="gold"'` |
| Go SDK | `cli.Subscribe(ctx, "orders", "orders-gold", &mqlite.Filter{Expr: "properties[\"tier\"]==\"gold\""})` |
| HTTP | `POST /mqlite.v1.AdminService/Subscribe` 请求体 `{"topic":"orders","name":"orders-gold","filter":{"expr":"..."}}` |

使用相同名称和新 `expr` 再次订阅会替换过滤器，在下一次发布时重新编译。省略过滤器或使用空 `expr`，即可接收所有消息。

## 7. 消息环境

以下变量可供过滤器引用。未知名称会导致编译错误，因此拼写错误会在 `Subscribe` 时被发现，而不会在运行时悄然发生。

### 基础字段

| 变量 | 类型 | 说明 |
|---|---|---|
| `subject` | string | 路由标签，对应 ASB Label |
| `properties` | map | 自定义字符串头：`properties["k"]`、`"k" in properties`；缺失键得到 `""` |
| `group_id` | string | 排序/会话键 |
| `correlation_id` | string | |
| `reply_to` | string | |
| `message_id` | string | 去重/幂等 ID |
| `content_type` | string | 例如 `application/json` |

### 时间

二者都是消息自身的时间戳，由 epoch 时间转换为 UTC `time.Time`，并非读取当前墙上时钟。

| 变量 | 类型 | 值 |
|---|---|---|
| `enqueued_at` | time | 消息发布时刻；扇出也在发布时执行，因此它就是该决策中的“当前时刻” |
| `visible_at` | time | 消息变为可投递的时刻：立即发送时等于 `enqueued_at`，延迟发送或经 `Schedule` 定时时为计划时刻；绝不为 null |

可用时间相减计算延迟（`time - time` → duration）：

```
visible_at - enqueued_at > days(1)        # only route significantly-delayed messages
enqueued_at.Hour() >= 9 && enqueued_at.Hour() <= 21   # business-hours publish window
```

### 派生字段

由消息计算得到，始终有定义，不会因缺失而报错。

| 变量 | 类型 | 示例 |
|---|---|---|
| `subject_parts` | []string | `"orders.eu.new"` → `["orders","eu","new"]`，采用类似 MQTT 的层级：`subject_parts[0] == "orders"` |
| `body_size` | int | 字节长度；`body_size < 4096` 按大小而非内容路由 |
| `property_keys` | []string | 排序后的属性名：`len(property_keys) > 0`、`"tier" in property_keys` |

### 正文内容

也可依据载荷本身路由。这些字段**仅在过滤器引用时才投影生成**，不读取正文的过滤器不承担相应开销。

| 变量 | 类型 | 示例 |
|---|---|---|
| `body_text` | string | 原始正文的文本表示：`body_text contains "urgent"`；始终有定义，空正文得到 `""` |
| `body_json` | map | 将正文解码为 JSON 对象：`body_json.amount > 100`、`body_json["tier"] == "gold"`、`"k" in body_json` |

`body_json` **只在 `content_type` 看起来是 JSON 或未设置时解码**。显式非 JSON 类型、空正文、无效 JSON 或非对象 JSON（数组/标量）都会得到空对象 `{}`。因此 `body_json` 本身绝不为 null；但读取**不存在的字段**，例如没有 `amount` 时读取 `body_json.amount`，会得到 `nil`。继续比较（`nil > 100`）会产生运行时错误，并采用**失败即不匹配**（fail-closed）策略：消息不路由到该订阅，并记录错误。字段可能不存在时，应先检查：

```
"amount" in body_json && body_json.amount > 100
```

## 8. 语言

支持标准 expr 运算符和内置函数：

- 比较 `== != < <= > >=`，布尔 `&& || !`（或 `and`/`or`/`not`），成员关系 `in`
- 字符串：`startsWith`、`endsWith`、`contains`、`matches`（正则表达式）
- 集合：`len()`、`all()`、`any()`、`none()`、`filter()`、`map()`，以及下标访问 `x[0]`

### 时长

对于时间字段，推荐使用**经过类型检查的辅助函数**表示时长，含义明确；也可使用扩展后的 `duration()`：

| 形式 | 含义 |
|---|---|
| `seconds(n)` `minutes(n)` `hours(n)` `days(n)` `weeks(n)` | 时长；`days`/`weeks` 是固定长度，分别为 24 小时 / 7 天 |
| `duration("90m")` `duration("1d12h")` `duration("2w")` | 字符串形式，在 Go 时间单位之外**增加** `d`（24 小时）和 `w`（7 天） |

没有月或年单位，因为受日历影响，它们不是含义固定的时间跨度。表达“早于一个月”时，可用 `days(30)`。

```
visible_at - enqueued_at == hours(2)
visible_at - enqueued_at > duration("1d")
```

### expr-lang 参考

过滤器引擎**就是** [`expr-lang/expr`](https://github.com/expr-lang/expr)，固定为 **v1.17.8**，因此其完整语言——每个运算符、字面量形式和内置函数——都可使用，并有上游文档。第 7 节的**消息环境**、上述时长辅助函数，以及第 10 节失败即不匹配的布尔契约属于 MQLite 扩展；其余均为标准 expr。内置函数的确切行为存在疑问时，以上游参考为准。

| 内容 | 地址 |
|---|---|
| 源码 / 项目 | <https://github.com/expr-lang/expr> |
| 语言规范（权威参考） | <https://expr-lang.org/docs/language-definition> |
| 运算符 | <https://expr-lang.org/docs/language-definition#operators> |
| 字符串内置函数 | <https://expr-lang.org/docs/language-definition#string-functions> |
| 数组/集合内置函数 | <https://expr-lang.org/docs/language-definition#array-functions> |
| 日期/时长内置函数 | <https://expr-lang.org/docs/language-definition#date-functions> |
| 数字内置函数 | <https://expr-lang.org/docs/language-definition#number-functions> |
| 类型转换内置函数 | <https://expr-lang.org/docs/language-definition#type-conversion-functions> |
| 文档首页 | <https://expr-lang.org/docs/getting-started> |

> 求值器不暴露文件或网络 I/O API，运行在沙箱中，具备内存安全、无副作用、必定终止的特性，见第 10 节。这并不移除上游 `now()` 内置函数：路由决策必须可重复时，应优先使用消息派生的时间戳。`days()`/`weeks()`/`duration("…d…w")` 时长辅助函数是 MQLite 在 expr 日期函数基础上提供的扩展，不属于标准 expr。

## 9. 过滤器示例

```
subject_parts[0] == "orders"                              # topic hierarchy
properties["tier"] == "gold" && properties["region"] == "eu"
"priority" in properties && properties["priority"] == "high"
subject startsWith "payment." and not (properties["test"] == "true")
body_size < 4096                                          # small messages only
visible_at - enqueued_at > days(1)                        # delayed > 1 day
len(subject_parts) >= 2 && subject_parts[1] == "eu"
"amount" in body_json && body_json.amount > 100           # route on payload (guarded)
body_text contains "urgent"
```

## 10. 过滤器安全

过滤器对消息环境及可用的 expr 内置函数求值。不暴露文件或网络 I/O API；`now()` 可以读取墙上时钟：

- expr 按设计具备**内存安全、无副作用、必定终止**的特性，不访问文件或网络，也没有无界循环。
- 过滤器必须是**布尔值**（`expr.AsBool`）；非布尔表达式会在 `Subscribe` 时被拒绝。
- 资源限制：源码长度和编译后 AST 大小均有上限。
- **失败即不匹配（fail-closed）**：过滤器运行时报错，例如对只有两段的 subject 访问 `subject_parts[3]`，或发生 panic 时，消息**不会**路由到该订阅，并记录错误；绝不会使 broker 崩溃，也不会悄然视为匹配。

## 11. 延伸阅读

- **expr 语言**：源码 [`github.com/expr-lang/expr`](https://github.com/expr-lang/expr)，完整参考为 <https://expr-lang.org/docs/language-definition>，各类内置函数链接见第 8 节。
- **为什么选择 expr**：[dependencies.md](dependencies.md) 解释了为何将 `expr-lang/expr` 作为稳定的长期依赖，固定为 v1.17.8。
- **规范性不变量**：一致性规范（[conformance.md](conformance.md) 第 11 节）列出 MQLite 保证的过滤器规则。
