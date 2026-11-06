# 一致性规范：mqlite 的正确行为（TCK）

本规范跟随 `main`，包含尚未发布的改动。使用已安装的 v0.4.2 发行版时，请阅读[该标签对应的一致性规范](https://github.com/mqlitehq/mqlite/blob/v0.4.2/docs/conformance.md)；待发布的行为变化见 [CHANGELOG.md](../CHANGELOG.md#unreleased)。

本文是 mqlite **必须**遵守的规范性行为要求：这些不变量定义何为“正确”，不依赖具体实现细节。每项都有交叉引用的隔离测试强制执行，共同构成 mqlite 的 TCK。破坏本文任一**必须**（MUST）要求的改动，属于行为变更，而非重构。

默认 Peek-Lock 采用**至少一次交付（at-least-once）**：可能重投，因此处理函数必须幂等。接收即删除（receive-and-delete）由调用方显式选择，是 broker 侧至多一次移除的路径，消息在返回前即被删除；同一 receive attempt ID 可以重放保存的响应。其他已记录的丢弃路径包括配置为丢弃的消息 TTL、DLQ 保留策略、强制删除资源和固定订阅到期。（第 1.7、3、8、14 节）

## 1 · Peek-Lock 生命周期

- **1.1** `Receive` 领取一条 `active` 消息，在队列锁时长内将其移为 `locked`，并返回 `lock_token`。*(engine/functional_test.go)*
- **1.2** `locked` 消息必须对其他 `Receive` 调用不可见，直到已结算、锁过期，或显式嵌入式启动恢复使孤儿锁失效。普通启动必须保留有效资源上的未过期租约，因为其他持有者可能在此次打开之后仍然存活；资源生命周期和消息 TTL 仍适用。在一个运行中的 broker 内，绝不重复授予同一有效租约。
  *(engine/functional_test.go `TestCompetingConsumersNoDouble`)*
- **1.3** 每次新授予的 `Receive` 或 `ReceiveDeferred` 领取恰好增加一次 `delivery_count`。续锁、结算、锁回收、定时激活，以及有效 receive attempt 的重放，都不得增加该计数。
  *(engine/engine_test.go, engine/ga_fixes_test.go, engine/functional_test.go)*
- **1.4** 锁过期时，reaper 将消息移回 `active` 以便重投；若 `delivery_count >= max_delivery_count`，则移为 `dead_lettered`。*(engine/engine_test.go)*
- **1.5** 深积压下领取复杂度为 O(log n)，依赖 `active` 行上的局部索引；过期锁由 reaper 回收，而非领取路径回收。*(engine/claim_plan_test.go)*
- **1.6 领取时间。** 对 `Receive`（带或不带 `AttemptID`，包括接收即删除）和 `ReceiveDeferred`，每个领取项、每次远程重试都必须在写入准入后，使用新的 broker 时间判断 TTL 资格和租约截止时间。该检查时 TTL 已到期的消息不得被领取。等待写入者或处理批次中较早的项，不得在后续项开始领取前消耗它的租约。
  *(engine/functional_test.go: TestClaimTimeAfterWriterAdmission, TestClaimBatchUsesEachItemsTime,
  TestClaimBatchTTLBetweenItems, TestReceiveDeferredMixedItemsAndCommittedPrefix;
  engine/storage_test.go: TestClaimTimeRefreshesOnRemoteRetry)*

- **1.7 接收即删除（Receive-and-delete）** 删除每个返回行，不授予租约：锁令牌为空，截止时间为零，缓存 attempt 重放也如此。Peek-lock 则保留令牌和租约截止时间。*(sdk_test.go: TestSDKReceiveDeleteLeaseShape)*

- **1.8 队列锁配置。** 新队列或显式重配置的队列，必须使用 `0`（默认 30 秒），或 1 秒至 1 小时之间的锁时长，含两个端点。范围外数值在任何变更前返回 `ErrInvalidArgument`。现有数据库中的历史范围外数值仍可读取；不覆盖支撑队列配置的更新可以保留该数值。*(engine/engine_test.go: TestQueueLockDurationValidation,
  TestLegacyOutOfRangeQueuesRemainReadable; sdk_test.go:
  TestQueueLockDurationValidationBeforeTransport)*

## 2 · 结算：由 `lock_token` 隔离

每种结果只对应一个操作动词。产生新效果要求 `Receive` 返回的 `lock_token` 和未过期租约；精确请求重放的例外见第 2.6 节。

- **2.1 Complete** 删除消息。*(engine/functional_test.go)*
- **2.2 Abandon** 将消息移回 `active` 以便重投，到达或超过最大次数时则移为 `dead_lettered`。`delay_ms > 0` 时，消息暂存于 `scheduled` 直到退避结束，由调度器重新激活。在**有序**队列中，暂存的队首像定时发送一样保持队首阻塞，后继不能越过它，见第 5.5 节。Abandon 和定时激活都不增加 `delivery_count`，下一次领取才增加。
  *(engine/engine_test.go; engine/functional_test.go:
  TestAbandonDelayHoldsGroupOrder)*
- **2.3 Reject** 将消息连同原因移为 `dead_lettered`。*(engine/functional_test.go)*
- **2.4 Defer** 将消息暂缓，之后通过 `ReceiveDeferred` 按序号取回。普通 `Receive` 绝不返回暂缓消息。在**有序**队列中，暂缓消息**保持队首阻塞**：取回并结算前，同组后续消息不可领取；`strict_fifo` 下整个队列均如此，其他组可继续。没有 TTL 时不会自动恢复，因为 reaper 从不回收 deferred 行；遗失序号可通过 `Peek state=deferred` 找回。成功的 `ReceiveDeferred` 增加 `delivery_count`，但不依据 `max_delivery_count` 限制这种显式按序号领取，因此返回计数可能高于普通投递预算。后续结算仍遵循通常规则。
  *(engine/functional_test.go: TestDeferHoldsHeadOfLine)*
- **2.5 Renew** 必须保留相同状态、令牌和 `delivery_count`。对于没有固定到期时间的队列或订阅，截止时间设为 `max(old locked_until, broker now + lock_duration)`；固定订阅存续期会限制候选截止时间。不得缩短租约，也不得恢复当前截止时间已过的租约。*(engine/ga_fixes_test.go)*
- **2.6** 使用错误或过期令牌结算，必须返回 `ErrLockLost`（HTTP 409）；**例外**是同一精确请求仍有有效回执时，幂等重放返回成功，见第 3.2 节。只匹配令牌不够：新的结算和续锁效果要求记录处于锁定状态，且 `locked_until_ms > now`，即使 reaper 尚未执行也如此。相等即过期。时间在本地写入准入后采样，每条结算语句及每次远程重试都重新采样；等待不能保住已过期租约或回执。有效的精确请求回执仍可在原租约到期后重放已提交效果。
  *(engine/ga_fixes_test.go; engine/complete_batch_test.go:
  TestSettlementLeaseDeadline, TestSettlementReceiptIdentityMatrix,
  TestSettlementReceiptTimeAfterWriterAdmission, TestCompleteBatchRefreshesTimeBetweenChunks;
  engine/storage_test.go: TestSettlementTimeRefreshesOnRemoteRetry;
  sdk_test.go: TestSDKSettlementDeadline)*
- **2.7 CompleteBatch** 在一个事务中结算多条消息，每项遵循同样的令牌隔离与幂等规则。没有精确请求回执的过期令牌得到 `ok=false`，不会使整个批次失败。单条 `Complete` 与 `CompleteBatch` 中的条目共享完成操作身份，因此同一成功请求可在两种方向互相重放。
  *(engine/complete_batch_test.go: TestCompleteBatch, TestSettlementReceiptIdentityMatrix)*
- **2.8 RenewBatch** 用**一条语句**续延一批租约，逐项使用自身 `lock_token` 隔离，并报告已提交截止时间。`ok=true` 表示 broker 的**语句执行结束时**租约仍有效；响应还需传输，因此 `locked_until_ms` 才是权威事实，远程调用方根据 broker 时间将其映射到本地单调时钟。写入结束时锁已过期的续锁返回 `ok=false`，不会交回调用方实际上已不再持有的锁；续锁也绝不*缩短*租约。每个成功项遵循第 2.5 节截止时间规则，保留状态、令牌和 `delivery_count`。批次最多 512 条，因为有效租约保证必须在单条语句内才能维持。
  *(engine/complete_batch_test.go)*

## 3 · 幂等性与至少一次交付

- **3.1** 每次 `Open` 默认必须保留有效资源上未过期的租约，仅回收 `locked_until <= now` 的锁，因为新进程无法证明远程或进程外持有者不再可能续锁或结算其持久化令牌。仅在已知所有先前处理函数都已结束时，嵌入式所有者才可以显式请求立即回收有效租约。资源生命周期和消息 TTL 仍具有最终约束力。
  回收遵循 reaper 规则：返回 `active`，或在 `delivery_count >= max_delivery_count` 时移为 `dead_lettered`，原因为 `MaxDeliveryCountExceeded`。保留有效租约不得增加 `delivery_count`。
  *(engine/engine_test.go: TestExplicitCrashRecoveryRespectsMaxDelivery,
  TestOpenPreservesUnexpiredLeaseByDefault,
  TestOpenReclaimsExpiredLeasesByDefault)*
- **3.2** 精确请求回执有效时，丢失响应的结算必须重放为成功，而非 `ErrLockLost`，且**仅限同一请求**。回执自记录起 30 分钟到期，重放不得刷新截止时间；资源删除或固定订阅到期可能提前终止重放。`settlement_receipt` 标识 `queue + seq_number + lock_token + operation + effect-bearing arguments`；任一字段不同都不是重放，必须返回 `ErrLockLost`，不能在悄然保留首次效果的同时报告成功。
  *(engine/ga_fixes_test.go; engine/complete_batch_test.go: TestReceiptsAreBoundToTheirMessage,
  TestReceiptsAreBoundToTheirArguments, TestSettlementReceiptsAreVerbSpecific,
  TestSettlementReceiptIdentityMatrix;
  engine/model_test.go: TestEngineMatchesTheModel, TestModelRejectReceiptArguments)*
- **3.3** 使用同一 `AttemptID` 重试 Peek-Lock `Receive` 时，只有记录仍有效且缓存的每个令牌仍拥有对应有效未过期锁，才必须重放同一批次和令牌。任一令牌过时时，broker 必须使整个缓存批次失效，并在同一事务中安全地重新领取，不得返回过时或仅部分拥有的批次。失效处理不得撤销该响应中仍拥有有效租约的其他令牌，因为已观察到原响应的调用方可能仍在处理它们。因此 AttemptID 仅用于响应尚未被观察到的 Receive 精确重试；收到响应后，或部分结算后，不得再用于新的 Receive。不带令牌的 Receive-and-Delete 响应可在 attempt 有效期内重放。两种模式下，记录存续期均为记录时“五分钟与队列锁时长的较大值”，并受固定订阅到期限制。重放和续锁不得延长记录截止时间。有效的非空保存响应绑定到原接收模式；空结果不建立记录，已过期记录不再绑定 ID。未知模式必须被拒绝。记录和租约是否到期，都必须在写入准入后用新时间检查。
  *(engine/ga_fixes_test.go; engine/functional_test.go:
  TestReceiveAttemptExpiryAfterWriterWait,
  TestReceiveAttemptDoesNotReplayStaleLeaseAfterRestart,
  TestReceiveAttemptDoesNotReplayDeadLetteredLeaseAfterRestart,
  TestReceiveAndDeleteAttemptStillReplaysAfterRestart,
  TestReceiveAttemptDoesNotReplayExpiredLease,
  TestReceiveAttemptRejectsModeMismatchWithoutDestroyingReplay,
  TestReceiveRejectsUnknownModeWithoutMutation,
  TestEmptyReceiveAttemptDoesNotBindMode,
  TestExpiredReceiveAttemptDoesNotBindMode,
  TestReceiveAttemptInvalidatesWholePartiallySettledBatch)*
- **3.4** 无消息缺失与无内容损坏：隔离的完整性工作负载发送连续 `1..N` 序列，正文为随机内容并将哈希写入属性，然后在有足够投递预算的条件下并发消费，期间有意重投。每个身份都必须完成，每次接收的正文都必须匹配其哈希。重复接收是预期行为，不是处理函数恰好一次执行的保证。
  *(engine/integrity_test.go `TestMessageIntegrity`)*

## 4 · 去重

- **4.1** 在队列的 `dedup_window` 内，重复 `message_id`（空值则使用正文 SHA-256）且正文相同，必须合并为一次入队。窗口配置为零时关闭去重，这也是默认值。窗口从该键最后一次新入队开始，重复发送不得刷新窗口。完成消息不得清除仍保留的去重身份。只有正文字节参与冲突检查；重复请求的元数据、TTL 和计划时间不得更新原消息。
  *(engine/functional_test.go, engine/turso_test.go)*
- **4.2** *单条* `Send` 的 `message_id` 对应不同正文时，必须返回 `ErrDedupConflict`（HTTP 409）。*(server/send_dedup_test.go)*
- **4.3** *多条消息* `Send` 中的冲突项返回序号 `0`，表示跳过，其余批次项仍提交。*(wire `SendResponse`; server/send_dedup_test.go)*

## 5 · 排序模式

- **5.1 `standard`**：按 `GroupID` 保持 FIFO，组间可并行；没有 `GroupID` 的消息不保证顺序。领取资格与 `group_fifo` 完全相同，唯一区别是 `group_fifo` 还在发送时要求 `GroupID`。*(engine/functional_test.go)*
- **5.2 `group_fifo`**：每个 `GroupID` 内严格 FIFO，各组各自保持队首；缺少 `GroupID` 的发送必须以 `ErrGroupRequired` 拒绝。*(engine/functional_test.go)*
- **5.3 `strict_fifo`**：全局 FIFO，同一时刻整个队列最多有一条消息正在处理中。*(engine/functional_test.go, engine/claim_plan_test.go)*
- **5.4** 队首阻塞必须跨锁过期保持：已过期但未被回收的锁仍阻塞所属组，`strict_fifo` 下阻塞整个队列。后继绝不先于已过期队首投递。reaper 处理后，队首按 id 顺序首先重投，或在 `count ≥ max` 时进入死信并解除组阻塞。接受的代价是消费者超时后，所属组最多再停顿一个 reaper 周期。*(engine/functional_test.go: TestFIFOHoldsAcrossLockExpiry)*
- **5.5** 显式退避期间也必须保持队首阻塞：`Abandon` 的 `delay_ms > 0` 将队首暂存于 `scheduled`，该状态受队首探测覆盖，因此后继绝不能先于正在退避的队首投递；退避结束后，调度器重新激活队首，它仍首先重投。`standard`/`group_fifo` 的其他组所代表的其他工作，可在退避期间继续执行。
  *(engine/functional_test.go: TestAbandonDelayHoldsGroupOrder)*

## 6 · 死信队列

- **6.1** 普通 Peek-Lock `Receive` 达到 `max_delivery_count`，本身不得使消息进入死信：第 N 次普通 Peek-Lock 领取是完整的最后尝试，可续锁并完成。若该锁定尝试被 Abandon、租约到期，或启动恢复时满足 `delivery_count >= max_delivery_count`，则必须以 `MaxDeliveryCountExceeded` 为原因进入死信，而不是重新成为 active 获得第 N+1 次普通 Peek-Lock 领取。普通重试上限不覆盖第 2.4 节明确规定的 `ReceiveDeferred` 行为。*(engine/engine_test.go)*
- **6.2** `Redrive` 将死信移回 `active` 或目标队列；`Purge` 永久删除死信，范围由 `Max`/`OlderThanMs` 限定。*(engine/redrive — functional tests)*

## 7 · 定时、暂缓与 TTL

- **7.1 Schedule** 在计划时刻前隐藏消息，状态为 `scheduled`，`visible_at` 位于未来；到期由调度器激活。`Cancel` 删除从未投递的定时消息（`delivery_count=0`），第 2.2 节由退避暂存的重投消息**不能**取消，仍遵循重试/DLQ 规则。调度器激活不得增加 `delivery_count`。
  *(engine/functional_test.go: TestAbandonDelayHoldsGroupOrder)*
- **7.2 TTL**：过期消息（`expires_at`）在队列设置 `dead_letter_on_expire` 时必须移入 DLQ，否则丢弃。两个分支覆盖**相同的状态集合**：包括 `scheduled` 在内的所有非终态。TTL 扫描可直接使定时记录到期；调度器若先看到已过期记录，可以将其改为 `active`，但领取资格仍在 `now >= expires_at` 时排除它，随后 TTL 扫描会在未投递的情况下终止它。队列默认值同时也是显式消息 TTL 的默认值与上限。到期时间锚定消息最初的 `visible_at`，因此定时消息从计划投递时刻开始计时；后续带延迟的 Abandon 和调度器激活不得重新计算它。消息 TTL 与锁租约相互独立，锁定行也可到期，Renew 不得延长 TTL。嵌入式和远程批量 Send 必须保留每项请求的 TTL；统一 TTL 的 HTTP 批次可以使用批次级字段，混合批次使用逐消息字段。同时提供正的批次级 TTL 和正的逐消息 TTL，或在任一位置提供负 TTL，请求都必须被判为无效。Go SDK 还必须在发送或写入前拒绝小于线协议 1 ms 精度的正消息 TTL；有效截止时间若导致 epoch 毫秒溢出，必须失败且不提交批次中的任何项。
  *(engine/functional_test.go: TestTTLScheduledToDeadLetter,
  TestTTLCapAtQueueDefault, TestNegativeMessageTTLRejectedBeforeWrite,
  TestMessageTTLExpiryOverflowRejectedAtomically,
  TestMessageTTLDeadlineSurvivesRenewAndDelayedRetry; sdk_test.go:
  TestBatchTTLRemoteEmbeddedParity, TestNegativeMessageTTLSDKParity,
  TestRemoteBatchTTLWireCompatibility; server/send_dedup_test.go:
  TestServerSendPerMessageTTL; engine/turso_test.go:
  TestTursoMessageTTLParity; test/api_tests.py: t_message_ttl_contract)*

## 8 · DLQ 保留策略

- **8.1** 设置上限后，`reapDLQ` 必须按**最旧优先**删除超过最长年龄、单队列数量或单队列正文字节数的死信，并且**只能**处理 `state='dead_lettered'`，绝不处理未投递、在途或定时工作。这些是异步保留目标，而非准入上限；DLQ 可以在两轮有界工作循环之间暂时超过目标。
  *(engine/retention_dlq_test.go)*
- **8.2** 未设置上限时，即引擎默认状态，DLQ 无界，不自动删除。*(engine/retention_dlq_test.go `TestDLQRetentionDisabledByDefault`)*
- **8.3** 每个队列的有效上限，由队列覆盖值与引擎默认值共同解析（`effectiveBound`）：`0` 继承默认值，`>0` 覆盖默认值，`<0` 明确表示无界。*(engine/retention_dlq_test.go `TestEffectiveBound`,
  `TestDLQRetentionPerQueueOverride`, `TestDLQRetentionPerQueueInheritAndOptOut`)*

## 9 · 认证与错误：broker

- **9.1** 设置 `MQLITE_TOKENS` 时，除公开的 `/` 发现接口、`/healthz`，以及启用时 `/ui` 下的静态管理控制台之外，所有端点必须要求有效的 `Authorization: Bearer` 令牌；控制台自身的 API 调用仍携带令牌。令牌缺失、无效、过期或撤销，返回 401 `unauthenticated`。
  *(server/errors_test.go, server/index_test.go, server/console_test.go)*
- **9.2** 错误使用 JSON 包装 `{code,message}`，HTTP 状态遵循文档。`not_found` 可增加向后兼容的 `resource` 区分字段，值为 `queue` 或 `subscription`：
  400 `invalid_argument`/`group_required` · 401 `unauthenticated` · 403
  `permission_denied` · 404 `not_found` · 409
  `already_exists`/`lock_lost`/`name_conflict`/`key_conflict`/
  `queue_not_empty`/`subscription_not_empty` · 413 `message_too_large` ·
  429 `resource_exhausted` · 499 `canceled` · 500 `internal` ·
  503 `unavailable`/`outcome_unknown`。
  *(server/errors_test.go; see [api-reference.md](api-reference.md))*
- **9.3** 每个注册 RPC 必须在路由注册时绑定权限。Send/Schedule/Cancel 要求 send；其他全部 QueueService 方法要求 listen；订阅 upsert 和过滤器试运行要求 listen；其他全部 AdminService 和全部 AuthService 方法要求 manage。但 Observe 和可选启用的 `/metrics` 也接受配置的只读 monitor 凭据。仅空订阅删除和强制删除都要求 manage。Metrics 默认必须关闭，关闭时返回 404，只有启用时才以 `/metrics` 出现在发现信息中。启用 metrics 必须要求管理员认证。Manage 包含两种数据权限。配置式管理员与托管管理员必须有相同操作权限，包括签发 manage 密钥。权限不足必须在处理函数读取或改变受保护数据前失败。
  *(server/errors_test.go: TestAccessKeyCompletePermissionMatrix,
  TestListenSubscriptionProvisioningBoundary;
  server/metrics_test.go: TestMetricsDefaultOffAndAnonymousObserveDenied,
  TestMetricsEnabledRequiresAdministratorAuthentication, TestMetricsPermissionMatrix,
  TestMetricsDisabledSkipsDatabaseAuthentication)*
- 配置的 monitor 凭据不得授予消息访问或管理能力，必须与管理员凭据不同，且无需依赖数据库认证即可继续采集故障遥测。采集失败必须省略队列 gauges，明确标示数据不可用，同时保留真实的内存计数器。
  *(server/metrics_test.go: TestMonitorConfigurationFailsClosed,
  TestObserveStorageFailureAvailability, TestObserveAuthOutcomesAndWholeRequestCoverage)*
- **9.4** 托管密钥必须跨重启保留，且只存储令牌的 SHA-256 摘要。新令牌必须为 `mqk_` 加安全随机源产生的 64 个小写十六进制字符。现有配置式令牌继续按原值接受。只有成功创建的响应返回密钥原文；列表、错误和日志不得返回令牌或摘要。重复公共 ID 不得签发第二份凭据。关闭认证时必须拒绝密钥管理。
  *(engine/storage_test.go: TestAccessKeyLifecycle, TestAccessKeyValidation;
  server/errors_test.go: TestAccessKeyManagementLifecycleAndSecrecy,
  TestAccessKeyErrorsDoNotEchoSecrets; token_test.go)*
- **9.5** 成功撤销后，必须拒绝后续认证；已经授权的请求可以完成。静态配置优先于匹配的数据库记录。SDK 必须在接收、结算和续锁路径把权限拒绝视为永久错误，不得因批量请求被拒绝而改走其他未经授权的操作路径。
  *(server/errors_test.go: TestAccessKeyRevocationAndExpiryBoundaries;
  sdk_test.go: TestManagedKeySDKAuthorization; receiver_internal_test.go;
  cmd/mqlite/safety_test.go)*
- **9.6** 访问密钥列表默认必须按 ID 升序。显式 `created_desc` 必须对完整结果按创建时间降序、再按 ID 降序排列，使用稳定游标分页。撤销不得改变密钥位置；在游标前新增密钥，不得使后续页重复或跳过已有密钥。未知排序值和创建时间排序下的未知游标必须以 `invalid_argument` 失败。SDK 和工具必须拒绝顺序错误的响应。
  *(engine/storage_test.go: TestAccessKeyCreationOrderPagination,
  TestAccessKeySortValidationAndIndex; server/errors_test.go:
  TestAccessKeyCreationOrderHTTP; wire/wire_test.go:
  TestAccessKeyCreationOrderResponseValidation; test/api_tests.py)*
- **9.7** 每个 HTTP 响应必须携带 `X-Mqlite-Server-Time-Ms`，在首次写出响应时，从用于租约与 TTL 判断的同一可注入 epoch 毫秒 broker 时钟采样。这一新增响应头对成功和错误响应均有效；客户端不得把代理生成的失败或重定向视为 broker 时间证据。远程租约调度器必须保守考虑传输与时间戳精度的不确定性，为下一次续锁预留已观测往返耗时的余量，不得仅因本地墙上时钟落在该区间内就延长租约。已确认的精确租约若短于托管 Receiver 的安全续锁间隔，必须采取失败关闭策略，而非进入无界续锁循环。
  启用 CORS 的响应必须在 `Access-Control-Expose-Headers` 中列出该响应头。
  *(server/errors_test.go: TestJSONResponsesCarryServerTime;
  receiver_internal_test.go: TestClientMapsBrokerDeadlineOntoLocalMonotonicClock,
  TestClientLongPollNeverExtendsLeaseFromLocalWallClock,
  TestClientLongPollObservationDoesNotContaminateShortRenewal,
  TestClientRejectsPathologicallyShortConfirmedLease)*
- **9.8** 托管 Receiver 收到 HTTP 499，且自己的控制 context 仍有效时，必须将其视为瞬时错误。Receive 重放必须保留同一 attempt ID；调用方 context 已取消时，必须停止，不再发送请求。*(receiver_internal_test.go:
  TestReceiverRetriesBrokerCanceledReceiveWithSameAttemptID,
  TestReceiverDoesNotRetryBrokerCanceledResponseAfterCallerCancel)*
- **9.9** 同一轮 Receive 的所有瞬时重试，托管 Receiver 必须保留同一个非空 AttemptID。首次瞬时失败不得增加客户端生成的延迟，除非有效的 HTTP 429/503 `Retry-After` 提供正的节奏提示。后续失败采用等抖动（equal-jitter）指数退避，基值 500 ms，名义窗口逐次翻倍，生成延迟上限三秒。有效提示可以使某次等待超过该上限，但必须限制在 60 秒内；提示使等待超过生成值时，必须先调用错误处理函数再等待，包括首次失败。`Retry-After: 0` 不得消除后续生成的退避。接受相对秒数和 HTTP-date 两种形式。绝对日期优先使用同一响应中可解析的 `Date`，否则使用本地收到响应的时刻；格式错误、负数或溢出值忽略。每次等待都必须可由控制 context 中断。HTTP 状态只有在 `status / 100 == 5` 时才可按 5xx 规则视为瞬时错误；600 不属于 5xx，必须是终止错误。任何成功的 Receive，包括空响应，都结束本轮、重置失败计数，并为下一轮分配新的 AttemptID。Renew 和结算重试策略必须保持独立。
  *(receiver_internal_test.go: TestReceiverRetryScheduleKeepsAttemptAndResetsAfterSuccess,
  TestReceiverRetryAfterIsBoundedManagedReceivePacing, TestParseRetryAfter,
  TestManagedReceiverHonorsHTTPRetryAfterAndKeepsAttemptID,
  TestReceiverCancellationInterruptsRetryAfterWait,
  TestReceiverReturnsNonRetryableHTTPError)*

## 10 · 存储与 schema 不变量

- **10.1** 本地文件与 `:memory:` 使用单写入者（`SetMaxOpenConns(1)`）；第二个进程或第二次 `OpenEmbedded` 打开同一文件，必须立即以 `ErrDBLocked` 失败。本地文件可以为观测读取使用一个独立的 `mode=ro` 加 `query_only` WAL 连接；该连接必须拒绝写入和 checkpoint，并共享引擎关闭准入屏障。全局队列快照可以复用约 10 秒，必须将原始 `sampled_at_ms` 和内部拓扑隔离信息作为同一缓存项保留，必须合并并发刷新，且不得缓存失败刷新。Observe 的 `server_time_ms` 必须从同一可注入生命周期时钟单独读取，不得保存在队列快照缓存中。单队列 `Stats` 保持实时索引读取。
  *(engine/storage_test.go, engine/observability_performance_test.go)*
- **10.2** 记录的 `schemaVersion` 与二进制不一致时，`Open` 必须拒绝数据库（`ErrSchemaVersionMismatch`），不能对它执行不匹配的 DDL。
  *(engine/storage_test.go)*
- **10.3** 所有时间均为 UTC epoch 毫秒；可注入时钟以便确定性测试。远程 Turso 路径使用退避重试瞬时错误，本地路径从不重试。成功且 baton 为 null 的 `libsql://` 响应会关闭对应逻辑 Hrana 流，绝不能把它保留在空闲槽或直接交给等待的调用方。整个事务从开始到提交或回滚必须使用同一逻辑流；本地连接池必须保持 MaxOpen=1，不通过连接生命周期回收连接。*(engine/storage_test.go:
  TestHranaClosedStreamIsDiscardedBeforeFreshReuse,
  TestHranaTransactionKeepsOneLease,
  TestMemoryDBSurvivesRepeatedFreshStatements; engine/turso_test.go)*
- **10.4** 访问密钥表与索引的添加，在规范 schema 内保持独立、可叠加。应验证完整备份/恢复内容，包括有效、过期和已撤销凭据。已有名为 `access_keys` 或 `idx_access_keys_created` 的不兼容对象时，必须失败，不能覆盖或悄然信任。
  *(engine/storage_test.go: TestAccessKeySchemaAdditiveCompatibility,
  TestAccessKeySchemaConflict, TestAccessKeyCreationIndexUpgradeAndConflicts;
  test/production/restore/run.py, compat.py)*
- **10.5** 持久化资源生命周期及固定订阅到期列与索引，使 v0.4.0 的 schema 令牌 7 与较旧 schema-5 布局及中间 schema-6 布局不兼容。各二进制必须拒绝另一版本的数据库，不能补列、重写令牌或部分打开。运维人员必须创建新数据库，并保留匹配的旧二进制/备份组合。*(engine/storage_test.go:
  TestSchemaVersionGuard, TestSchemaContentPinnedToVersionToken)*
- **10.6 后端一致性。** 给定相同的已提交状态、broker 时间和请求，本地 SQLite 与远程 Turso/libSQL 必须产生相同的成功结果、校验结果、状态转换和逻辑哨兵错误。延迟、暂时可用性、远程传输错误（包括 `ErrOutcomeUnknown`）、远程事务回调重放，以及明确的部署、维护、观测运维行为可以不同，但不得悄然改变确定性队列语义。
  *(engine/turso_test.go: TestTursoIntegration, TestTursoExtended,
  TestTursoMessageTTLParity, TestTursoConcurrent, TestTursoBatchSettle;
  engine/storage_test.go; server/errors_test.go; sdk_test.go)*

## 11 · 订阅过滤器

- **11.1** 订阅过滤器是针对消息的单个 `expr` 布尔谓词，空过滤器匹配所有消息。它在 `Subscribe` 时编译并做类型检查。格式错误、引用未知字段或非布尔表达式，必须返回 `ErrInvalidFilter`（HTTP 400 `invalid_argument`），且**不**存储，也不创建支撑队列。*(engine/filter_test.go, server/errors_test.go)*
- **11.2** 过滤器在**发布时**针对消息环境求值：包括基础字段、`enqueued_at`/`visible_at`、派生的 `subject_parts`/`body_size`/`property_keys`，以及仅在引用时投影的正文 `body_text`/`body_json`。`body_json` 只在 JSON 内容类型时解码，否则为 `{}`。当且仅当过滤器返回 true，消息才路由到该订阅。
  `enqueued_at` 是发布时间，`visible_at` 是投递时间：立即发送时二者相等，延迟发送时后者是计划时间，因此延迟为 `visible_at - enqueued_at`。*(engine/filter_test.go `TestFilterFanoutConditions`,
  `TestFilterScheduledMessageDelay`)*
- **11.3** 求值采用**失败即不匹配**（fail-closed）策略：运行时报错或 panic 的过滤器，必须使消息不路由到该订阅，并记录错误；绝不使 broker 崩溃，也不默认视为匹配。*(engine/filter_test.go `TestEvalFilterFailClosed`)*
- **11.4** 向没有**任何**订阅过滤器接受的主题发布，是合法空操作；`SendOne`/`Schedule` 返回 `0, nil`，而非 `ErrDedupConflict`。
  *(engine/filter_test.go `TestFilterReSubscribeRecompiles`)*

## 12 · 主题与命名

- **12.1** 普通队列名、订阅名（即支撑队列名）和主题名构成**同一个互不重叠的命名空间**。每种冲突都必须在创建时双向以 `ErrNameConflict`（HTTP 409）拒绝：`Subscribe` 拒绝与任意已有 queues 行（普通或支撑队列）同名的主题，拒绝已属于普通队列、另一主题订阅或有效主题的订阅名，并拒绝 `topic == name`；`CreateQueue` 拒绝当前有效主题名及任何跨类型 upsert。同类型 upsert 仍允许，包括队列重配置和 `(topic,name)` 重新订阅。创建失败必须不留下任何内容，保护检查和插入属于同一事务。
  *(engine/functional_test.go: TestTopicQueueNamespaceDisjoint,
  TestTopicSubscriptionIsolation)*
- **12.2** 名称互不重叠，因此发送/发布解析**没有歧义**：有效普通队列或支撑队列名定位该队列，隐式主题名定位其有效订阅行，其他名称返回 `ErrQueueNotFound`。直接改动内部表造成队列/主题名称冲突后的行为，不属于公开契约。
  *(engine/functional_test.go: TestTopicQueueNamespaceDisjoint)*
- **12.3 订阅生命周期。** 删除必须选择准确的 `(topic,name)` 对。默认必须对任何保留消息状态返回 `ErrSubscriptionNotEmpty`；force 是丢弃全部状态的持久授权。接受删除必须原子地将支撑队列排除出扇出和数据平面，并启动有界清理。清理若在接受事务中完成，必须移除队列与映射并返回 `deleted`；否则必须提交 `deleting` 标记，保留映射和名称直到后续事务共同移除。重启必须恢复已接受而未完成的清理，无需再次 force 授权。最后一个有效订阅退役，立即使其隐式主题不可用。
- **12.4 有界清单。** 兼容的 `ListSubscriptions` 操作必须按 `(topic,name)` 顺序返回所有有效订阅。分页操作必须使用同一顺序，默认每页 100，拒绝大于 1,000 的限制，返回当前请求范围的准确总数，并可选包含正在删除的条目。每个分页行都必须携带必填非负的 `created_at_ms` 和 `expires_at_ms`；到期为零表示永久，正到期时间必须大于创建时间。已过期但物理保留的行，在逻辑上属于正在删除。其不透明游标必须绑定主题与 include-deleting 范围。一次请求提供一致快照；并发变更下，作为独立请求的各页不承诺共享冻结快照。
- **12.5 容量。** 引擎必须限制有效和正在删除的订阅总数，默认 10,000。达到上限后，新映射创建返回 `ErrSubscriptionLimit`（HTTP 429 `resource_exhausted`）；重新订阅有效的精确名称对仍可更新过滤器。正在删除的条目必须保留名额至最终物理清理完成。公开 `CreateQueue(kind=subscription)` 不得创建没有订阅映射的支撑队列。
- **12.6 固定订阅存续期。** 正的创建 TTL 必须从首次成功事务起保存一个绝对截止时间。新订阅省略或使用零 TTL 时永久存在，已有订阅则保留原存续期。同一正 TTL 幂等，不同正 TTL 必须在改变过滤器前返回 `ErrNameConflict`。重试、过滤器更新、消息活动和重启都不得延长截止时间。`now >= expires_at` 时，扇出和每个直接数据平面效果都必须拒绝该订阅，包括使用缓存元数据的路径。锁与 long-poll 必须不晚于截止时间结束，Renew 不得延长它，幂等记录也不得授权此后的工作。
  *(engine/functional_test.go, engine/engine_test.go,
  engine/complete_batch_test.go; sdk_test.go; server/subscriptions_test.go)*
- **12.7 到期清理。** 到期是提前持久授权丢弃所有保留消息状态。带索引的扫描器必须将到期订阅移入已有、可跨重启恢复的删除生命周期，正确性仍独立于扫描时序。空订阅仅可在映射与支撑行于同一事务中删除、且受影响行数准确时使用集合式清理，包括关闭外键时。有内容的订阅继续受全局行数、字节数和公平性限制，每个仍保留的条目在物理删除前继续占用容量名额。*(engine/lifecycle_test.go,
  engine/storage_test.go)*

## 13 · 取消：context 截止时间

取消调用不是*撤销*操作的方式，本地存储中也不是调节延迟的手段。下列规则构成完整契约；它们写在这里，而不仅是更新日志中，因为调用方能够观察到每一项。

- **13.1** context 已取消的 mqlite 操作不得执行任何工作。这在两个边界都适用：等待写入者之前，以及取得连接之后；也适用于进入本地 `Tx` 回调之前。
  *(engine/cancel_test.go: TestPreCancelledNeverExecutes,
  TestCancelInTheHandoffWindowStartsNothing, TestNothingBeginsInTheLastWindowBeforeAStatement;
  sdk_test.go: TestEmbeddedTxCancellation)*
- **13.2** 等待唯一写入者的调用方保留自身截止时间；排队期间取消，必须及时返回且不得产生任何变更。
  *(engine/cancel_test.go: TestCancelWhileWaitingWritesNothing)*
- **13.3** **本地**存储（文件或 `:memory:`）中，已经开始的语句必须允许执行完毕，不被中断，且**执行时长没有上限**。`EngineTx.SQL()` 可以运行任意用户 SQL，完整 `VACUUM` 会重写文件，大型 `Purge` 是一次大型 `DELETE`。因此，调用方放弃等待后，写入仍可能提交。这是有意选择：中断本地语句会泄漏驱动连接，导致文件数据库永久锁住（`SQLITE_BUSY`），或直接销毁 `:memory:` 数据库。*(engine/cancel_test.go: TestCancelStormLeavesTheDatabaseUsable,
  TestCancelledSettleWritesLeaveTheDatabaseUsable)*
- **13.4** 本地事务内，**mqlite 自有语句**（包括 `EngineTx.SendOne`）在每条语句前检查调用方 context：已运行的语句完成，但检查时发现取消的语句不得开始。`EngineTx.SQL()` 在这些保护之外暴露原始 `*sql.Tx`，供调用方自有表使用；直接修改 mqlite 自有表不属于支持的契约。原始语句必须使用 `tx.Context()`，避免中断本地 SQLite；该 context 有意不可取消，因此调用方取消后原始 SQL 仍可能执行。调用方必须在自己的语句之间检查原始 context，并及时返回。mqlite 不能中断回调，也不能在回调返回前释放单写入者。回调结束后、提交前观察到取消，必须回滚整个事务，包括原始 SQL 写入，即使回调返回 nil。
  *(engine/cancel_test.go: TestCancelledTransactionStopsIssuingStatements,
  TestTxCancelledBetweenStatementsRollsBack; sdk_test.go: TestEmbeddedTxCancellation)*
- **13.5** **远程** Turso/libSQL 存储的语句取消是真实有效的，行为不变；这些语句确实可能阻塞于网络，而丢弃远程连接不持有本地锁。
- **13.6** 由 13.3 可知，丢失响应绝不意味着“操作没有发生”。取消不改变至少一次契约，应核对结果，而非作出假设。

## 14 · 并发不变量

这些性质无法由用户绕过，必须在真实并行条件下验证，而非让引擎自我评判；存在缺陷的引擎也可能报告一切正常。

- **14.1 排他投递。** 消费者持有消息的**有效**锁时，该消息不得投递给其他人。排他性*就是*租约：超过 `locked_until` 后，持有者不再拥有任何权利，此时重投是至少一次契约的正常工作方式，而非违约。
  *(engine/concurrency_test.go: TestConcurrentConsumersNeverShareAMessage)*
- **14.2 隔离必须真正生效。** 锁过期且消息重新分配后，旧持有者的结算必须被拒绝（`ErrLockLost`），新持有者的结算必须成功。“恰好一个胜出者”还不够，胜出者必须是有效锁持有者。
  *(engine/concurrency_test.go: TestConcurrentSettlementPicksExactlyOneWinner)*
- **14.3 不得再次投递已完成消息。** 完成的消息不得再次投递。
  *(engine/concurrency_test.go)*
- **14.4 并发工作负载不丢消息。** 在发送成功、消费者存活、投递预算充足，且没有配置丢弃或到期的条件下，每个已发送身份都必须完成。这不覆盖最后尝试进入 DLQ、显式删除、保留策略、消息 TTL 或固定订阅到期。
  *(engine/concurrency_test.go)*
- **14.5 关闭必须隔离存储。** `Close` 首先关闭准入：关闭开始后才发起的数据库工作必须立即以 `ErrClosed` 失败；已经准入的语句、行扫描、事务回调或正在提交的操作，必须在文件锁释放前完成，期间第二次 `Open` 同一文件必须被拒绝（`ErrDBLocked`）。空 long-poll `Receive` 必须以 `ErrClosed` 唤醒，而非对已关闭引擎继续等完轮询窗口。不得在 `Tx` 回调内调用 `Close`：它会等待回调，形成死锁。
  *(sdk_test.go: TestEmbeddedCloseWaitsForPublicTx · engine/storage_test.go:
  TestCloseWaitsForInFlightWritesBeforeReleasingTheLock, TestCloseWakesLongPollWaiters)*

## 15 · 崩溃恢复：进程终止

通过在真实进程事务执行中途强制终止它（SIGKILL / TerminateProcess，不做清理或 flush）、重启并检查存续内容来验证。这覆盖进程终止，**不覆盖断电**：强杀不会丢失操作系统已经接受的数据，验证的是应用级恢复，而非文件系统耐久性。

- **15.1 跨崩溃的发件箱原子性。** 同时写入业务行和消息入队的事务，必须两者均提交或均不提交。恢复后，业务行集合与消息集合精确对应：不能有订单而无消息，也不能有消息而无订单。各崩溃模式准确证明的内容如下：
  - *协调模式（确定性）*：每轮都在事务的**两次写入之间**保持事务打开并使生产者崩溃，因此每轮都能检测回调被拆断，或发件箱被拆成两个事务的情况。
  - *随机模式（活动确定、落点概率性）*：每次终止都受流顺序证据**约束**，要求挑战之后的两个 ACK，其中一个折抵为可能属于挑战前的迟到响应。因此在任何主机上，**每个**终止窗口都可证明包含一次存活性挑战之后的提交。该证据是发出终止的等待条件，而不是可能误伤慢 runner 的吞吐量下限；每个窗口的计数会记录。正常负载主机上，证据远早于终止计时器就已具备，因此终止仍完全由计时器驱动。冻结的工作循环无法产生证据，会确定性失败。终止在活跃流中的具体**落点**仍是概率性的；恰好落入假设的两次*提交*间隙只是补充覆盖，不是每轮保证。

  *(test/crash/crash_test.go: TestCrashOutboxAtomicity)*
- **15.2 启动恢复尊重租约所有权。** `Open` 默认保留有效资源上的未过期锁，包括令牌和投递计数，使持有者能跨另一个进程打开存储继续操作；缓存的 Peek-Lock attempt 可以重放同一有效令牌。租约到期后，启动将其回收为 `active`；若是最后允许投递，则以 `MaxDeliveryCountExceeded` 为原因移为 `dead_lettered`，规则与 reaper 相同，见第 3.1 节。缓存 attempt 不得重放被该恢复失效的令牌；重试要么获得当前有效的新租约，要么看到没有可用消息。显式嵌入式有效租约恢复会立即执行同一转换，在 broker 模式中无效。
  *(test/crash/crash_test.go: TestCrashRecoveryResetsOrphanedLocks,
  TestCrashRecoveryDeadLettersLastDelivery,
  TestCrashRecoveryInvalidatesReceiveAttemptLease; engine/functional_test.go:
  TestReceiveAttemptDoesNotReplayStaleLeaseAfterRestart,
  TestReceiveAttemptDoesNotReplayDeadLetteredLeaseAfterRestart;
  engine/engine_test.go: TestOpenPreservesUnexpiredLeaseByDefault,
  TestOpenReclaimsExpiredLeasesByDefault; shutdown_internal_test.go:
  TestReceiverSurvivesBrokerRestart)*
- **15.3 已确认提交必须跨恢复保留。** 测试程序在终止前已接收并观察到确认的每次生产者提交，恢复后必须仍存在。测试程序用这些已确认事务身份，同时核对恢复的业务行和消息。未观察到回执的提交仍受第 15.1 节全有或全无检查约束。*(test/crash/crash_test.go: TestCrashOutboxAtomicity)*

运行：`make crash`，启用 race detector，受构建标签控制；由独立 Linux CI 任务执行，不属于默认包矩阵。

---

*非 SQLite 存储后端（参见 Store 接口研究）若要成为符合规范的 mqlite，就必须满足本规范约定。封闭的包测试在操作系统/Go 版本矩阵中带 `-race` 运行；受构建标签控制的崩溃测试在独立 Linux 任务中带 `-race` 运行。真实 Turso 测试单独运行，不带 `-race`；大规模无丢失验证也每周运行，不带 `-race`。*
