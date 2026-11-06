# 云与 Kubernetes 监控

这些示例要求 **MQLite v0.3.2 或更高版本**，包括已配置的监控凭据和规范指标族。

设置 `MQLITE_METRICS=on` 后，MQLite 在 API 端口暴露原生 Prometheus 指标；默认关闭。
同一套仪表盘和指标定义可配合私有 Prometheus 采集器或兼容的托管服务使用。
broker 指标必须保持身份验证：配置独立的 `MQLITE_MONITOR_TOKENS` 凭据，
仅将该凭据交给采集器，监控配置中不要放入管理员凭据。
指标契约和可直接运行的本地栈见 [observability.md](observability.md)。

## 通用集成方式

```text
MQLite :6754/metrics <-- private route + monitor Bearer token -- collector
                                                          |
                                              Prometheus-compatible storage
                                                          |
                                               existing Grafana + rules
```

1. 将采集器部署在 broker 的私有网络中，或提供仅批准的采集器可达的 TLS 路由。
   配置正确的 CA，不要禁用 TLS 证书校验。启用 `MQLITE_METRICS=on`。
   API 和指标共用一个端口，因此要阻止公网访问 `/metrics`，必须让 broker 仅在私网可达，
   或在公开入口按路径过滤。端口级防火墙不能区分 HTTP 路径，Bearer 身份验证也不会隐藏路由。
2. 将目标配置为 broker API 端口（默认 `6754`）的 `/metrics`，
   初始抓取间隔可设为 15 秒，抓取超时应更短。使用密钥文件或采集器的密钥引用，
   不要将凭据放入目标 URL、标签或仪表盘 JSON。
3. 验证 `up{job="mqlite"} == 1` 和 `mqlite_collection_success == 1`。
   仅抓取成功不能证明数据库可用，也不能证明业务处理成功。
4. 导入[标准仪表盘](../ops/observability/grafana/dashboards/mqlite.json)，
   选择平台数据源，并使用[规则组](../ops/observability/prometheus/rules.yml)。
   保留 `job="mqlite"` 标签，或有意识地按采集器配置调整规则。
5. 单独配置平台的通知接收端，并测试通知投递。
   告警规则触发只证明条件已完成求值，不能证明邮件或呼叫通知已送达。

[现有 broker 抓取任务](../ops/observability/prometheus/existing-broker.example.yml) 是可复用的起点。
Prometheus 通过 `credentials_file` 支持 Bearer 授权；云控制台可能提供不同的密钥绑定机制。
除非托管服务确实挂载了该文件，否则不要将本地文件系统路径粘贴进托管服务。
[Prometheus 配置参考](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)。

## 阿里云：ECS 或 ACK

对于 ECS，托管 Prometheus 服务支持采集其采集器能够访问的应用端点。
将采集器放入正确的 VPC，为私有 broker 地址和端口配置自定义指标采集。
安全组仅允许采集器实际来源网络访问，不需要公开暴露指标端口。
官方指南也覆盖同一 VPC 内可达的非 ECS 机器。
[阿里云应用指标采集](https://www.alibabacloud.com/help/en/cms/cloudmonitor-2-0/collect-application-metrics-of-ecs-deployment-to-the-prometheus-instance)。

使用服务的自定义抓取任务和凭据支持来提供监控 Bearer token。
核对生成的抓取配置、目标状态和实际查询结果。
如果所选托管采集器无法安全附加该请求头，应运行小型私有 Prometheus 采集器，
使用随附任务配置，再通过平台支持的 remote-write 集成发送数据；不要关闭 MQLite 身份验证。
ECS 自定义任务发现和更新流程见
[服务发现规则](https://www.alibabacloud.com/help/en/arms/prometheus-monitoring/manage-service-discovery-rules-for-ecs-environments)。

对于 ACK，使用已安装采集器支持的 ServiceMonitor/PodMonitor 或自定义任务机制。
[Kubernetes 示例](../ops/observability/kubernetes/README.md) 针对上游 Prometheus Operator。
应用示例之前，核对 ACK 环境中的实际 CRD 版本、namespace 选择器和 Secret 访问权限。

## Fly.io

MQLite 使用现有 Fly Machine，Prometheus/Grafana 则在本地或现有监控平台运行。
导出指标不需要第二台 Fly Machine。

仅允许私有访问时：

1. 从 `fly.toml` 中移除公开的 `[http_service]` 和 `[[services]]` 条目。
2. 设置 `MQLITE_ADDR=fly-local-6pn:6754` 和 `MQLITE_METRICS=on`，
   保留管理员身份验证与单独配置的监控 token。
3. 通过 Fly 6PN 或 WireGuard 对等节点连接采集器，并使用监控 token 抓取
   `your-mqlite-app.internal:6754/metrics`。本地检查隧道可执行
   `fly proxy 6754:6754 --app <app>`；本地 Prometheus 进程可使用 `127.0.0.1:6754` 作为目标。
   Docker 采集器需要明确配置访问宿主机隧道的路由；容器自身的 `127.0.0.1` 指向该容器。

Fly 私有网络的范围由组织／网络配置决定。它增加网络边界，但不能替代 MQLite 身份验证。
这些连接要求 Machine 已经运行。
参见[私有网络](https://fly.io/docs/networking/private-networking/)、
[应用服务](https://fly.io/docs/networking/app-services/)和
[`fly proxy`](https://fly.io/docs/flyctl/proxy/)。

如果 broker API 必须保持公开，开启指标后，该指标路由也会经由同一服务对外可达。
使用现有入口真实实施公开 `/metrics` 拒绝规则，同时允许私有采集；否则保持指标关闭。
监控 token 限制数据访问，但不会使公开路径变成私有路径。
这些示例没有假设 Fly 的公开代理具备路径过滤能力。

Fly 自动自定义指标 stanza 的文档只规定端口和路径，没有逐目标 MQLite Bearer 凭据配置。
因此，仅增加 `[metrics]` 并不是已经验证过的认证端点抓取方案。
应使用可复用的带身份验证 Prometheus 任务，并验证真实抓取。
[Fly 自定义指标](https://fly.io/docs/monitoring/metrics/)。

如果在 Grafana 中使用 Fly 托管的兼容 Prometheus 查询端点，Fly access token 用于让 Grafana
向该服务进行身份验证；它与抓取时使用的 MQLite 监控 token 不同。
请遵循 Fly 文档规定的 token 类型授权方式。
Fly 托管指标服务不提供告警通知；必须显式配置 Grafana/Prometheus 告警路径。
官方指标指南说明了这些边界及其保留期限。
[Fly 指标身份验证与告警](https://fly.io/docs/monitoring/metrics/)。

保留 broker 的单写入器 SQLite 卷模型。
私有采集器抓取时，必须保证受监控的 Machine 已经运行；不要假定停止的 Machine 是健康的，
也不要假定每个私有请求都会通过 Fly Proxy 自动启动。
监控频率和缩容至零策略应结合实际路由配置作出明确选择。

## Azure：VM 或 AKS

私有虚拟机采集器可使用相同的 TLS/Bearer 任务。
对于使用 Azure 托管 Prometheus 的 AKS，使用文档规定的自定义抓取机制和 namespace 范围的
Secret 访问权限。Azure 托管 ServiceMonitor/PodMonitor CRD 与上游 Prometheus Operator
使用不同的 API group，因此不能原样复制所附上游清单。
核对采集器支持的字段、RBAC 和 Kubernetes 版本特定要求。
[Azure 自定义抓取 CRD 与身份验证](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/prometheus-metrics-scrape-crd)。

对于 AKS 上现有的上游 operator 安装，使用上游
[Kubernetes 示例](../ops/observability/kubernetes/README.md)。
除非已设计副本标签和下游去重方式，否则不要重复配置抓取任务；
否则仪表盘可能重复累计进程计数器，或重复数据库 gauge。

## 生产交接检查表

| 事项 | 必需检查 |
| --- | --- |
| 凭据 | 监控 token 与管理员凭据不同；无正文访问、队列管理或密钥签发权限；密钥绝不进入标签 |
| 网络 | 采集器可达所选私有／TLS 端点；公开访问仍受限制 |
| 持久化 | broker 数据库和监控历史具备适当的卷、保留策略与备份策略 |
| 规则 | 阈值符合应用 SLA；已实际测试通知路由 |
| 新鲜度 | 抓取缺失、队列采集失败、后端测量不可用必须能与零值区分 |
| 规模 | 记录抓取耗时和序列数量；队列标签随已配置队列数增长，而不是随消息数增长 |
| 主机健康 | 复用云／节点／容器监控，覆盖磁盘空间、CPU、内存、OOM 和卷健康 |
| 升级 | 固定已审查的镜像；升级后验证导出协议、仪表盘查询和告警 |

本地演示不会创建阿里云、Fly.io、Azure 托管服务或 Kubernetes 集群。
上述提供方设置是可复用指导，包含针对具体环境的验证步骤。
本地集成证据不得表述为托管云部署测试。
