# 原有 ZeroTier Planet 项目原地升级

本文说明三种场景：本项目更新代码、旧单 Root 项目接管、单 Root 扩展为多 Root。目标是保留 Controller identity、Network ID、成员授权、虚拟地址、Planet World 签名链和 Web 状态。不同历史项目的数据布局、World 格式和 UI 会话实现可能不同，不能承诺任意旧镜像无条件替换。

原地升级不是复制目录后双主运行，也不是直接把旧容器替换成新容器。任何相同 Controller identity 或 `controller.d/` 数据都只能在一台主机上运行。

## 已经使用本项目：日常源码升级

保留 `.env`、现有绝对数据路径及 `PLANET_MODE`。有本地改动时先审查和保存；不要强制重置工作区。代码更新不会自动追加 Root：

```bash
git status --short
git pull --ff-only
./manage.sh doctor
./manage.sh upgrade
./manage.sh status
```

`upgrade` 构建/拉取镜像后短暂停本实例做一致性备份并重建容器；这不是 Web/Controller 的零停机更新。已运行 external 的实例必须保持 external。下文的旧工程接管步骤不需要对本项目每次升级重复执行。

## 升级前检查

先建立独立于待升级 ZeroTier 网络的 SSH/公网管理通道。记录旧项目的实际容器名、Compose 文件、数据挂载、Planet SHA-256、World ID/时间戳和当前 Controller 地址：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker inspect OLD_CONTAINER --format '{{json .Mounts}}'
docker inspect OLD_CONTAINER --format 'image={{.Config.Image}} project={{index .Config.Labels "com.docker.compose.project"}}'
sha256sum /旧数据目录/one/planet
```

以上是替换占位符后执行的模板。不要输出或上传完整容器环境变量、identity.secret、API token 和签名密钥。

至少确认以下数据仍在旧目录中：

```text
one/identity.secret
one/identity.public
one/planet
one/previous.c25519     # generated / 后续发布更新需要原签名密钥
one/current.c25519
one/moon.json          # 可能含私钥，只作受保护的原始备份
one/world.bin          # 若旧部署存在，连同 world.bin.previous 一并备份
one/controller.d/       # Controller 实例才需要
dist/planet            # 原实际分发给客户端的副本
ztncui-state/passwd     # 如果旧 UI 使用独立持久化目录
config/session.secret   # 如果旧 UI 使用本项目布局
config/                # 完整目录：端点/端口记录、external planet、探针配置等
```

若旧数据在容器可写层或命名卷中，先规划导出，停旧后做一致性副本，再删除任何容器。Web 密码、别名、session key 也需从旧实际位置导出；没有旧会话存储时浏览器可能需要重新登录，不能据此重置用户。当前脚本只备份本项目四个 bind mount（dist、one、config、ztncui-state），不会自动发现其他布局、导出旧卷或备份可选客户端 probe-state。

尤其要比较运行 `one/planet`、分发 `dist/planet` 和 signer 的当前 World。有些旧项目运行的是内置公共 Planet，却向客户端分发另一份私有文件；这些不是同一 World，不能用错误副本作签名更新基线。缺少本机 identity 私钥、World ID/签名链不符或旧文件格式不可检查时先停在诊断阶段，不生成替代密钥。缺少 World 签名私钥时不得重签或新增 Root，但满足下文条件后仍可用 external 接管当前可信版本。

## 准备新工作区

```bash
git clone https://github.com/Csneer/ms-zerotier-planet.git /opt/ms-zerotier-planet
cd /opt/ms-zerotier-planet
```

在仓库外的权限 `0700` 备份目录保存旧 `.env`/Compose 和完整数据。新 checkout 若没有 `.env`，从 `.env.example` 手动整理，或复制经过审查的旧 `.env`（无 `.env` 的旧项目不适用复制操作）。不要把 `old.env.backup` 等含机密文件放进 Git 工作区。

编辑 `.env` 时使用绝对路径，避免换 checkout 目录后相对路径创建一套新的空状态：

```dotenv
DATA_DIR=/srv/zerotier-planet
ZTNCUI_STATE_DIR=/srv/zerotier-planet/ztncui-state
BACKUP_DIR=/srv/zerotier-planet-backups
CONTAINER_NAME=myztplanet-upgraded
ZT_IMAGE=zerotier-planet:multi-root
IMAGE_SOURCE=build
PLANET_MODE=generated
ROOT_ONLY=0
```

把旧数据按目标挂载一一对应到 `DATA_DIR` 和 `ZTNCUI_STATE_DIR`。如果旧项目的 Controller、Web 状态和 ZeroTier identity 分散在不同路径，不要直接把父目录整体绑定；应先按文件/目录核对后再填配置。

本例 A 的数据目录统一为 `/srv/zerotier-planet`，B 为另一主机的 `/srv/zt-root-b`；必须改成现场路径。`CONTAINER_NAME=myztplanet-upgraded` 避免与旧容器撞名；本项目 Compose **service** 仍为 `myztplanet`，不要改 service 键。上例 generated 仅适用于下一节确认满足条件的单 Root。

旧配置迁移时删除已废弃的 `FILE_SERVER_PORT`、`DOWNLOAD_KEY` 等 3000 文件服务变量。当前项目不再提供未认证文件服务，`planet`/`.moon` 通过登录后的 3443 Downloads 页面提供。旧 `HTTP_HOST=0.0.0.0` 也应改为 `127.0.0.1` 加明确的 `HTTP_EXTRA_HOSTS`，或由本机 Nginx/Caddy 终止 HTTPS；不要把管理 API 当作公网业务代理。

## 停旧、备份和接管

先在新 checkout 构建镜像以减少停机（`./build.sh` 不启动服务、不要求已经有 config/planet）。旧单 Root 没有冗余时，后续接管就是一次维护窗口：

```bash
./build.sh  # 本例 .env 的 ZT_IMAGE=zerotier-planet:multi-root
```

确认 `OLD_CONTAINER` 是旧 Planet 实例后仅停止该容器，不要停止同工程的无关服务；不要删除卷或数据：

```bash
docker stop OLD_CONTAINER
# 不要使用 docker compose down -v
```

跨 Compose 工程时停止旧容器**不会释放容器名**。采用上例不同的新 `CONTAINER_NAME`；或者经确认后把旧容器改为唯一备份名称。防止旧自动化再次启动旧服务；无论名字是否相同，都不允许新旧实例共享 identity 同时运行。

停旧后先对原布局做仓库外完整备份，再完成四个目录的映射。模式必须按现状选择，在首次 `doctor/up` 前完成相应配置和文件准备：

- **沿用 generated**：已确认是本机单 Root，`previous.c25519/current.c25519`、分发 Planet、旧 `moon.json/world.bin`（若有）和 config 中端点/端口记录完整。缺少 `dist/planet` 或端点记录变化会触发重签；迁入之前先检查这些材料，不能只搬 identity/controller.d。不要把多 Root 转回 generated。
- **external 接管当前版本**：若当前可信私有 Planet 已含本机 Root，可以把同一份已验证文件放入 `config/planet`，使用 `external + ROOT_ONLY=0`，无需为了接管生成新签名。已有 `one/planet` 必须与其一致，或候选能通过对它的签名更新验证；旧部署若运行公共 Planet 则需单独处理可信基线，不要直接覆盖。缺少原签名密钥时可以继续使用现有可信 World，但不能为它签发新增 Root。
- **暂停**：identity、当前 World 或 Controller 数据不能确认时不启动；不要把空目录当成恢复。`.env` 模板不是自动迁移工具。

本项目格式和模式就绪后可执行下面的补充备份。`doctor` 仅预检配置、路径和必要文件，不校验全部 Controller 数据或签名；它不能替代前面的原布局备份：

```bash
./manage.sh doctor
./manage.sh backup
```

镜像已准备、旧实例已停、数据及模式检查通过后首次接管：

```bash
./manage.sh up
./manage.sh status
```

登录 Web 后核对 Controller 地址、Network ID、成员授权、虚拟 IP、Network MTU、Web 用户和别名。`manage.sh status` 显示公开 World/Root 元数据及 peer 路径；客户端 `info/listnetworks/peers` 用于核对身份/网络/Root，精确 World ID/时间戳应看本地 API `/status` 或 `mkworld --inspect`，不能只看 CLI 的 ONLINE。容器 healthy 不等于业务验收。

## 从单 Root 扩展为多 Root

先在 B 按 [Root-only 安装步骤](../README.md#首次安装)完成 external staging 和独立身份生成，或采用[原生 systemd 方案](native-root.md)。下面命令仅适用于 B 的全新空目录和已有系统 ZeroTier 二进制；已有 identity 则沿用，不重复生成：

```bash
(
  set -eu
  umask 077
  install -d -m 0700 /srv/zt-root-b/one
  test -z "$(find /srv/zt-root-b/one -mindepth 1 -maxdepth 1 -print -quit)"
  zerotier-idtool generate /srv/zt-root-b/one/identity.secret /srv/zt-root-b/one/identity.public
)
```

只把 `identity.public` 交给可信签名发布者。签名目录必须保留当前 World 的：

```text
planet
previous.c25519
current.c25519
```

在 A/可信发布者处创建公开 `roots.json`（格式见[多 Root 发布流程](multi-root.md#发布流程)），保留 Root A 并加入 Root B 的完整公开 identity 和真实公网 `UDP/9994` 端点。确保本地已有前文构建的 `zerotier-planet:multi-root` 镜像；输出父目录要存在，release-001 本身必须不存在。生成过程无网络、signer 只读，不激活候选：

```bash
install -d -m 0700 /srv/planet-releases
./planet-bundle.sh zerotier-planet:multi-root \
  /srv/zerotier-planet/one \
  ./roots.json \
  /srv/planet-releases/release-001
```

候选目录只包含 `planet`、`roots.json`、`SHA256SUMS`。在任何 Root 激活前核对：

```bash
docker run --rm --network none --entrypoint /usr/local/libexec/mkworld \
  -v /srv/zerotier-planet/one:/signer:ro \
  -v /srv/planet-releases:/releases:ro \
  zerotier-planet:multi-root \
  --verify-update /signer/planet /releases/release-001/planet

(cd /srv/planet-releases/release-001 && sha256sum -c SHA256SUMS)
```

校验和只验证传输完整性，还要通过可信渠道核对哈希和发布来源。**在修改 A 的 .env/config/planet 前做一次原状态备份**，以免只留下新配置；将同一份候选经可信 SSH 传输到 A/B 的专用 `config/planet`。A 使用 `external + ROOT_ONLY=0`，B 使用独立 `DATA_DIR/CONTAINER_NAME`、`external + ROOT_ONLY=1`，且 identity 必须已在候选中。B 不复制 A 的 `controller.d/`、Web 状态、token 或整个 `one/`。

先启动并独立验证 B，再及时滚动更新 A；不要让 A 长期以 generated 运行在已发布的多 Root World 上。下面分两台主机执行，不是连续在 A 的同一个 checkout 执行：

```bash
# B（独立工作区/主机，已准备 identity 和 config/planet）
./manage.sh doctor
./manage.sh up
./manage.sh status

# A（已保留原状态备份并将 .env 改为 external，候选放到 config/planet）
./manage.sh doctor
./manage.sh upgrade
./manage.sh status
```

两台 Root 必须使用同一份签名 Planet，但每台 Root 的 ZeroTier identity 不同。客户端只有安装包含 A/B 的同一份 Planet 后，才可能使用 B；Network ID 和已有虚拟 IP 不需要变化。

签名更新可能被在线传播，不能假定它会等到手动替换文件才被接受，也不能假定所有旧客户端都会自动更新。滚动安装时核对每个节点当前版本，保留独立管理通道；之后再执行隔离客户端中转演练。

## 回归证据与验收

`node tests/multi-root.mjs IMAGE` 使用临时数据、无宿主端口的 `--network none` 容器，覆盖当前镜像 generated 单 Root → external 双 Root 的同挂载转换：World ID 不变、时间戳增加，identity、签名密钥、Controller 网络/成员配置（含授权和固定 IP）、Web 密码/别名/session key 保留。它不是任意历史镜像兼容性证明，也不测试公网 NAT 或切流耗时。上线仍需比对旧项目数据清单，并在自己的客户端版本和网络上验收。

## 切换和回退边界

- 多 Root 是客户端上游路径冗余，不是按 Root 列表顺序的主备控制器。
- 不保证秒级、无损或已有 TCP 会话不间断；切断 Root 后客户端收敛时间取决于版本、缓存路径、NAT 和探测周期。
- Controller 仍然单活。不要在 A/B 同时启动相同 `controller.d/`。需要人工 Controller 备用时，按 [Controller-only 手动备用](controller-standby.md) 使用离线快照、guard 和明确 fencing 证据；该流程不支持混合 Controller+Root 自动迁移或自动选举。
- `generated` 模式的镜像升级失败时，`manage.sh upgrade` 可尝试旧镜像回滚。
- `external` 模式失败时只保留备份和回滚标签，不自动激活旧镜像；先确认旧入口支持当前 signed World。
- 镜像回退不等于 World 回退。拓扑恢复必须签发时间戳更高的新 Planet，不能直接下发旧文件。
- Cloudflared、Nginx、Web 3443 代理和 Root UDP/9994 是独立层；更换 Web 入口不会替代 Root 的 UDP 路径。

详细的 Root-only systemd 模板、监听 API 限制和隔离客户端验证见[同一 Planet、多 Root 与切换](multi-root.md)和[系统 ZeroTier Root-only](native-root.md)。
