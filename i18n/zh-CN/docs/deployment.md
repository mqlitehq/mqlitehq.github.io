# 部署 mqlite

mqlite 以**一个纯 Go 二进制**（或一个容器镜像）管理**一个 SQLite 文件**
（或一个远程 Turso 数据库）。它既可嵌入你的进程，也可作为网络 broker 运行——
本指南介绍 broker（`mqlite serve`）。选择部署目标：

- [Docker / GHCR](#docker--ghcr)——最快上手；使用已发布的多架构镜像。
- [Fly.io](#flyio-minimal-cost)——低成本、可缩容至零的方案。
- [systemd](#systemd-bare-metal)——在虚拟机上运行单个二进制。
- [Turso](#turso-remote-libsql)——使用远程复制存储替代本地卷。
- [生产运维](operations.md)——备份、恢复、升级和故障处置。

## 配置（适用于所有目标）

所有配置均从环境变量读取——数据库连接字符串绝不编译进二进制。

| 环境变量 | 含义 |
|---|---|
| `MQLITE_DB` | `file:/data/mq.db`（本地）或 `libsql://<db>.turso.io`（远程） |
| `MQLITE_DB_AUTH_TOKEN` | 远程 libSQL/Turso DSN 的身份验证 token |
| `MQLITE_TOKENS` | 逗号分隔的管理员 Bearer token（**生产环境必须设置**） |
| `MQLITE_MONITOR_TOKENS` | v0.3.2+：可选的逗号分隔凭据，仅用于 `Observe` 和 `/metrics`；要求启用身份验证，并配置独立的管理员凭据 |
| `MQLITE_METRICS` | v0.3.2+：按需启用 API 端口上需要身份验证的 `/metrics`；`on`/`true`/`1` 启用，`off`/`false`/`0` 禁用（默认）；要求启用管理员身份验证 |
| `MQLITE_SYNC` | 耐久性：`NORMAL`（默认）/ `FULL` / `OFF` / `EXTRA`（仅本地文件）；启动时拒绝无法识别的值 |
| `MQLITE_MAX_SUBSCRIPTIONS` | v0.4.0+：active 加 deleting 订阅总容量（默认 10,000）；等待清理的订阅继续占用槽位 |
| `MQLITE_DLQ_MAX_AGE` · `MQLITE_DLQ_MAX_COUNT` · `MQLITE_DLQ_MAX_BYTES` | 异步 DLQ 保留目标（默认 14d／每队列 1,000,000 条；字节目标默认关闭；`MQLITE_DLQ_RETENTION=off` 禁用 broker 级默认值）——见 [retention.md](retention.md) |
| `MQLITE_MAX_MESSAGE_BYTES` | 拒绝超过此大小的正文（默认 1 MiB） |
| `MQLITE_UI` | 在 `/ui` 提供内嵌管理控制台（默认开启；`off` 为无界面运行） |

> **身份验证（默认安全）：** 未设置 `MQLITE_TOKENS` 时，`serve` **会生成随机 `mqk_…` token，
> 并在启动时打印**——broker 绝不会悄然处于无身份验证状态。
> 将 `MQLITE_TOKENS` 设为你自己的 token，可得到稳定的值（更新配置即可轮换）；
> 或设置 `MQLITE_TOKENS=off` 显式禁用身份验证——但此时 broker **拒绝绑定非 loopback 地址**：
> 必须显式绑定 `127.0.0.1`，或传入 `--insecure-allow-remote` 才能对外开放
> （身份验证关闭时，`MQLITE_CORS` 也默认关闭）。`/` 服务发现端点与 `/healthz` 保持公开，
> 启用时的静态 `/ui` 控制台也公开（其 API 调用仍携带 token）；其他请求都需要
> `Authorization: Bearer <token>`。

> **管理控制台：** broker 将静态 Web 控制台嵌入二进制，并在 `/ui` 提供服务
> （例如 `http://localhost:6754/ui`）——不需要单独的进程或 Node 运行时。
> 在控制台输入 broker URL 和 token，即可执行所有队列操作。
> 无界面部署可设置 `MQLITE_UI=off` 禁用控制台。

broker 默认监听 `:6754`（`mqlite serve --addr :6754`）。完整端点与错误说明见
[api-reference.md](api-reference.md)。

## Docker / GHCR

> **版本与升级兼容性。**
> 最新受支持版本为 **v0.4.2**，默认端口为 **6754**，schema token 为 **7**。
> 应固定使用准确的 v0.4.2 二进制或镜像，不要依赖会变动的镜像别名。
> v0.3.3 已撤回、不受支持，且由 v0.4.0 及后续版本声明撤回；
> 其公开产物和准确镜像仅供取证或兼容性检查，不得部署。
>
> v0.4.x 无法打开 v0.3.x 的 schema-5 数据库，也没有原地迁移方式。
> Schema 6 仅用于中间阶段未打标签的生命周期构建，同样会被拒绝。
> 保留匹配的 schema-5 二进制／数据库组合，制作一致备份，核对仍保留的工作，
> 并用全新数据库启动 v0.4.0。
> v0.4.0 也移除了[可观测性文档](observability.md#compatibility-and-v040-migration)
> 所述已弃用的 Prometheus 别名。
> **v0.2.0 使用端口 8080 和 schema token 2。**
> 替换它之前，请遵循[升级与回滚流程](operations.md#upgrade-and-rollback)。

v0.4.2 是基于 v0.4.1 的同 schema 补丁。
作用范围覆盖整个 broker 的 `listen` 密钥可以创建／更新订阅以及测试过滤器；
订阅清单和删除仍是 `manage` 操作。浏览器访问根路径且明确优先接受 HTML 时，
会进入已启用的控制台；curl 和 JSON 客户端仍然获得服务发现响应。
协议契约不变，无需重建数据库。

受支持的准确镜像为多架构镜像（amd64 + arm64）：

```bash
# v0.4.2, default port 6754
docker run -d --name mqlite -p 6754:6754 \
  -v mqlite-data:/data \
  -e MQLITE_DB=file:/data/mq.db \
  -e MQLITE_TOKENS=mqk_prod_CHANGEME \
  -e MQLITE_MONITOR_TOKENS=mqk_monitor_CHANGEME \
  -e MQLITE_SYNC=FULL \
  ghcr.io/mqlitehq/mqlite:0.4.2
```

- 命名卷 `mqlite-data` 使 SQLite 文件在重启后仍然保留。
- 生产环境固定使用准确的 `0.4.2`。镜像 `>= 0.3.0` 监听 `6754`；
  **`0.2.x` 及更早版本监听 `8080`**。
- 验证：`curl http://localhost:6754/`（服务发现卡片）和 `/healthz`。
  指标默认关闭。对于私有 broker，或已在入口阻断公开 `/metrics` 的部署，
  加入 `-e MQLITE_METRICS=on`，并向采集器提供监控 token。
  指标抓取使用相同的 API 端口；启用后的服务发现响应包含 `"metrics":"/metrics"`。
  控制台启用时，在浏览器打开根 URL 会重定向到 `/ui/`；
  curl 和 JSON 客户端继续获得服务发现卡片。

## Fly.io（低成本方案）

可缩容至零、单机器的方案——低成本的在线运行方式。保存为 `fly.toml`：

```toml
app            = "your-mqlite"
primary_region = "sin"            # pick a region near you

[build]
  image = "ghcr.io/mqlitehq/mqlite:0.4.2"   # latest supported exact image

[env]
  MQLITE_DB = "file:/data/mq.db"            # SQLite on the persistent volume
  MQLITE_SYNC = "FULL"                      # sync every acknowledged local commit

[[mounts]]
  source      = "data"                       # the volume created below
  destination = "/data"

[http_service]
  internal_port        = 6754
  force_https          = true
  auto_stop_machines   = "stop"             # fully stop when idle (cheapest)
  auto_start_machines  = true               # start on the next request
  min_machines_running = 0                  # scale to zero

[[vm]]
  size   = "shared-cpu-1x"                  # lowest shared CPU
  memory = "256mb"                          # lowest memory
```

```bash
fly apps create your-mqlite
fly volume create data --size 1 --region sin     # 1 GB SQLite volume (region-bound)
fly secrets set MQLITE_TOKENS=mqk_prod_CHANGEME \
                MQLITE_MONITOR_TOKENS=mqk_monitor_CHANGEME # broker secrets, not in fly.toml
fly deploy --ha=false                            # single machine
curl https://your-mqlite.fly.dev/                # discovery card
```

公开服务方案保持指标关闭。启用 `MQLITE_METRICS=on` 后，
`/metrics` 也会经由这个公开 HTTP 服务对外可达；
身份验证保护其内容，但不会将该路由变成私有路由。

若要在不增加另一台 Fly Machine 的前提下进行私有监控，移除 `[http_service]` 和
所有公开 `[[services]]` 条目，设置 `MQLITE_ADDR=fly-local-6pn:6754` 与
`MQLITE_METRICS=on`，通过 Fly 私有网络连接客户端和采集器。
在工作站执行 `fly proxy 6754:6754 --app your-mqlite` 可打开 loopback 隧道；
Prometheus 可使用监控 token 抓取 `http://127.0.0.1:6754/metrics`。
连接前先启动 Machine：直接私有访问不具备公开服务方案的自动启动行为。

若 API 必须保持公开，只有在现有入口确实阻断公开 `/metrics`、同时允许私有采集器访问时，
才启用指标；否则保持关闭。参见[云与 Kubernetes 监控](observability-cloud.md#flyio)，
以及 Fly 的[私有网络](https://fly.io/docs/networking/private-networking/)
和 [proxy](https://fly.io/docs/flyctl/proxy/) 参考文档。

**成本：** 设置 `auto_stop_machines="stop"` + `min_machines_running=0` 后，
机器仅在处理请求时运行（冷启动以秒计，空闲时停止），因此机器停止期间仍有空闲存储费用。
[benchmark.md](benchmark.md) 中的历史工作负载测得约 25–34 MB RSS；
这些数字不是其他负载或版本的内存上限。
应按当前消息大小、并发、队列数量和监控负载确定 broker 资源，
并在该流量下测量内存峰值。持续请求（包括监控）可能使机器保持运行。

## systemd（裸机部署）

构建或下载二进制，然后作为服务运行：

```bash
go build -o /usr/local/bin/mqlite ./cmd/mqlite   # or grab a release binary
```

`/etc/systemd/system/mqlite.service`：

```ini
[Unit]
Description=mqlite broker
After=network.target

[Service]
# Bind loopback: the reverse proxy below is the only public entry point, so the broker
# is not reachable on the LAN even without a firewall rule. Use --addr :6754 only if you
# deliberately want it on all interfaces (and then add a firewall rule).
ExecStart=/usr/local/bin/mqlite serve --addr 127.0.0.1:6754
Environment=MQLITE_DB=file:/var/lib/mqlite/mq.db
Environment=MQLITE_TOKENS=mqk_prod_CHANGEME
Environment=MQLITE_SYNC=FULL
Restart=on-failure
DynamicUser=yes
StateDirectory=mqlite          # creates/owns /var/lib/mqlite

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now mqlite
curl http://localhost:6754/healthz
```

任何公开服务前面都应部署终止 TLS 的反向代理（Caddy/nginx）；
代理连接 broker 的 `127.0.0.1:6754`，这是上面配置中 broker 唯一绑定的接口。
因此，代理（TLS 加你配置的访问控制）是唯一入口，
而不是架在全接口监听端口之前、却可以绕过的一层。

v0.3.1 及后续版本的运行时管理密钥可在不重启的情况下创建和撤销。
控制台和密钥管理使用已配置的管理员凭据或受管理的 `manage` 密钥；
应用使用 `send`/`listen`。
v0.3.2 及后续版本的只读指标抓取器或控制台监控视图，使用单独配置的 `MQLITE_MONITOR_TOKENS`。
这些凭据的变更通过修改配置并重启 broker 生效。
参见[密钥命令](cli.md#key-createlistrevoke--manage-persistent-access-keys)和
[密钥轮换](operations.md#key-rotation)。

## 备份、恢复与升级

请遵循[生产运维手册](operations.md#consistent-backups)，执行只读在线快照、离线目录复制、
隔离恢复验证和回滚。使用全新恢复目录，避免旧 WAL/SHM 文件附着到快照。

**v0.2.0 数据库使用 schema 2；v0.3.0/v0.3.1/v0.3.2 及已撤回的 v0.3.3 使用 schema 5；
v0.4.0、v0.4.1 和 v0.4.2 使用 schema 7。**
中间阶段未打标签的生命周期构建使用 schema 6。这些 token 之间没有原地迁移方式。
测试不同 token 前，先核对所有状态下保留的工作，保留旧二进制／数据库组合及一致备份，
并另建 v0.4.x 数据库。不要重写旧文件的 schema 标记。
在已打标签的 schema-5 系列内，v0.3.0 → v0.3.1 增加兼容的受管理密钥存储，
v0.3.1 → v0.3.2 则保持 schema 不变。`Observe` 和已配置的监控凭据要求 v0.3.2；
回滚时也要恢复兼容的监控配置。
进行 v0.4.x 全新数据库切换和指标名称迁移前，请遵循手册。
参见[升级与回滚](operations.md#upgrade-and-rollback)。

## Turso（远程 libSQL）

使用远程复制存储替代本地卷——仍是同一套引擎，无需管理本地磁盘。
将 `MQLITE_DB` 指向 libSQL URL，并传入 token：

```bash
MQLITE_DB=libsql://<db>.turso.io \
MQLITE_DB_AUTH_TOKEN=<jwt> \
MQLITE_TOKENS=mqk_prod_CHANGEME \
  mqlite serve
```

同一组环境变量可用于 Docker（`-e MQLITE_DB=... -e MQLITE_DB_AUTH_TOKEN=...`）或 Fly
（`fly secrets set MQLITE_DB_AUTH_TOKEN=...`）；数据位于 Turso，可移除 `[[mounts]]` 卷。
耐久性由 Turso 服务端负责——远程 DSN 会忽略 `MQLITE_SYNC`。
参见 [turso.md](turso.md)。

每个 Turso 数据库只能运行一个活跃的 MQLite broker 或嵌入式 `Engine`。
替换时先停止旧所有者，确认其进程已经退出，之后才能启动替代进程。
不支持让滚动替换中的新旧进程同时访问同一数据库。
远程连接池仅在单个 MQLite 进程内安全，不提供跨进程所有权控制。

## 验证部署

```bash
curl https://<host>/                       # discovery: {name, version, status, ...} (open)
curl https://<host>/healthz                # ok (open)
# authed round-trip:
T=mqk_prod_CHANGEME
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data '{"name":"orders","config":{}}' \
  https://<host>/mqlite.v1.AdminService/CreateQueue
```

## 生产环境检查表

- [ ] 已设置 `MQLITE_TOKENS`（身份验证开启）；通过更新配置轮换。
- [ ] 前面部署 HTTPS（Fly `force_https`，或 systemd/Docker 的反向代理）。
- [ ] 持久化存储容量覆盖**峰值**积压——删除后的页面立即可复用，
      本地 DB/WAL 文件则逐步缩小。空闲页至少为 256 页时，
      broker 每 60 秒最多回收 256 页
      （[retention.md](retention.md)）。
- [ ] 保持 DLQ 保留策略开启（默认），或按负载调整。
- [ ] 固定镜像／二进制版本，并记录校验和／digest。
- [ ] 对要求断电后仍保留的已确认本地提交，使用 `MQLITE_SYNC=FULL`。
- [ ] 每个数据库只有一个活跃 broker；替换期间不重叠运行。
- [ ] 已验证备份并演练恢复，满足应用的 RPO/RTO。
- [ ] 有剩余磁盘、重启／错误和队列年龄告警；有需要身份验证的写入／消费 canary。
- [ ] 启用 `MQLITE_METRICS=on`，在 API 端口抓取需身份验证的 Prometheus 指标；通过私有路由或公开入口路径过滤保持 `/metrics` 私有——参见 [observability.md](observability.md)。
