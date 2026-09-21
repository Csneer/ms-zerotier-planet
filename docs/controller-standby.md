# Controller-only 手动备用

本文说明如何为现有 Controller 准备一台**手动接管**的备用机。它只覆盖
`CONTROLLER_ONLY=1`、`ROOT_ONLY=0`、`PLANET_MODE=external` 这一种严格角色；备用实例保留原 Controller identity、`controller.d/`、Network ID、成员授权和地址分配，但不作为 Planet Root 运行。

这不是 Controller 集群、自动选举或无损热切换。项目没有 quorum、租约、分布式锁、远程断电或自动 fencing。任何时刻只能有一台实例使用同一份 Controller identity 和 Controller 数据；必须先确认旧主机不会再次启动，再手动 promote 备用机。

## 角色边界

Controller 与 Root 是两个独立的角色：

| 角色 | identity | 是否运行 Controller | 是否列入签名 Planet 的 Root | 典型配置 |
| --- | --- | --- | --- | --- |
| 主 Controller | 原 Controller identity | 是 | 必须按当前 World 角色决定 | `CONTROLLER_ONLY=0` |
| Controller-only 备用 | **与主 Controller 相同**，从受保护快照恢复 | 仅在 promote 后运行 | **不能列入当前候选 World 的 Root** | `CONTROLLER_ONLY=1`, `ROOT_ONLY=0`, `PLANET_MODE=external` |
| Root-only 备用 | 独立新 identity | 否 | 是 | `ROOT_ONLY=1`, `CONTROLLER_ONLY=0`, `PLANET_MODE=external` |

`CONTROLLER_ONLY=1` 与 `ROOT_ONLY=1` 互斥，入口脚本会拒绝这种配置。Controller-only 实例的 identity 如果仍出现在 `config/planet` 的 Root 列表中，启动也会被拒绝。当前项目**不宣称支持 Controller+Root 混合角色的自动备用或自动迁移**：如果现有主机使用同一个 identity 同时运行 Controller 和 Root，不能只复制数据或修改 `.env` 就得到安全的 Controller-only 备用。

要保留 Root 中转冗余，请另行使用 [Root 接入工具](root-onboarding.md) 为每个 Root 生成独立 identity，并用同一签名 World 滚动更新 Root。Root-only 备用不接管 Controller，Controller-only 备用也不承担 Root 中转。

## RPO、RTO 与快照要求

备用机使用离线一致性快照，不做实时复制。推荐在主机 A 执行：

```bash
./manage.sh backup
```

默认 `backup` 会短暂停止本实例、复制四个持久化目录并生成 `SHA256SUMS` 和 `manifest.env`；其中 `manifest.env` 标记 `consistency=offline`。快照包含 identity、Controller 网络和成员数据、World/Planet 文件、Web 用户密码哈希和 session key，也可能包含 `previous.c25519`、`current.c25519`、`moon.json` 等签名材料，属于高敏感备份，应通过已验证的 SSH 主机密钥或加密介质传输，不要放入 GitHub、Web 下载目录或公开对象存储。stage 会保留这些受保护文件以便完整接管；Controller-only 备用不是公开签名服务，不要把其 signer 目录暴露给 Root 或 Web。

`./manage.sh backup --online` 只适合作为补充。`controller stage` 默认拒绝 online/unknown 快照；只有清楚接受一致性风险时才使用 `--accept-unverified-snapshot`。在线快照可能在成员授权或网络配置写入过程中捕获不一致状态。

RPO 是“最后一个成功离线快照”到主 Controller 故障之间的时间：快照之后新增的 Network、授权、固定 IP、别名或其他 Controller/Web 状态可能丢失。它不是 ZeroTier 的实时复制保证。RTO 还包括传输快照、核验、旧主隔离、stage、verify、人工 fence/promote 和客户端重新建立控制连接的时间；本项目不承诺固定秒数或现有业务 TCP 会话不中断。

## 准备 Controller-only 备用机

备用机要使用自己的工作目录、绝对数据路径和唯一容器名。不要把主机 A 的运行目录同时挂载到 B，也不要让旧容器和新容器共享 identity。

先准备当前版本镜像，然后只创建配置，不启动服务：

```bash
# Use the same tag that will be referenced by the standby .env.  `build.sh`
# otherwise defaults to `zerotier-planet:1.16.2-optimized`, which would leave
# the explicitly named `multi-root` image below unavailable locally.
IMAGE=zerotier-planet:multi-root ./build.sh

./install.sh \
  --controller-only 1 \
  --planet-mode external \
  --root-only 0 \
  --data-dir /srv/zt-controller-standby \
  --image zerotier-planet:multi-root \
  --configure-only
```

Controller-only 不发布 Planet Root，因此不需要 `--ip`；如果 `.env` 中保留了 `IP_ADDR4`，应为空或改为现场实际值，不能使用示例地址。配置至少应包含：

```dotenv
CONTAINER_NAME=myztplanet-controller-standby
DATA_DIR=/srv/zt-controller-standby
ZTNCUI_STATE_DIR=/srv/zt-controller-standby/ztncui-state
PLANET_MODE=external
ROOT_ONLY=0
CONTROLLER_ONLY=1
IP_ADDR4=
```

`install.sh --configure-only` 和 `./manage.sh doctor --staged` 允许外部 identity/Planet 尚未放入时进行路径和 Compose 检查；正常的 `doctor`、`up` 和健康检查仍会严格要求完整文件。不要在备用机上执行普通首次安装来生成一个新 Controller identity。

## 生成 Controller-only 的 Planet 候选

Controller-only 候选中的 Controller identity 必须不在 Root 列表中。若当前 Controller identity 仍是 Root，必须先由可信发布者签发一个**更高时间戳**、从 Root 列表移除该 identity 的 World，并为实际中转另外安排独立 Root identity；不能通过删除本地文件绕过检查。

候选发布仍由持有原 World 签名链的离线发布者完成：

```bash
./planet-bundle.sh zerotier-planet:multi-root \
  /srv/planet-signer/one \
  /srv/planet-releases/controller-standby-roots.json \
  /srv/planet-releases/controller-standby-001

docker run --rm --network none --entrypoint /usr/local/libexec/mkworld \
  -v /srv/planet-signer/one:/signer:ro \
  -v /srv/planet-releases:/releases:ro \
  zerotier-planet:multi-root \
  --verify-update /signer/planet /releases/controller-standby-001/planet

(cd /srv/planet-releases/controller-standby-001 && sha256sum -c SHA256SUMS)
```

发布者必须核对 World ID、时间戳、签名链和最终 Root 集合。候选目录只应包含 `planet`、`roots.json`、`SHA256SUMS`；验证通过前不得覆盖任何生产 `config/planet`。候选文件可通过受保护的 SSH 传输到备用机，例如放在 `/srv/zt-controller-standby/incoming/planet`，然后在 `stage` 时用 `--planet` 指定。

## stage：导入并锁住快照

把主机 A 的离线备份和已验证候选安全传到 B 后，先检查配置：

```bash
./manage.sh doctor --staged
```

然后执行：

```bash
./manage.sh controller stage \
  /srv/zt-controller-standby/incoming/planet-YYYYMMDD-HHMMSS \
  --planet /srv/zt-controller-standby/incoming/planet \
  --yes
```

`stage` 会在本地完成以下检查，并且不会启动服务：

- 备份包含四个持久化目录、Controller 网络、identity、Web 用户和 session key，校验和一致；默认要求离线一致性。
- 备用配置是 Controller-only，identity 公私钥匹配，候选 Planet 有效且不把该 identity 列为 Root。
- 候选 Planet 与快照中的运行 Planet 属于同一 World，并通过签名链和时间戳验证。
- Controller 网络文件名和内容属于该 Controller identity；不接受其他 Controller 或客户端目录。

目标挂载目录必须是专用空目录，或已经处于 `staged`/`fenced` 状态的同一个备用实例。文件会先复制到临时目录，再按固定顺序逐个 rename 四个挂载；旧目录保留为 `.pre-standby-*`，发生中途错误时脚本会尝试回滚，不能把这个过程当作跨目录的分布式原子事务。验收前不要删除旧目录。stage 完成后会写入 `config/controller-standby.json`，状态为 `staged`；这个状态会阻止容器启动，以免备用机在尚未取得接管授权时成为第二个 Controller。

## verify：在 promote 前复核

```bash
./manage.sh controller verify
./manage.sh controller status
```

应核对输出中的：

- `state=staged`（或已 fence 后的 `fenced`）。
- `role=controller-only`、Controller ID 与主机 A 相同。
- `worldId` 相同、`worldTimestamp` 不倒退、`planetSha256` 是已核对的候选版本。
- `networkIds` 与主机 A 一致；成员授权、固定 IP、MTU 和 Web 用户应从已校验快照/接管后的控制台另外核对。
- 备用机没有 stale `moons.d/*.moon`，也没有把 Controller identity 当作 Root。

`verify` 只验证已导入的本地状态，不探测主机 A 是否真的停止，也不证明客户端已经改连备用 Controller。应保留独立公网/SSH 管理通道，另行执行客户端控制面和业务验收。

## fence：隔离旧主

Promote 前必须阻止主机 A 再次启动同一 Controller identity。优先顺序是：

1. 在旧主机停止旧容器或 systemd 实例，并禁用 `restart: unless-stopped`、systemd 自动重启、Watchtower、cron、云平台自动修复等启动来源。
2. 确认旧主机没有运行实例、没有监听 Controller API/Planet 端口，也没有其他容器挂载相同 `one/` 或 `controller.d/`。
3. 保留旧数据为只读/离线备份，不要在两个主机之间继续 rsync 正在运行的目录。
4. 如果旧主机可能恢复，优先关机或使用云平台/虚拟化层的独占 fencing；不确定旧主是否已隔离时不要 promote。

`./manage.sh controller fence` 是**本地**保护机制：它先写入 `state=fenced`，再禁用本地容器自动重启、停止容器并生成绑定目标备用实例 UUID 的 `controller-fence.json`。它不通过网络停止另一台主机，也不提供租约或仲裁。当前命令只接受 `CONTROLLER_ONLY=1` 的实例；对于仍是 `CONTROLLER_ONLY=0` 的混合主 Controller，命令会拒绝执行，必须由主机编排/云平台完成隔离并使用人工确认流程。

如果本地仍有容器，`fence` 还会检查该容器实际使用的镜像带有 standby startup protection 标签；旧镜像即使配置文件已经改成 Controller-only，也不能被当作可持久 fencing 的实例。先用新镜像重建或在主机/云平台层隔离旧容器，再继续接管。

如果某个已经配置为 Controller-only 的旧实例可以本地执行 fence：

```bash
./manage.sh controller fence \
  --target-instance STANDBY_INSTANCE_UUID \
  --yes
```

生成的 receipt 应通过受保护通道复制到 B。它只证明该本地实例写入了 fence 状态，不能证明网络外的主机已断电；仍要核对旧主机的实际运行状态。

## promote：人工接管

在 B 上确认旧主已隔离、`verify` 通过后，使用 fence receipt：

```bash
./manage.sh controller promote \
  --fence-receipt /srv/zt-controller-standby/incoming/controller-fence.json \
  --yes
```

若无法取得可信 receipt，只能在完成外部 fencing 后由有权限的管理员明确承担 split-brain 风险：

```bash
./manage.sh controller promote \
  --confirm-old-primary-fenced CONTROLLER_ID \
  --reason "old host powered off and automatic restart disabled" \
  --yes
```

`--reason` 至少 8 个字符。这不是自动验证；它会把人工声明记录进 standby guard。promote 会先写入 `state=active`，再使用已验证的本地镜像 image ID 强制重建 Compose 服务并等待 healthy。失败时会把 guard 恢复为 `staged`、停止备用服务且不会自动启动旧主或恢复旧镜像。

健康后应至少验证：

```bash
./manage.sh status
./manage.sh controller verify
docker inspect myztplanet-controller-standby \
  --format '{{.State.Health.Status}} {{.RestartCount}}'
```

然后从独立客户端核对 Controller API、Network ID、成员授权、固定 IP 和实际业务连接。Root peer/中转路径是另一层验收；Controller-only 备用本身不提供 Root relay。

## 失败、回退与再次演练

- `stage`、`verify` 或 `promote` 失败时不要手工删除 guard 或强行启动容器。先查看错误、保留 `.pre-standby-*` 目录和原始备份。
- `state=staged`/`fenced` 会阻止启动；只有重新 stage 或带有效 fencing 证据 promote 才能转为 active。
- promote 后回退不是自动选举。先停止并隔离当前 active Controller，制作新的离线快照，再在目标主机按同一流程 stage/verify/promote。
- 不要用旧 Planet 文件直接回滚签名 World；拓扑恢复必须发布更高时间戳、签名链有效的新 Planet。镜像回退与 Controller 数据回退是两件事。
- `manage.sh restore` 不用于替代 Controller standby 流程；存在 standby guard 时普通 restore 会拒绝启动式恢复，避免误激活第二个 Controller。

建议定期在隔离环境演练一次：备份、传输、stage、旧主 fencing、promote、客户端验收和回退，并记录实际 RPO/RTO。成功的 `docker healthcheck` 只说明本机服务启动，不等于所有成员已重新连接。

## 与 Root 接入工具的关系

新增 Root 使用 [root-manage.sh](../root-manage.sh) 和[Root 接入指南](root-onboarding.md)，流程是“准备独立 Root identity → 在原签名链上生成 add-only 候选 → 各 Root 分批激活”。例如：

```bash
./root-manage.sh prepare \
  --image zerotier-planet:multi-root \
  --data-dir /srv/zt-root-b \
  --endpoint 198.51.100.20/9994

./root-manage.sh add \
  --image zerotier-planet:multi-root \
  --signer /srv/planet-signer \
  --request /srv/zt-root-b/root-request.json \
  --output /srv/planet-releases/root-b-001 \
  --base-sha256 BASE_SHA256 \
  --dry-run
```

Root 接入工具不会复制 Controller、不会创建备用 Controller、不会启动或切换任何服务；它输出未激活的公开候选。Controller-only standby 则必须复制经过校验的 Controller 快照，且候选 Planet 不得把 Controller identity 列为 Root。两条流程不能互相替代，也不能因为 Root 候选已经可达就宣称 Controller 已具备高可用。
