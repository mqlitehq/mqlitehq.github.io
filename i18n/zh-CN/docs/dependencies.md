# 依赖策略与 go 1.21 最低版本

MQLite 将 `go.mod` 的最低版本固定为 **`go 1.21`**，使 SDK 仍可直接嵌入尚未升级工具链的项目（MQLITE-1）。这一决定锁定了两个依赖；本文说明锁定原因、代价，以及如何防止无意间解除限制。

## 仅远程访问的配套模块

只调用 broker 的应用可以改用官方的 [MQLite Remote Client for Go](https://github.com/mqlitehq/mqlite-go)。其模块路径仍为 `github.com/mqlitehq/mqlite-go`；目标发布版本 `v0.1.2` 的源码最低要求是 Go 1.13，且仅使用标准库，因此不会链接嵌入式引擎、SQLite、libSQL/Turso 或 CGO。
较低的最低版本是兼容性承诺，并不建议在生产环境运行已停止维护的工具链：应尽可能使用仍受支持的 Go 版本构建。应用需要嵌入式模式、事务发件箱（transactional outbox）、规范化观测数据解码或托管访问密钥管理时，应使用本主模块。

## 最低版本限制锁定了哪些依赖

| 依赖 | 固定版本 | 下一版本 | 锁定原因 |
|---|---|---|---|
| `modernc.org/sqlite` | **v1.36.1** | v1.36.2 → `go 1.23` | 纯 Go SQLite 引擎；**1.36.1 是最后一个可在 go 1.21 上构建的版本**，紧接着的*补丁版本*就将最低要求提高到了 1.23 |
| `golang.org/x/sys` | **v0.30.0** | v0.31.0 → `go 1.23` | 间接依赖（文件锁）；v0.31.0 及以上版本均要求 go ≥ 1.23 |

二者都**没有兼容 go 1.21 的可升级版本**：各自的下一版本就已要求 go ≥ 1.23。因此，Dependabot 提出的 `sqlite → 1.52.0` 或 `x/sys → 0.46.0` 并不是“项目落后而未跟进的升级”；它们与 go 1.21 最低版本要求互不兼容，必然无法通过 `go 1.21.x` CI 矩阵。

## 远程 libSQL 驱动

纯 Go Hrana 客户端 [`github.com/tursodatabase/libsql-client-go`](https://github.com/tursodatabase/libsql-client-go) 保持固定版本，尽管上游现在已将仓库标为弃用。这是临时的兼容性选择，并非认为未维护的依赖是理想方案。上游推荐的 [`go-libsql`](https://github.com/tursodatabase/go-libsql) 使用 CGO，目前只为四种 Linux/macOS 目标发布原生库；较新的 [`tursogo`](https://github.com/tursodatabase/turso/tree/main/bindings/go) 模块要求 Go 1.24，实现的是本地数据库加远程同步，并非 MQLite 当前直接访问主库的 Hrana 路径。官方 [`tursogo-serverless`](https://github.com/tursodatabase/turso/tree/main/serverless/go) 模块是纯 Go 的 `database/sql` 驱动，通过 HTTP 直接连接 Turso Cloud，但其模块同样要求 Go 1.24，且尚未通过 MQLite 的本地/远程一致性、真实生命周期、持续负载及六种发布目标门禁。目前没有替代项同时满足 Go 1.21、无 CGO、六种目标平台和存储语义的完整契约。

CI 在受支持的 macOS runner 上，对 Go 1.21 测试二进制进行外部链接，以维持这一源码最低版本契约。Go 1.21 的内部 Darwin 链接器不会生成当前 macOS 所要求的 `LC_UUID`，而 Apple 外部链接器会生成。此例外仅用于兼容性门禁；发布二进制使用当前受支持的 Go 工具链及其正常链接器选择。

MQLite 用一个范围很窄的单次连接租用适配器，约束已知的 HTTP 逻辑流生命周期缺陷：`libsql://` 驱动连接在其 `database/sql` 连接租用结束时被丢弃，而 Go 的共享 HTTP transport 继续复用物理 TCP/TLS 连接。迁移到受维护驱动，需要完整的本地/远程一致性测试、真实 Turso 生命周期及持续负载测试，以及全部发布平台构建。不能仅凭 API 相似就替换此依赖或移除适配器；目前不承诺替代方案或迁移日期。

HTTP v2 传输及其协议／结果辅助代码，在 `internal/libsqlcompat` 中保留了同一固定版本的
小型内部副本，用于实现有界的异步流清理（MQLITE-164）及成功确认校验（MQLITE-191）。
不完整或不匹配的响应无法确认成功或授权重放写入。原有公开 SQL 解析器与 WebSocket
驱动继续使用固定版本。源码／改动哈希和模块版本守卫用于检测漂移；无需库内 `replace`，也不依赖
调用方的 vendor 目录。复制的 MIT 许可证和源码说明随二进制归档和容器镜像一起交付。
内部辅助代码直接导入现有的 ANTLR，因此该依赖现列为直接依赖；依赖版本和实际选中的模块图保持一致。

## 安全策略

固定依赖版本不仅需要运行扫描器，也需要检查上游缺陷。CI 对源码运行 `govulncheck`，并使用 GoReleaser 发布矩阵扫描全部六种操作系统/架构组合上的两种实际二进制。发布钩子会再次执行二进制扫描，Docker 也扫描其实际构建产物。产物保留符号，使扫描器能够识别实际链接的代码，而不是退回到模块级匹配。没有排除任何安全公告。发现可达漏洞时，必须修复漏洞或明确调整兼容性最低版本；最低版本要求不能凌驾于安全之上。

例如，[GO-2026-5024](https://pkg.go.dev/vuln/GO-2026-5024) 影响当前 MQLite 二进制没有调用的一个 `x/sys/windows` 函数。Windows 源码分析和保留符号的二进制扫描都确认了这一边界。后续代码或依赖改动如果增加了调用，二进制门禁仍必须通过。

Go 漏洞扫描并不覆盖全部原生 SQLite 缺陷。SQLite 的 [WAL-reset 问题](https://www.sqlite.org/wal.html#the_wal_reset_bug) 会影响较旧的 SQLite 版本，触发条件是多个连接并发写入同一个 WAL 数据库或对其执行 checkpoint。MQLite 将本地写入和 checkpoint 串行安排在一个 SQL 连接上。另一个本地连接使用 SQLite `mode=ro` 和 `query_only` 进行观测读取，因此无法写入或执行 checkpoint。外部备份连接必须保持只读，绝不能对正在使用的数据库文件启动另一个写入者或 checkpoint 执行者。[运维手册](operations.md#consistent-backups) 保留了这一限制。更改连接模型前，应审阅原生引擎的安全公告。

容器操作系统软件包与 Go 依赖属于不同的安全边界。运行时镜像会先在受支持的 Alpine 分支内升级已安装的 APK 软件包，再添加证书和时区数据。受支持的基础镜像标签也可能包含较旧软件包：Alpine 3.24.1 包含 OpenSSL 3.5.7，而其软件仓库提供了修复 [CVE-2026-14456](https://openssl-library.org/news/secadv/20260813.txt) 的 3.5.8 补丁。现有 Docker CI 任务使用经过校验和验证的 Trivy 发行版和最新漏洞数据库，独立于 `govulncheck` 扫描实际镜像中的操作系统软件包。HIGH/CRITICAL 漏洞会使任务失败，不排除任何安全公告；JSON 报告作为 artifact 保留。更新扫描器时，应先审阅官方发行说明，再同时更新版本和校验和。CI 与发布镜像构建均绕过运行时阶段缓存，确保即使基础标签未变也会执行 APK 升级。最终发布候选的确切镜像在晋级前也必须通过操作系统扫描。MQLite 的静态 Go 二进制并不链接这些系统 OpenSSL 库，但这不能作为发布可避免的运行时漏洞软件包的理由。

## 如何强制执行版本锁定

1. **`.github/dependabot.yml`** 忽略 `modernc.org/sqlite >=1.36.2` 和 `golang.org/x/sys >=0.31.0`，避免 Dependabot 持续创建无法合并的 PR。
2. **`go 1.21.x` CI 矩阵**：需要更新工具链的依赖或 `go.mod` 改动，会在此构建失败。
3. **`TestGoModFloorStaysAt121`**（`sdk_test.go`）断言最低版本严格为 `go 1.21`；提高版本时会给出明确错误，使解除依赖锁定始终是有意识的修改，而非副作用。

## `expr-lang/expr`：主题过滤器依赖（MQLITE-17）

订阅过滤器是一个 [`expr-lang/expr`](https://github.com/expr-lang/expr) 布尔谓词（见 [concepts.md 的过滤器章节](concepts.md#subscription-filters-expr)），它是固定在 **v1.17.8** 的**直接核心依赖**。这是经过选择的长期依赖：由 `expr-lang` 组织维护，而非单一作者；**没有间接依赖**，采用 MIT 许可证，并且按设计具备“内存安全、无副作用、必定终止”的特性，是一个沙箱化谓词求值器。其 `go.mod` 最低要求仅为 go 1.18，因此不会对前述版本锁定造成压力。

**安全。** 相关的安全公告 **CVE-2025-29786**（无界 AST 导致解析器内存耗尽）已在本项目固定的 v1.17.x 系列中修复。`engine/filter.go` 还提供纵深防御：限制源码长度并使用 `expr.MaxNodes`，再以失败即不匹配的 `recover` 保护，防止恶意或有缺陷的过滤器使 broker 崩溃或悄然匹配。（搜索引擎针对“expr”给出的 CVSS-9.8 RCE 是 **JavaScript** 的 `expr-eval` 库，属于另一个项目。）所有过滤器调用都经过同一个包装层，因此上游变更或更换求值器只涉及一个文件；CI 中的 `govulncheck` 覆盖固定版本的 expr。

## 何时解除锁定

当项目有意提高 Go 最低版本时，例如取消嵌入兼容性要求，或安全 CVE 迫使项目升级，应提高 `go.mod` 中的版本，更新 `TestGoModFloorStaysAt121` 和本文表格，移除 Dependabot 忽略规则，再同时放行之前保留的升级（`modernc.org/sqlite`、`golang.org/x/sys`）。
