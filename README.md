# ms-zerotier-planet

[English](README.en.md)

[![CI](https://github.com/Csneer/ms-zerotier-planet/actions/workflows/image-build.yml/badge.svg)](https://github.com/Csneer/ms-zerotier-planet/actions/workflows/image-build.yml)
[![Latest release](https://img.shields.io/github/v/release/Csneer/ms-zerotier-planet?display_name=tag)](https://github.com/Csneer/ms-zerotier-planet/releases)

**用一台低成本云主机，搭建属于自己的 ZeroTier 内网穿透入口。**

`ms-zerotier-planet` 把 ZeroTier Planet、Root、Controller 和 Web 管理控制台打包在一起：你的笔记本、手机、家用 NAS、开发机和云服务器可以加入同一张私有虚拟网络，安全访问 SSH、RDP、HTTP、数据库等内网服务。它使用标准 ZeroTier 客户端，不要求改造业务，也不依赖第三方公共 Planet。

如果你手上只有阿里云等厂商的 **2 vCPU / 2 GiB** 级别云主机，这也是一个实际可落地的起点：个人和小团队的低至中等流量场景可以在一台主机上同时运行 Controller、Root 和 Web 控制台。真实吞吐和延迟仍取决于带宽、地域、NAT、客户端数量与业务流量；需要更高可用性时，可以再增加独立 Root。

```text
你的设备/内网服务  ── ZeroTier 虚拟网络 ──  自建 Planet + Root
                                           └─ Controller + Web 控制台
```

## 为什么选择它

- **真正掌控入口**：Planet、identity、Network、授权和虚拟 IP 都在自己的服务器上，客户端配置由你签发和分发。
- **一台小规格云主机即可开始**：默认单 Root 部署，安装脚本负责配置、构建、启动和健康检查。
- **不用改业务**：接入端继续使用官方 ZeroTier 客户端，现有 SSH、Web、文件共享和数据库服务按原方式运行。
- **可视化管理**：在 Web 中创建网络、授权成员、调整 MTU，下载 `planet`/`.moon` 并核对 SHA-256。
- **需要时再扩容**：同一 Planet 支持多 Root 和备用 Root；签名发布、身份隔离和切换准备度都有配套工具与文档。
- **迁移有边界**：支持核对数据布局、身份和签名链后的原地升级；不偷偷覆盖旧数据，也不把单活 Controller 包装成“自动高可用”。

## 快速启动

准备一台带固定公网 IPv4 的 Linux 主机，放行 `9994/udp`，安装 Docker Engine 24+ 与 Compose v2：

```bash
git clone https://github.com/Csneer/ms-zerotier-planet.git
cd ms-zerotier-planet
./install.sh --ip YOUR_PUBLIC_IPV4
```

安装完成后访问 `http://127.0.0.1:3443`，默认登录 `admin/password`，首次登录立即修改密码。然后：

1. 在 `Networks` 创建虚拟网络。
2. 在 `Downloads` 下载 `planet`，把它安装到每台客户端的 ZeroTier 数据目录。
3. 启动客户端、加入网络，并在 Web 控制台授权成员。
4. 用设备的 ZeroTier 地址访问你的 SSH、Web 或其他内网服务。

默认安装从当前 checkout 构建镜像；如果你更关心拉取速度，也可以使用自己发布到 GHCR 的镜像：

```bash
./install.sh --ip YOUR_PUBLIC_IPV4 --pull \
  --image ghcr.io/csneer/ms-zerotier-planet:v1.0.0
```

需要由编码 Agent 或自动化流程执行安装、升级和验收时，请按 [Agent 安装与验收指引](docs/agent-install.md) 操作。

> 这是私有虚拟网络方案，不是只转发 HTTP 的临时隧道。它适合需要访问多种 TCP/UDP 内网服务的场景；公网地址、云安全组和主机防火墙仍由你自己负责。

## 二开维护内容

- ZeroTier `1.16.2`，版本通过 `.env` 和构建参数控制。
- `host` 网络直通 ZeroTier UDP 热路径，避免 Docker NAT 和 userland proxy。
- 新建网络默认 MTU `1280`，已有网络可在 Web 中修改 `1280–2800`。
- 响应式 Web 仪表盘，集中管理网络、成员、MTU、用户和配置下载。
- 登录后直接下载 `planet` 和 `.moon` 文件，并显示 SHA-256。
- identity、Controller 数据、Web 用户和 session key 全部持久化。
- 内置连接监控区分 Planet 服务器视角与可选本机探针视角，并展示 ZeroTier 流量指标。
- 多 Root 面板显示切换准备度、World 一致性和每个备用 Root 的观测证据；只做安全观测，不自动改防火墙或强制切流。
- 联合健康检查、进程监管、优雅退出和 Docker 日志轮转。
- IP 或 ZeroTier 端口变化时保留 identity 与世界签名密钥，只重新签发 planet/moon。
- 支持同一 Planet 的多 Root：统一离线签名、独立 Root 身份及 Root-only 实例，详见[多 Root 与切换方案](docs/multi-root.md)。
- 多 Root 不等于 Controller 高可用或秒级切换：两机隔离实测中一次自动恢复约需 245 秒，部署时应按客户端版本与真实路径重新验收。
- 首页与连接监控共用 Controller / World / Root 拓扑，区分近期回应、过期路径和不可用探针；同一后台可监听回环及多个明确的 ZeroTier 地址。
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
| 9994 | UDP | ZeroTier Planet Root 稳定端点 | 公网；每个 Root 的 UDP 端点必须放行 |
| 9994 | TCP | ZeroTier 本地管理 API | 仅回环或受信来源；不要当作公网 HTTPS/业务入口 |
| 3443 | TCP | Web 管理控制台 | 仅可信 IP、ZeroTier 网段或本机反代 |

旧的 `3000/tcp` 文件服务已删除。`planet` 和 `.moon` 只通过登录后的 Web `Downloads` 页面分发。

脚本不会自动安装 Docker、修改内核、改防火墙或写 `/etc/docker/daemon.json`。这些主机级操作不应由应用安装脚本静默执行。

## 首次安装

从源码本地构建（将示例地址 `203.0.113.10` 换成服务器真实公网 IPv4）：

```bash
git clone https://github.com/Csneer/ms-zerotier-planet.git
cd ms-zerotier-planet
./install.sh --ip 203.0.113.10
```

可选参数：

```bash
./install.sh \
  --ip 203.0.113.10 \
  --ipv6 2001:db8::10 \
  --data-dir /srv/zerotier-planet
```

以下在备用机的新 checkout 中执行（尚无 `.env`）。不要复用已有客户端或 Controller 数据目录：

```bash
CONTAINER_NAME=myztplanet-root-b ./install.sh --ip 203.0.113.20 \
  --data-dir /srv/zt-root-b \
  --image zerotier-planet:multi-root \
  --planet-mode external --root-only 1 --configure-only
```

该命令只生成配置，不会替你生成多 Root 签名文件。必须先由可信发布者准备并验证 `config/planet`，再执行 `./manage.sh up`。备用 Root 不应运行 Controller，也不能与主 Controller 共享 `one/` 或 `controller.d/`。

生成 B 的独立身份后，再把 `identity.public` 交给签名发布者；不能把 A 的 identity 复制过来：

```bash
./build.sh
(
  set -eu
  test -z "$(find /srv/zt-root-b/one -mindepth 1 -maxdepth 1 -print -quit)"
  docker run --rm --network none --entrypoint zerotier-idtool \
    -v /srv/zt-root-b/one:/work \
    zerotier-planet:multi-root generate /work/identity.secret /work/identity.public
)
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

如果需要从 ZeroTier 网络访问，把 `HTTP_HOST` 设置为服务器对应的 ZeroTier 地址，例如 `172.16.100.97`。需要同时监听多个明确地址时使用逗号分隔的 `HTTP_EXTRA_HOSTS`，例如 `HTTP_HOST=127.0.0.1`、`HTTP_EXTRA_HOSTS=172.16.100.97`；它不接受网段或 `0.0.0.0`。默认 Compose 未启用 HTTPS；需要 HTTPS 时推荐在受信网络中增加反向代理。

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
| `CONTAINER_NAME` | 容器名；同机多实例或保留停机旧容器的跨工程接管需避免重名 |
| `IP_ADDR4` / `IP_ADDR6` | planet 对外发布的稳定地址 |
| `PLANET_MODE` | `generated`：原单 Root 自动生成；`external`：使用 `config/planet` 的统一签名文件 |
| `ROOT_ONLY` | `1`：只启动 Root，不开 Web UI；默认 `0` |
| `CONTROLLER_ONLY` | `1`：external 模式下的人工 Controller 备用；必须有 active standby guard，不承担 Root；默认 `0` |
| `ZT_PORT` | ZeroTier 主端口，默认 `9994` |
| `API_PORT` | Web 管理端口，默认 `3443` |
| `DEFAULT_NETWORK_MTU` | 新建网络默认 MTU，建议 `1280` |
| `HTTP_HOST` | Web 监听地址，默认 `127.0.0.1`；也可绑定服务器的 ZeroTier 地址 |
| `HTTP_EXTRA_HOSTS` | 额外的明确监听 IP，逗号分隔；缺失的局域网 IP 会重试，不会拖停主监听 |
| `ZT_PROBE_ADDR` | 可选探针的本地 ZeroTier API，默认 `http://127.0.0.1:9993` |
| `ZT_ENDPOINT_PROBES_FILE` | 可选端点 TCP 探针配置，默认 `/app/config/endpoint-probes.json`；仅检查明确 IP 和端口 |

单 Root `generated` 模式下，修改 `IP_ADDR4`、`IP_ADDR6` 或 `ZT_PORT` 后执行 `./manage.sh upgrade`。容器会保留原 identity 和 `.c25519` 签名密钥，生成时间戳更高的新 planet；客户端仍需重新下载并替换新的 `planet` 文件。多 Root `external` 模式必须统一签名发布，不能靠改环境变量重新生成，见[部署步骤](docs/multi-root.md)。

建立自己的远程仓库后，请把 `SOURCE_REPOSITORY` 填为该仓库 URL；留空时 OCI source 标签也保持为空，不会冒充原上游发布物。

## 连接状态与监控

登录后进入“连接监控”可看到以下彼此独立的状态：

- `Planet 可达`：Planet 服务器当前观测到该成员的有效路径。这只能说明成员与本服务器之间的状态。
- `到 Planet 直连`：成员到 Planet 服务器有活动的物理路径，不代表成员与其他终端直连。
- 探针 `DIRECT` / `RELAY` / `TCP RELAY`：服务器本机 ZeroTier 客户端到该成员的当前路径。探针只是一个观测点，不是所有终端的两两连接矩阵。
- Planet 包速率与 UDP/TCP 流量：来自 ZeroTier 内置 Prometheus 指标，页面用相邻采样计算速率。
- Planet 文件一致性与未声明 Root 数量：运行文件应与下载文件一致；按配置的公开 Root 清单识别异常上游，正常备用 Root 不会被误报为公共 Root。

若要启用探针视角，把主机 ZeroTier 客户端的数据目录配置为 `ZT_PROBE_STATE_DIR`。Compose 会只读挂载该目录，并通过 `ZT_PROBE_ADDR` 查询本机 API。目录为空或 API 不可达时，监控页会显示“探针不可用”，不会影响主服务。

端点业务探针是另一层可选观测：复制 [examples/endpoint-probes.json](examples/endpoint-probes.json) 到持久化 `config/endpoint-probes.json` 后，监控页会以受限并发执行只读 TCP connect，并在建连后立即关闭。配置只接受字面 IPv4/IPv6 地址（不接受带接口 zone 的 `%` 形式）、1–32 个目标和 100–5000ms 超时；每次采样另有约 10 秒总预算，超出的目标标记为超时。不解析 DNS、不执行 SSH/HTTP 命令，也不会扫描任意端口。TCP 成功只说明本管理实例到目标端口可达，不代表 ZeroTier 端点直连、业务协议健康或流量经过哪个 Root；未配置时不会自动探测。

判断两台具体终端是否直连，仍应在其中一台终端运行 `zerotier-cli peers`，或结合实际端到端传输测试；中央控制器无法可靠推断任意终端对之间的实时路径。

## 从已有 Planet 项目原地升级

本项目提供保留原数据的升级路径，并非对任意旧镜像、任意目录布局的一键兼容。详细命令和验收清单以[原地升级指南](docs/in-place-upgrade.md)为准：

1. 保留独立管理通道，检查旧容器真实挂载；备份 identity、`controller.d/`、签名密钥、Planet 各副本、端点配置、Web 用户和 session key。缺失文件先核查，不能让新实例初始化替代身份或签名链。
2. 当前项目更新源码时保留 `.env`、挂载路径和现有 `PLANET_MODE`，执行 `doctor`、`upgrade`。旧项目跨 checkout 接管需使用绝对路径；旧容器停机后仍占用名字，应使用不同的新容器名或将旧容器改名保留，不能双开同一 identity。
3. 仅在确认单 Root、签名材料及原端点配置完整时沿用 `generated`。已是多 Root 或 external 的实例必须保持 `external`；只有当前可信 Planet、没有签名密钥时可按指南核查后 external 接管，但不能签发新增 Root。不要一律改成 generated。
4. 新增 B 时为它生成独立身份，用原 World 签名链生成含 A/B 的候选，验证签名、时间戳和哈希后预置到各 Root 的 `config/planet`；先准备并验证 B，再滚动更新 A。A 保持 Controller 单活，B 不复制 A 的 `one/`。
5. 分批给客户端安装同一份 Planet，核对原 Network ID、IP 和授权保持，并用隔离客户端验证实际中转及恢复时间。`doctor` 不等于签名验证，签名链和本机 Root 身份匹配在候选校验及容器启动时验证。

热切换不以 Root 列表顺序指定主备，不等于 Controller 多主。镜像回退也不等于 World 拓扑回退：拓扑恢复必须签发更高时间戳的新 World。

完整的签名发布、Controller-only 手动备用、原生 Root-only systemd 部署和隔离切换验证见[原地升级指南](docs/in-place-upgrade.md)、[多 Root 与切换方案](docs/multi-root.md)、[Controller-only 手动备用](docs/controller-standby.md)、[Root 接入指南](docs/root-onboarding.md)及[系统 Root-only 部署](docs/native-root.md)。

## 日常维护

```bash
./manage.sh doctor                 # 配置与依赖检查
./manage.sh status                 # 容器、ZeroTier、World/Root 和网络状态
./manage.sh logs                   # 跟随日志
./manage.sh restart                # 重启并等待 healthy
./manage.sh build                  # 只构建镜像
./manage.sh up                     # 启动已有镜像，不删除数据
./manage.sh upgrade                # 构建/拉取、备份、重建、健康检查（回滚依模式）
```

升级本仓库代码后的推荐流程：

```bash
git pull --ff-only
./manage.sh doctor
./manage.sh upgrade
```

`upgrade` 会先准备新镜像，再短暂停止旧容器生成一致性备份。`generated` 模式的新容器未通过健康检查时会尝试恢复上一镜像；`external` 模式只保留回滚标签和备份，必须人工确认镜像仍支持当前 signed World 后恢复。

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
- `probe-state/` 不在正式备份中：它只是可选的只读本机 ZeroTier 观测客户端状态，可在目标主机重新指定 `ZT_PROBE_STATE_DIR`；其中的 token 不属于 Controller/Root 数据。
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

## 版本与镜像发布

项目采用独立的 SemVer 版本（`vX.Y.Z`）；首个版本为 `v1.0.0`，对应镜像 `ghcr.io/csneer/ms-zerotier-planet:v1.0.0`。它与 ZeroTier `1.16.2` 等运行时版本不同。变更见 [CHANGELOG](CHANGELOG.md)，维护者的身份配置、打 tag 和 GitHub Release 步骤见[发布约定](docs/releasing.md)。

[image-build.yml](.github/workflows/image-build.yml) 校验脚本、Compose 和容器回归后，构建 `amd64`/`arm64` 并发布到 GHCR：

- 正式 `vX.Y.Z` tag 使用该 tag 的 `.env.example` 中的 `ZT_VERSION`（`v1.0.0` 为 `1.16.2`），只发布对应项目版本镜像，不更新滚动标签。
- `main`/`master` 推送、每周计划任务和普通手动构建继续采用上游最新稳定 ZeroTier（手动构建可指定版本），生成 `latest`、ZeroTier 版本和 Git SHA 标签。
- 需要固定实际部署内容时，记录并使用镜像 digest；版本 tag 本身不代表全部构建依赖均已锁定。

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
├── docs/                   # 原地升级、Controller 备用、Root 接入、多 Root 和 Root-only 运维文档
├── patch/                  # ZeroTier、ztncui 和 Web 定制
└── .github/                # GHCR 发布与依赖更新
```

## 安全注意事项

- 不建议将 `3443/tcp` 直接暴露给整个公网；至少使用云安全组白名单。
- 更推荐 `HTTP_HOST=127.0.0.1`，再由 Caddy/Nginx/Traefik 提供 HTTPS；如需 ZeroTier 访问，再把实际地址加入 `HTTP_EXTRA_HOSTS`。
- 回环和指定 ZeroTier 地址提供同一套账户、会话存储和管理模型；浏览器 Cookie 按主机隔离，换 IP 可能要重新登录。不要使用 `0.0.0.0`，除非有明确的防火墙白名单。
- 不要提交 `.env`、`data/`、`backups/` 或任何 identity、`.c25519`、token 文件。
- ztncui 上游已经停止积极维护；管理面应视为高权限内部服务。

## 来源与许可证

本仓库没有擅自给历史代码重新声明许可证。第三方源代码、补丁基础和运行时组件分别受其各自许可证约束。公开分发或商业使用前，请阅读 [NOTICE.md](NOTICE.md) 并核对相应许可条款。
