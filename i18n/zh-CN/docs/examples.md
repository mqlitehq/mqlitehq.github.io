# 示例

这些示例跟随 `main`，包含未发布行为。已安装 v0.4.2 时，请使用[该 tag 的示例](https://github.com/mqlitehq/mqlite/blob/v0.4.2/docs/examples.md)；待发布行为变更参见 [CHANGELOG.md](../CHANGELOG.md#unreleased)。

经认证的生产者/消费者凭据、Go SDK 密钥管理、控制台和 MCP 流程，参见[访问密钥](access-keys.md)（v0.3.1 及更新版本）。

四种 mqlite 使用方式的可复制运行示例：进程内**嵌入式**、**事务发件箱**（核心功能）、配合自动管理消费者的**远程**客户端，以及原始 **curl**。完整 API 见 [api-reference.md](api-reference.md)。

## 1. 嵌入式（进程内，无 broker）

一个 SQLite 文件，无网络，无第二个进程。

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/mqlitehq/mqlite"
)

func main() {
	ctx := context.Background()
	mq, err := mqlite.OpenEmbedded(ctx, "file:./mq.db")
	if err != nil {
		log.Fatal(err)
	}
	defer mq.Close()

	if err := mq.CreateQueue(ctx, "orders", mqlite.QueueConfig{
		LockDuration:     30 * time.Second,
		MaxDeliveryCount: 5,
	}); err != nil {
		log.Fatal(err)
	}

	// produce
	if _, err := mq.SendOne(ctx, "orders", mqlite.OutMessage{Body: []byte(`{"id":42}`)}); err != nil {
		log.Fatal(err)
	}

	// consume (Peek-Lock): receive, do work, then Complete
	msgs, err := mq.Receive(ctx, "orders", mqlite.RecvOpts{Max: 10, Wait: 5 * time.Second})
	if err != nil {
		log.Fatal(err)
	}
	for _, m := range msgs {
		fmt.Printf("got: %s\n", m.Body)
		// Alternatives: Abandon retries below max and sends a failed final attempt
		// to the DLQ; Reject sends directly to the DLQ.
		if err := m.Complete(ctx); err != nil {
			log.Fatal(err)
		}
	}
}
```

## 2. 事务发件箱（核心功能）

在**同一个** SQLite 事务中提交业务写入**与**消息入队：当且仅当业务变更提交时，消息才入队。没有双写竞态，也不需要独立的 outbox 轮询器。仅适用于嵌入式（同一数据库）。

在新目录中运行此演示一次：它创建 `app.db` 并插入固定示例订单 ID `42`。真实应用应提供自己的订单身份及重试/对账策略。

```go
package main

import (
	"context"
	"log"

	"github.com/mqlitehq/mqlite"
	"github.com/mqlitehq/mqlite/engine" // EngineTx + engine.OutMessage are used inside Tx
)

func main() {
	ctx := context.Background()
	mq, err := mqlite.OpenEmbedded(ctx, "file:./app.db")
	if err != nil {
		log.Fatal(err)
	}
	defer mq.Close()
	if err := mq.CreateQueue(ctx, "order-events", mqlite.QueueConfig{}); err != nil {
		log.Fatal(err)
	}

	// Initialize this example's application-owned table. Real applications can
	// create their business schema through their normal migration process.
	if err := mq.Tx(ctx, func(tx *engine.EngineTx) error {
		_, err := tx.SQL().ExecContext(tx.Context(),
			`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)`)
		return err
	}); err != nil {
		log.Fatal(err)
	}

	// Your app tables live in the same DB. Tx gives you that transaction.
	err = mq.Tx(ctx, func(tx *engine.EngineTx) error {
		// 1) the business write, on the SAME transaction. Use tx.Context(), NOT the ctx you
		//    passed to Tx: on a local store, cancelling a statement mid-transaction leaks the
		//    SQLite connection and wedges the database.
		if _, err := tx.SQL().ExecContext(tx.Context(),
			`INSERT INTO orders(id, total) VALUES(?, ?)`, 42, 1999); err != nil {
			return err // rollback: nothing enqueued
		}
		// 2) enqueue in the same tx — commits atomically with the write above:
		_, err := tx.SendOne("order-events", engine.OutMessage{Body: []byte(`{"order":42}`)})
		return err
	})
	if err != nil {
		log.Fatal(err)
	}
	// Either both happened, or neither did.
}
```

本地事务的 `tx.Context()` 刻意不可取消。原始 `tx.SQL()` 语句在最初调用方取消后仍可能执行：应在业务语句间检查 `ctx.Err()` 并及时返回。Mqlite 自己的语句（如 `tx.SendOne`）有独立检查。提交前观察到取消时，即使回调返回 nil，也会回滚此事务的全部写入。原始 SQL 仅用于调用方拥有的表；不支持直接修改 mqlite 内部表。参见[取消契约](conformance.md#13--cancellation-context-deadlines)。

## 3. 远程客户端与自动管理消费者

通过 HTTP 连接运行中的 broker。`Receiver` 运行托管消费循环：返回 `nil` → Complete，返回错误 → Abandon（低于最大次数时重投，最后一次尝试失败则进入 DLQ），并提供自动续锁和可配置并发。

本例核心调用也适用于 MQLite Remote Client for Go，即仅标准库、仅远程的配套模块。安装 `github.com/mqlitehq/mqlite-go@v0.1.1`，将导入改为 `mqlite "github.com/mqlitehq/mqlite-go"`。它的源码下限为 Go 1.13。同一应用还需要嵌入式、`Observe` 或托管访问密钥管理时，使用下面展示的主模块。

```go
package main

import (
	"context"
	"log"

	"github.com/mqlitehq/mqlite"
)

func main() {
	ctx := context.Background()
	cli, err := mqlite.Open(ctx, "https://your-mqlite.fly.dev", mqlite.WithToken("mqk_prod_xxx"))
	if err != nil {
		log.Fatal(err)
	}
	defer cli.Close()

	// produce
	if _, err := cli.SendOne(ctx, "orders", mqlite.OutMessage{Body: []byte("hi")}); err != nil {
		log.Fatal(err)
	}

	// nil -> Complete; error -> Abandon (retry below max; DLQ at max).
	// Auto-renew the lock; run up to 4 handlers concurrently.
	err = cli.Receiver("orders", mqlite.WithAutoRenew(), mqlite.WithConcurrency(4)).
		Run(ctx, func(ctx context.Context, m *mqlite.Message) error {
			return process(ctx, m.Body) // honor cancellation; MUST stay idempotent
		})
	if err != nil {
		log.Fatal(err)
	}
}

func process(ctx context.Context, body []byte) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		log.Printf("got: %s", body)
		return nil
	}
}
```

`WithAutoRenew` 保持当前交付尝试有效，不消耗另一次 `delivery_count`。每次成功续锁保留“现有租约截止时间”和 broker 新计算的 `now + lock_duration` 候选值中的较晚者（受固定订阅到期时间限制），而不是给旧截止时间叠加时长。请求必须在现有租约到期前到达，且不能延长消息 TTL 或固定订阅寿命。已知租约仍留有时间时，Receiver 会重试瞬时续锁失败。前一响应测得往返开销不可忽略时，它会提前发起，为保守的本地截止时间留下传输余量。若精确确认的租约短于最小安全节奏，或续锁被拒绝、无法在该截止时间前确认，它会取消单条 处理函数 context，并跳过该陈旧交付的 Complete/Abandon。Handler 必须遵守 `ctx.Done()` 且保持幂等：失锁后其他消费者可能收到消息。处理函数返回后，所选的 Complete 或 Abandon 请求共享一个 30 秒确认预算，包含续锁交接、首次结算尝试、回执丢失后的完全相同请求重放，以及退避。每次结算请求最多十五秒，并受剩余总预算限制；broker 的精确结算回执使重放安全，无需再次调用处理函数。单个无响应请求最多用掉初始总窗口的一半；其重试受剩余预算限制，不保证再获得完整十五秒。瞬时故障导致确认预算耗尽时，`WithErrorHandler` 收到 `ErrOutcomeUnknown`，并为 `errors.Is`/`errors.As` 保留最终原因。预算本身不会延长租约。启用自动续锁时，心跳会在同一个有界确认阶段内保护该投递。取消 `Run` 后，仍会等待已返回处理函数的终结确认完成。续锁交接、取消，以及结算请求发出前预算已到期的行为，见[消费者停止契约](operations.md#consumer-stops-and-host-interruptions)。Broker 或中间层返回 HTTP 499 时，只要 Receiver 自身 context 仍有效，就会使用相同 Receive 尝试 ID 重试。若代理同时移除 `X-Mqlite-Server-Time-Ms` 与 HTTP `Date`，`WithErrorHandler` 会收到一次时钟降级诊断。

## 4. 主题订阅生命周期

高频请求/回复流量使用一个稳定订阅，在消费者内按全局唯一的 `correlation_id` 分发回复。每个请求创建订阅会给唯一写入者增加元数据与清理工作。

对于远程 broker，下面两个客户端应分别使用 `listen` 和 `manage` 密钥打开。订阅创建/过滤器更新属于应用操作；broker 范围清单和两种删除模式仍属于管理操作。

```go
listener, err := mqlite.Open(ctx, endpoint, mqlite.WithToken(listenerToken))
if err != nil {
	log.Fatal(err)
}
defer listener.Close()
manager, err := mqlite.Open(ctx, endpoint, mqlite.WithToken(managerToken))
if err != nil {
	log.Fatal(err)
}
defer manager.Close()

if err := listener.Subscribe(ctx, "replies", "checkout-instance-7", nil); err != nil {
	log.Fatal(err)
}

// For a genuinely temporary listener, TTL is the cleanup path. It is fixed at
// first creation; a manager may explicitly retire the subscription earlier.
if err := listener.SubscribeWithOptions(ctx, "replies", "checkout-request-01J...", nil,
	mqlite.SubscribeOptions{TTL: 15 * time.Minute}); err != nil {
	log.Fatal(err)
}

page, err := manager.ListSubscriptionsWithOptions(ctx, mqlite.ListSubscriptionsOptions{
	Topic: "replies",
	Limit: 100,
})
if err != nil {
	log.Fatal(err)
}
log.Printf("subscriptions=%d first-page=%d", page.Total, len(page.Subscriptions))

// Empty-only by default. Drain and settle retained replies before retirement.
if err := manager.DeleteSubscription(ctx, "replies", "checkout-instance-7"); err != nil {
	log.Fatal(err)
}
```

有意丢弃时，调用 `DeleteSubscriptionWithOptions` 并提供 `mqlite.DeleteSubscriptionOpts{Force: true}`。Force 可以丢弃已经发生外部副作用的持锁工作。操作可能以 `deleting` 结束；应继续拥有该全局唯一、一次性名称，并通过 `IncludeDeleting: true` 的分页清单对账。传输结果未知后不要重放破坏性请求。到达固定截止时间时，临时订阅立即不可用，到期预先授权强制清理。使用全局唯一、只用一次的名称；物理清理后，同名创建开始新寿命，而仅按名称寻址的 API 无法区分它与延迟到达的旧重试。

## 5. curl（原始 HTTP）

任何语言都可操作 broker：每个操作一次 POST。（`body` 使用 base64。）


```bash
HOST=https://your-mqlite.fly.dev
T=mqk_prod_xxx

curl $HOST/                                   # discovery (open, no auth)

curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data '{"name":"orders","config":{}}' \
  $HOST/mqlite.v1.AdminService/CreateQueue

curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data "{\"queue\":\"orders\",\"messages\":[{\"body\":\"$(printf hi | base64)\"}]}" \
  $HOST/mqlite.v1.QueueService/Send

# receive -> returns seq_number + lock_token
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data '{"queue":"orders","max_messages":1,"wait_time_ms":5000}' \
  $HOST/mqlite.v1.QueueService/Receive

# complete with the lock_token from the receive
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data '{"queue":"orders","seq_number":1,"lock_token":"<token>"}' \
  $HOST/mqlite.v1.QueueService/Complete
```
