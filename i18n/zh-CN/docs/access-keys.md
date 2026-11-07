# 访问密钥

运行时访问密钥从 **v0.3.1 及更新版本**开始提供。v0.3.0 只支持配置的管理员 token。

## 选择权限

| 权限 | 操作 |
|---|---|
| `send` | 发送、定时发送和取消定时消息 |
| `listen` | 接收、结算、续锁、浏览、读取队列统计，以及创建/更新订阅和测试过滤器 |
| `send` + `listen` | 两种应用角色 |
| `manage` | 两种应用角色，以及队列管理、订阅清单/删除、控制台、指标和密钥签发/撤销（包括其他 `manage` 密钥） |

权限覆盖整个 broker，不限制到单个队列。`listen` 密钥可通过完成消息或 receive-and-delete 删除已消费消息，因此不是只读审计角色。`send` 密钥可取消其他生产者的定时消息。应用需要更强的隔离边界时，应使用独立 broker。

`Subscribe` 是 broker 范围的 创建或更新（upsert），不是按所有权限定的创建。`listen` 密钥可创建永久或固定寿命订阅，并更新任何已知 `(topic,name)` 对的过滤器，因此可以占用订阅容量并增加发布 扇出。它不能列举或显式删除订阅；仅空删除和强制删除都需要 `manage`。给只有 listen 权限的临时订阅设置固定 TTL，作为清理兜底；提前退役由管理者完成。订阅 TTL 在创建时固定，listener 不能为已有订阅追加或修改到期时间。

`MQLITE_TOKENS` 中的密钥仍是管理员。应保留一个配置的管理员以便恢复。已有配置 token 字符串仍然有效；每个新生成的 token 使用 `mqk_` 加 64 个小写十六进制字符。Broker 只存储托管 token 的 SHA-256 摘要，以及公开 ID、名称、权限和生命周期时间戳。名称不必唯一。

**v0.3.2 及更新版本**的只读监控，请在管理员认证之外配置独立的 `MQLITE_MONITOR_TOKENS`。这些凭据只允许 `Observe` 和 `/metrics`，包括控制台监控视图；不能读取消息正文、消费、发布或管理密钥。`monitor` 是配置能力，不是托管密钥权限。存储故障期间，它不依赖密钥数据库仍能工作。配置与轮换参见[监控入门](observability.md)。

托管认证为每次请求执行一次索引数据库查询，不缓存凭据。使用 Turso 时还包含一次远程往返；部署容量规划前，应使用预期凭据和存储位置测量应用请求延迟与吞吐量。

## 创建和使用密钥

启动启用认证的 broker，再使用秘密管理系统提供的管理员凭据连接 CLI：

```sh
export MQLITE_ENDPOINT=http://127.0.0.1:6754
# Set MQLITE_TOKEN securely to a configured administrator or managed manage key.
mqlite create-queue orders
mqlite key create --name orders-producer --permissions send --output json
mqlite key create --name orders-worker --permissions listen --output json
```

安全保存每个返回的 `token`。它只在成功创建时显示，无法通过列表或重复创建找回。将生产者的 `send` token 设置为 `MQLITE_TOKEN`，再运行 `mqlite send orders 'hello'`；将 worker 的 `listen` token 设置好后运行 `mqlite receive orders`。Worker 命令默认打印并完成消息。

每次创建都有独立的公开 `id`（32 个小写十六进制字符）。CLI 在发请求前生成它，也接受 `--id`。可选 `--expires-at-ms` 设置未来的 UTC 纪元毫秒到期时间；零表示不过期。

使用管理员执行 `mqlite key list --output json`。分页通过 `--after-id` 传入上一页的 `next_after_id`；默认每页 100，最大 1000。列表包含过期和已撤销元数据，不含秘密值或摘要。配置 token 由配置管理，不会显示在此列表。CLI 默认按公开 ID 排序。使用 `mqlite key list --sort created_desc --output json` 可按最新优先，后续页保留 `--sort created_desc`。创建时间相同时按公开 ID 降序。

## Go SDK

`Client` 与 `Embedded` 都提供 `CreateKey`、`ListKeys`、`ListKeysWithOptions` 和 `RevokeKey`。嵌入式管理属于受信任的本地访问，需要独占本地数据库。管理运行中的 broker 应使用 `Client`。

```go
id := mqlite.GenerateKeyID() // retain this public ID before the request
created, err := admin.CreateKey(ctx, mqlite.CreateKeyOptions{
    ID: id, Name: "orders-producer", Permissions: []string{"send"},
})
if err != nil {
    // Preserve id; reconcile an ambiguous result before issuing a replacement.
    return fmt.Errorf("create key %s: %w", id, err)
}
// Store created.Token in your secret manager; never log the result struct.
producer, err := mqlite.Open(ctx, endpoint, mqlite.WithToken(created.Token))
if err != nil {
    return err
}
defer producer.Close()
_, err = producer.SendOne(ctx, "orders", mqlite.OutMessage{Body: []byte("hello")})
```

将 `page.NextAfterID` 传入下一次 `ListKeys(ctx, afterID, limit)`，直到它为空。此方法保持公开 ID 顺序。需要最新优先分页时，使用 `ListKeysWithOptions(ctx, mqlite.ListKeysOptions{Sort: "created_desc", Limit: 100})`，后续页把 `AfterID` 设置为返回的游标，保持相同 `Sort`。通过 `RevokeKey(ctx, id)` 撤销托管密钥。凭据缺失/无效/被撤销/过期时，SDK 返回 `ErrUnauthenticated`；权限不足返回 `ErrPermissionDenied`。`Receiver.Run` 遇到这些永久认证/授权失败会停止，包括结算和续锁路径。

## HTTP、控制台与 MCP

三个 HTTP 操作为 `AuthService/CreateKey`、`ListKeys` 和 `RevokeKey`。参见完整[请求/响应契约](api-reference.md#createkey--listkeys--revokekey)。均需 `Authorization: Bearer <administrator-token>`。通过 `MQLITE_TOKENS=off` 关闭认证不会开放匿名密钥管理。

`/ui/` 控制台接受配置的管理员或托管 `manage` 密钥来进行管理；配置的监控凭据只开放可观测性视图。打开 **访问密钥（Access keys）** 以创建、检查和撤销凭据。关闭一次性显示前，先保存新秘密值。旧 broker 不支持此功能时，控制台会说明。应用的 `send`/`listen` 密钥用于客户端，不用于管理控制台。

**托管密钥（managed keys）** 列表跨所有分页按最新优先显示运行时签发的访问密钥。创建密钥后返回第一页；相同创建时间使用公开 ID 降序作为稳定的次级排序。配置的 `MQLITE_TOKENS` 管理员通过修改配置并重启 broker 更新。到期输入使用本地时间、`yyyy-MM-dd HH:mm` 格式和英文日历，不随浏览器语言变化；列表时间戳包含秒。

MCP 服务提供 `create_key`、`list_keys` 和 `revoke_key`。为其 `MQLITE_TOKEN` 配置各工具所需的权限。创建密钥需要在调用前分配公开 ID。参见 [MCP 使用](mcp.md)；不要将新秘密值粘贴到提示词、工具日志或生成的源码中。

## 轮换、撤销与恢复

1. 创建替代密钥并保存其秘密值。
2. 将应用切换到替代密钥，验证完整的发送/接收/结算周期。
3. 使用 `mqlite key revoke --id <old-id>` 撤销旧公开 ID。

不需要重启。撤销是永久的，重复撤销也会成功。撤销成功后，新的认证立即失败；已经授权的请求（包括长轮询）仍可完成。后续结算/续锁请求会重新认证。由其他密钥签发的密钥彼此独立：撤销签发者不会连带撤销它们。管理员可以撤销自身；操作前应保留另一个管理员。

保留 broker 访问日志时，成功创建和撤销记录会包含目标公开密钥 ID 及调用方的安全 actor 分类。与配置的静态凭据相同的值会被省略，即使语法上是合法公开 ID，或本来会成为 actor ID。托管调用者通过自己的公开密钥 ID 标识；配置的管理员 token 没有公开 ID。秘密值和 token 摘要绝不是日志字段。参见[访问日志保留与限制](observability.md#access-logs-and-destructive-operation-evidence)。

创建响应丢失时，保留原公开 ID，并以管理员身份列出密钥查找它。如果存在但未保存秘密值，应撤销它，再用新 ID 创建替代密钥。重复 ID 返回 `409 key_conflict`，绝不重放秘密值。超时或 `unavailable` 响应不能证明创建失败；客户端不能盲目换新 ID 重试。

明确存在于 `MQLITE_TOKENS` 的 token 始终是管理员，即使同一个托管记录受限、已撤销或已过期。移除静态配置并重启后，才能移除这项配置授权。轮换配置 token 时，可暂时同时接受新旧值，切换客户端后移除旧值，并再次重启。

备份包含托管密钥状态。恢复旧快照可能恢复旧撤销状态，或丢弃较新的凭据。重新开放流量前，用配置的管理员检查密钥。参见[备份与升级流程](operations.md)。

