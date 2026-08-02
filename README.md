# ms-zerotier-planet

[English](README.en.md)

这是一个面向长期自托管的 ZeroTier Planet、Controller 和 Web 管理控制台二次开发版。仓库使用 Docker Compose 管理单个 `myztplanet` 容器，默认从当前源码构建，不依赖第三方维护者发布的 `latest` 镜像。

项目以生产可维护性为核心，独立发布，不使用 GitHub Fork 关系。第三方组件、历史代码归属和许可证边界见 [NOTICE.md](NOTICE.md)。

## 二开维护内容

- ZeroTier `1.16.2`，版本通过 `.env` 和构建参数控制。
- `host` 网络直通 ZeroTier UDP 热路径，避免 Docker NAT 和 userland proxy。
- 新建网络默认 MTU `1280`，已有网络可在 Web 中修改 `1280–2800`。
- 响应式 Web 仪表盘，集中管理网络、成员、MTU、用户和配置下载。
- 登录后直接下载 `planet` 和 `.moon` 文件，并显示 SHA-256。
- identity、Controller 数据、Web 用户和 session key 全部持久化。
- 内置连接监控区分 Planet 服务器视角与可选本机探针视角，并展示 ZeroTier 流量指标。
- 联合健康检查、进程监管、优雅退出和 Docker 日志轮转。
- IP 或 ZeroTier 端口变化时保留 identity 与世界签名密钥，只重新签发 planet/moon。
- 安装、升级、备份、恢复和卸载均使用非破坏性脚本；危险操作需要显式 `--yes`。
- GitHub Actions 自动构建 `amd64`/`arm64`，并发布到本仓库对应的 GHCR。

## 环境要求

- 64 位 Linux，推荐 Debian 12、Ubuntu 22.04+ 或 Rocky Linux 9。
- Docker Engine 24+。
- Docker Compose v2。
- Bash、Git、Python 3、`jq`、`coreutils`。
- 固定或可控的公网 IPv4；IPv6 可选。
- 云安全组和主机防火墙至少放行 `${ZT_PORT}/udp`，默认 `9994/udp`。

端口用途：

| 默认端口 | 协议 | 用途 | 建议暴露范围 |
|---:|---|---|---|
| 9994 | UDP/TCP | ZeroTier Planet/Controller | 公网；UDP 必须放行 |
| 3443 | TCP | Web 管理控制台 | 仅可信 IP、ZeroTier 网段或本机反代 |

旧的 `3000/tcp` 文件服务已删除。`planet` 和 `.moon` 只通过登录后的 Web `Downloads` 页面分发。

脚本不会自动安装 Docker、修改内核、改防火墙或写 `/etc/docker/daemon.json`。这些主机级操作不应由应用安装脚本静默执行。

## 首次安装

从源码本地构建：

```bash
git clone https://github.com/Csneer/ms-zerotier-planet.git
cd ms-zerotier-planet
./install.sh --ip <服务器公网IPv4>
```

可选参数：

```bash
./install.sh \
  --ip 203.0.113.10 \
  --ipv6 2001:db8::10 \
  --data-dir /srv/zerotier-planet
```

只生成并检查 `.env`，不启动 Docker：

```bash
./install.sh --ip 203.0.113.10 --configure-only
```

使用你在 GHCR 发布的预构建镜像：

```bash
./install.sh \
  --ip 203.0.113.10 \
  --pull \
  --image ghcr.io/csneer/ms-zerotier-planet:latest
```

安装器的安全边界：

- 已存在 `.env` 时不会覆盖它。
- 已存在数据目录时不会删除或初始化清空。
- 不会自动拉取任何第三方 `latest` 镜像。
- 新部署默认管理员是 `admin/password`，首次登录后必须立即修改。

Web 默认只监听本机：

```text
http://127.0.0.1:3443
```

如果需要从 ZeroTier 网络访问，把 `HTTP_HOST` 设置为服务器对应的 ZeroTier 地址，例如 `172.16.100.97`。当前版本不内置 HTTPS；需要 HTTPS 时应在受信网络中增加反向代理。

## 配置

运行配置只保存在未纳入 Git 的 `.env`。模板见 [.env.example](.env.example)。

| 变量 | 说明 |
|---|---|
| `ZT_VERSION` | 构建时安装的 ZeroTier 版本 |
| `ZTNCUI_COMMIT` | 固定的 ztncui 源码提交 |
| `MKWORLD_ZT_VERSION` | 用于构建 `mkworld` 的兼容 ZeroTier 源码版本 |
| `DEBIAN_MIRROR` | Debian 镜像主机；海外环境可设为 `default` |
| `ZT_IMAGE` | 本地或远端镜像名 |
| `IMAGE_SOURCE` | `build` 从本仓库构建；`pull` 从镜像仓库拉取 |
| `SOURCE_REPOSITORY` | 写入 OCI 标签的你自己的仓库 URL |
| `DATA_DIR` | identity、Controller、配置和生成文件的持久化根目录 |
| `ZTNCUI_STATE_DIR` | Web 用户与设备别名目录 |
| `ZT_PROBE_STATE_DIR` | 可选本机 ZeroTier 客户端状态目录，只读挂载供连接监控读取 token |
| `BACKUP_DIR` | 校验备份的保存目录 |
| `CONTAINER_NAME` | 容器名；同机多实例时必须分别设置 |
| `IP_ADDR4` / `IP_ADDR6` | planet 对外发布的稳定地址 |
| `ZT_PORT` | ZeroTier 主端口，默认 `9994` |
| `API_PORT` | Web 管理端口，默认 `3443` |
| `DEFAULT_NETWORK_MTU` | 新建网络默认 MTU，建议 `1280` |
| `HTTP_HOST` | Web 监听地址，默认 `127.0.0.1`；也可绑定服务器的 ZeroTier 地址 |
| `ZT_PROBE_ADDR` | 可选探针的本地 ZeroTier API，默认 `http://127.0.0.1:9993` |

修改 `IP_ADDR4`、`IP_ADDR6` 或 `ZT_PORT` 后执行 `./manage.sh upgrade`。容器会保留原 identity 和 `.c25519` 签名密钥，生成时间戳更高的新 planet；客户端仍需重新下载并替换新的 `planet` 文件。

建立自己的远程仓库后，请把 `SOURCE_REPOSITORY` 填为该仓库 URL；留空时 OCI source 标签也保持为空，不会冒充原上游发布物。

## 连接状态与监控

登录后进入“连接监控”可看到以下彼此独立的状态：

- `Planet 可达`：Planet 服务器当前观测到该成员的有效路径。这只能说明成员与本服务器之间的状态。
- `到 Planet 直连`：成员到 Planet 服务器有活动的物理路径，不代表成员与其他终端直连。
- 探针 `DIRECT` / `RELAY` / `TCP RELAY`：服务器本机 ZeroTier 客户端到该成员的当前路径。探针只是一个观测点，不是所有终端的两两连接矩阵。
- Planet 包速率与 UDP/TCP 流量：来自 ZeroTier 内置 Prometheus 指标，页面用相邻采样计算速率。
- Planet 文件一致性与公共 Root 数量：运行中的 `planet` 应与下载页面分发的文件一致，私有 Root 正常运行时不应再连接公共 Root。

若要启用探针视角，把主机 ZeroTier 客户端的数据目录配置为 `ZT_PROBE_STATE_DIR`。Compose 会只读挂载该目录，并通过 `ZT_PROBE_ADDR` 查询本机 API。目录为空或 API 不可达时，监控页会显示“探针不可用”，不会影响主服务。

判断两台具体终端是否直连，仍应在其中一台终端运行 `zerotier-cli peers`，或结合实际端到端传输测试；中央控制器无法可靠推断任意终端对之间的实时路径。

## 日常维护

```bash
./manage.sh doctor                 # 配置与依赖检查
./manage.sh status                 # 容器、ZeroTier 和网络状态
./manage.sh logs                   # 跟随日志
./manage.sh restart                # 重启并等待 healthy
./manage.sh build                  # 只构建镜像
./manage.sh up                     # 启动已有镜像，不删除数据
./manage.sh upgrade                # 构建/拉取、备份、切换、失败回滚
```

升级本仓库代码后的推荐流程：

```bash
git pull --ff-only
./manage.sh doctor
./manage.sh upgrade
```

`upgrade` 会先准备新镜像，再短暂停止旧容器生成一致性备份。新容器未通过健康检查时，会自动恢复上一镜像。

## 备份与恢复

生成一致性备份，过程中会短暂停止并自动恢复容器：

```bash
./manage.sh backup
```

不中断服务的快照：

```bash
./manage.sh backup --online
```

在线快照可能遇到文件正在变化，只适合作为补充。正式备份优先使用默认的一致性模式。

每个备份包含：

- `dist/`：planet 和 moon。
- `one/`：ZeroTier identity、签名密钥和 Controller 数据。
- `config/`：端口、地址和 session key。
- `ztncui-state/`：Web 用户和设备别名。
- `.env`、Compose 配置、容器信息与 `SHA256SUMS`。

恢复前会先验证校验和并自动备份当前数据：

```bash
./manage.sh restore ./backups/planet-YYYYMMDD-HHMMSS --yes
```

备份包含私钥和密码哈希，目录权限会收紧为 `0700`、文件为 `0600`。不要上传到公开 Git 仓库。

## 密码与卸载

忘记 Web 管理密码：

```bash
./manage.sh reset-password --yes
```

该操作会先备份当前密码文件，再重置为 `admin/password` 并重启；登录后立即修改。

仅删除容器、保留全部数据和镜像：

```bash
./uninstall.sh
```

删除容器和持久化数据：

```bash
./uninstall.sh --purge-data --yes
```

彻底删除前仍会自动生成最后一份校验备份。脚本不会自动删除镜像和备份。

## 客户端配置

1. 登录 Web 控制台，进入 `Downloads`。
2. 下载 `planet` 并核对页面中的 SHA-256。
3. 停止客户端 ZeroTier 服务。
4. 替换客户端 ZeroTier 数据目录中的 `planet`。
5. 启动 ZeroTier 服务并加入 Web 中创建的网络。
6. 在 Web 中授权成员。
7. 运行 `zerotier-cli peers`，确认自建节点显示为 `PLANET`，路径尽量为 `DIRECT`。

常见 planet 路径：

- Linux：`/var/lib/zerotier-one/planet`
- Windows：`C:\ProgramData\ZeroTier\One\planet`
- macOS：`/Library/Application Support/ZeroTier/One/planet`

替换文件前必须停止 ZeroTier；具体路径可能因客户端发行版而不同。

## 镜像发布

[image-build.yml](.github/workflows/image-build.yml) 会：

- 校验 Shell、Node 和 Compose 配置。
- 在 `main`/`master` 推送、每周计划任务或手动触发时构建 `amd64`/`arm64`。
- 从 ZeroTier 官方最新稳定 release 解析版本，或使用手动输入版本。
- 发布到 `ghcr.io/csneer/ms-zerotier-planet`。
- 生成 `latest`、ZeroTier 版本和 Git SHA 标签。

如果 GHCR 包是私有的，部署主机需要先执行 `docker login ghcr.io`。Dependabot 每周检查 Docker 基础镜像和 GitHub Actions 版本。

## 仓库结构

```text
.
├── Dockerfile
├── docker-compose.yml
├── install.sh              # 首次配置和安装
├── manage.sh               # 日常维护入口
├── uninstall.sh            # 安全卸载入口
├── deploy.sh               # 旧命令兼容层，不再包含旧部署逻辑
├── build.sh                # 本地/多架构镜像构建
├── patch/                  # ZeroTier、ztncui 和 Web 定制
└── .github/                # GHCR 发布与依赖更新
```

## 安全注意事项

- 不建议将 `3443/tcp` 直接暴露给整个公网；至少使用云安全组白名单。
- 更推荐 `HTTP_HOST=127.0.0.1`，再由 Caddy/Nginx/Traefik 提供 HTTPS。
- 需要通过 ZeroTier 网络直接管理时，可把 `HTTP_HOST` 绑定到服务器的 ZeroTier 地址；不要使用 `0.0.0.0`。
- 不要提交 `.env`、`data/`、`backups/` 或任何 identity、`.c25519`、token 文件。
- ztncui 上游已经停止积极维护；管理面应视为高权限内部服务。

## 来源与许可证

本仓库没有擅自给历史代码重新声明许可证。第三方源代码、补丁基础和运行时组件分别受其各自许可证约束。公开分发或商业使用前，请阅读 [NOTICE.md](NOTICE.md) 并核对相应许可条款。
