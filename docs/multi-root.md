# 同一 Planet、多 Root 与切换

已有单 Root 项目迁移到本项目的保守步骤见[原有 Planet 原地升级](in-place-upgrade.md)。本文重点说明统一签名 World、独立 Root 身份和切换验证边界。

## 适用范围

一个签名的 Planet 可以列出多个不同身份的 Root。客户端仍加入原来的 Network ID，保留原 Controller 的授权、路由和地址分配，因此不必另建 `172.16.101.0/24`，也不必在服务配置里切换 `172.16.100.x`。

```text
同一签名 Planet ── Root A（独立 identity，公网 A:UDP）
               └─ Root B（独立 identity，公网 B:UDP）

客户端 ── 原 Network ID / 原虚拟 IP ── 客户端
                    │
             原 Controller（另行做单活容灾）
```

必须区分三个对象：

| 对象 | 多 Root 时如何处理 |
| --- | --- |
| Root 的 `identity.secret/public` | 每个 Root 各自生成；不能复制同一身份同时上线 |
| World 的 `previous.c25519` / `current.c25519` | 只由发布者保管；普通 Root 不需要这些签名私钥 |
| Controller 的身份和 `controller.d/` | 保留原身份与数据才能保留原网络；多 Root 不会自动复制 Controller |

节点身份并不绑定公网 IP。IP 变化不要求更换 Controller 身份。可以迁移原 Controller，但必须单活，不能把同一身份的数据目录同时在两台机器启动。

默认兼容的 `mkworld` 使用 ZeroTier 1.14.2 格式，最多 4 个 Root，每个 Root 最多 32 个稳定端点。每个端点必须是 `IPv4/端口` 或 `IPv6/端口`，不是 HTTPS URL；Cloudflare HTTP Tunnel / Nginx HTTP 代理不能替代此 UDP 路径。

## 两种运行方式

| 环境变量 | 含义 |
| --- | --- |
| `PLANET_MODE=generated` | 默认原单 Root 模式，端点变化时自动重新签名 |
| `PLANET_MODE=external` | 使用 `config/planet` 中统一发布的签名文件，不自动生成新的 world |
| `ROOT_ONLY=0` | 保留 Web UI 与 Controller 的原有运行方式 |
| `ROOT_ONLY=1` | 只启动 ZeroTier，不启动 Web UI；拒绝使用已经有 Controller 网络的数据目录 |

推荐主机 A 使用 `external + ROOT_ONLY=0`，备用主机 B 使用 `external + ROOT_ONLY=1`。B 的服务身份也应与该主机已有的普通 ZeroTier 客户端身份分开，不能覆盖 `/var/lib/zerotier-one` 的现有客户端状态。

`IP_ADDR4`、`IP_ADDR6` 在 external 模式不会改写 Planet。对外地址/UDP 端口必须与签名 manifest 匹配；调整端点时必须重新发布签名文件。`ZT_PORT` 决定本地实际监听端口。

## 从已有单 Root 项目原地接入

当前项目可以接管已有的单 Root Planet/Controller 持久化目录。原地升级的目标是保留原 Controller identity、`controller.d/`、Network ID、成员授权、虚拟地址、Web 用户和 session key，再把镜像和管理脚本升级到当前版本；它不是把同一份目录复制到 B 后同时启动两个 Controller。

完整的布局核对、仓库外备份、镜像准备和停旧接管命令以[原地升级指南](in-place-upgrade.md)为准。跨 Compose 工程时，旧容器停止后仍占用原名字，新实例需使用不同容器名，或经确认后将旧容器改为备份名称。不要使用 `docker compose down -v`，不要删除原 identity、签名密钥、Controller 或 Web 状态。

日常升级保持现有 `PLANET_MODE`。旧单 Root 只有在原签名密钥、分发 Planet、World 与端点记录完整且匹配时，才能安全沿用 generated；已有多 Root 不能转回 generated。若当前可信私有 Planet 已包含本机 identity，可以用 external 接管该版本，不必重新签名；但扩展 Root 仍需原 World 的签名材料。不要把旧部署可能使用的内置公共 Planet 当成私有 World 的更新基线。材料或签名链不能确认时暂停迁移，不生成替代密钥。

原地多 Root 接入顺序：

1. B 使用专用空目录和新 `identity.secret/public`，不复制 A 的 `one/`、Controller 数据、Web 状态或 token。
2. 发布者保留 A 的 Root identity，在 `roots.json` 中加入 B 的公开 identity 与真实公网 UDP 端点，运行 `planet-bundle.sh` 生成候选。
3. 用 `mkworld --verify-update` 检查候选相对于当前 World 的签名链和更高时间戳，并核对 `SHA256SUMS`；输出目录必须是新目录，候选未验证前不能覆盖生产 `config/planet`。
4. 在修改 A 的 `.env` 或 `config/planet` 前备份原状态，再把同一份候选分别放入 A/B 的专用 `config/planet`。A 使用 `external + ROOT_ONLY=0`，B 使用 `external + ROOT_ONLY=1`。Controller 保持单活。
5. 先启动并独立验证 B，再及时滚动更新 A，核对 `peers`、公网 UDP 和隔离端点业务。不要让 A 长期以 generated 运行在已发布的多 Root World 上。升级脚本失败时，external 模式只保留备份和回滚标签，不自动激活旧镜像；人工恢复前必须确认旧镜像支持当前 signed World。

如果只是更新当前源码而不增加 Root，审查并保存本地改动后执行 `git pull --ff-only`、`./manage.sh doctor`、`./manage.sh upgrade`，保持现有模式和数据路径。如果要把单 Root 转成多 Root，不能只改 `PLANET_MODE=external`；必须同时提供已验证的 `config/planet`，并确保其中包含本机 Root identity，否则入口脚本会拒绝启动。

## 发布流程

以下是操作模板，先替换实际路径和镜像名；不是自动修改生产环境的脚本。

1. 备份主机 A 的完整数据目录，保留原 identity、World 签名密钥和 Controller 数据。记录当前 Planet SHA-256、网络 ID、客户端 IP。
2. 在 B 的专用空目录生成独立 Root 身份，只把 `identity.public` 带给发布者。提前验证 B 的公网 UDP 端口，并确认其与现有客户端端口不冲突。
3. 根据原 Planet 的公开 Root identity 和 B 的 `identity.public` 编写 `roots.json`，保留原 Root A。发布者只从只读挂载的原数据目录取得签名材料。
4. 生成候选包，检查差异和签名链。**候选包产生不等于激活**。
5. 把同一份候选 `planet` 放进各 Root 的 `config/planet`，使用 external 模式滚动启动。先验证备用 Root，再更新原 Root；原 Controller 不应被重新初始化。
6. 分批给客户端安装相同 Planet，重启该客户端 ZeroTier，确认两个 PLANET peer。不要同时操作承担唯一 SSH 通道的两台客户端。
7. 验证实际中转路径并做断路演练。保留至少一条不依赖待停机主机的管理通道。

B 身份准备示例（镜像需已构建；目录必须为新实例专用，已有 identity 应沿用，不能重复生成）：

```bash
(
  set -eu
  umask 077
  install -d -m 0700 /srv/zt-root-b/one /srv/zt-root-b/config /srv/zt-root-b/dist
  test -z "$(find /srv/zt-root-b/one -mindepth 1 -maxdepth 1 -print -quit)"
  docker run --rm --network none --entrypoint zerotier-idtool \
    -v /srv/zt-root-b/one:/work \
    zerotier-planet:multi-root \
    generate /work/identity.secret /work/identity.public
)
```

`roots.json` 只含公开数据。不要把 `identity.secret` 或 `initmoon` 生成的含签名密钥的完整 JSON 复制进去：

```json
{
  "roots": [
    {"identity": "原Root的完整identity.public", "stableEndpoints": ["203.0.113.10/9994"]},
    {"identity": "备用Root的完整identity.public", "stableEndpoints": ["198.51.100.20/9994"]}
  ]
}
```

发布者的 `SIGNER_STATE` 必须含 `planet`、`previous.c25519`、`current.c25519`。如果 World 曾轮换更新密钥，应由熟悉该签名链的管理员准备与当前 world 匹配的 signer；脚本不会擅自生成替代密钥。

```bash
install -d -m 0700 /srv/planet-releases
./planet-bundle.sh zerotier-planet:multi-root \
  /srv/zerotier-planet/one ./roots.json /srv/planet-releases/release-001
```

输出目录必须尚不存在，且不能位于 signer 内部；输出只有 `planet`、`roots.json`、`SHA256SUMS`。签名在无网络的临时内存文件系统里进行，原数据只读挂载，不会修改运行中的 Root。候选包用原世界要求的签名密钥验证，并强制提升时间戳。

调试工具示例：

```bash
docker run --rm --network none --entrypoint /usr/local/libexec/mkworld \
  -v /srv/planet-releases:/releases:ro zerotier-planet:multi-root \
  --inspect /releases/release-001/planet

docker run --rm --network none --entrypoint /usr/local/libexec/mkworld \
  -v /srv/zerotier-planet/one:/signer:ro \
  -v /srv/planet-releases:/releases:ro zerotier-planet:multi-root \
  --verify-update /signer/planet /releases/release-001/planet
```

`--inspect` 检查序列化结构并输出公开元数据，不代表验证了来源。首次导入仍需要通过可信渠道核对 SHA-256；后续更新使用 `--verify-update` 验证签名、同一个 World ID 和更高时间戳。

备用机 `.env` 的关键字段示例：

```dotenv
CONTAINER_NAME=myztplanet-root-b
DATA_DIR=/srv/zt-root-b
ZTNCUI_STATE_DIR=/srv/zt-root-b/ztncui-state
ZT_PROBE_STATE_DIR=/srv/zt-root-b/probe-state
ZT_IMAGE=zerotier-planet:multi-root
IP_ADDR4=198.51.100.20
ZT_PORT=9994
API_PORT=3443
PLANET_MODE=external
ROOT_ONLY=1
HTTP_HOST=127.0.0.1
HTTP_EXTRA_HOSTS=
```

主机 A 如果需要同时从本机回环和 ZeroTier 访问，可使用 `HTTP_HOST=127.0.0.1`、`HTTP_EXTRA_HOSTS=172.16.100.97`。两个地址进入同一个登录后的控制中心和 Root 拓扑页；`HTTP_EXTRA_HOSTS` 只允许明确 IP，不是网段。备用 Root 的 `ROOT_ONLY=1` 不启动管理页，管理入口仍由当前单活 Controller 提供。

确认 `one/identity.public` 与候选 Planet 中 B 的 identity 完全一致，再运行 `./manage.sh up`。不要直接复用 A 的 `.env` 或整个 `one/`。

## 统一管理页面与局域网访问

### 宿主机 Root 分流策略诊断

Controller 的进程健康、Planet 文件一致和独立探针可达，都不能证明宿主机允许 Controller 的 ZeroTier UDP 流量。若宿主机只允许经一台已停用的 Root 转发，客户端可能长期停在“正在请求配置”，而 Web 页面仍显示服务健康。

可以在 Controller 主机上运行只读诊断，将已知 `ZT_ROOT_A_IN/OUT` 规则和 `zt-root-a-drain.service` 的状态写入配置目录：

```bash
./manage.sh diagnose
```

需要每分钟自动刷新时，可以安装仓库提供的受限 systemd timer：

```bash
./manage.sh diagnose --install-timer
```

页面会把允许的 UDP 端点映射回签名 Planet 中的 Root，并区分以下状态：未检查、快照过期、规则已停用、允许的 Root 没有近期回应、只有一条可用路径和多条可用路径。缺少快照、双栈采集不完整、规则包含未知匹配条件或端点端口不一致时会显示需要复核；诊断不会修改防火墙。

这项检查只覆盖仓库约定的 `ZT_ROOT_A_IN/OUT` 和 `zt-root-a-drain.service`，不代表云安全组、nftables 或其他主机/上游防火墙已经检查。退役 Root 后应先移除或停用旧分流规则，再分别验证 Controller 经剩余 Root 获取配置；不要只看 ZeroTier 进程为 healthy。

首页与连接监控页共享同一套 Root 拓扑模型；`/controller/roots.json` 提供同样的数据，必须登录后才能访问。页面展示：

- Controller 身份、World ID/发布时间戳、统一签名或自动生成模式。
- 每个声明的 Root 的身份 ID、稳定 UDP 端点、本实例标记。
- 服务器和可选本机客户端探针两个独立视角的实际路径、延迟、最近接收回应时间。
- 管理监听地址及状态。一个 Root 出现在 peer 列表中、或者仍带有缓存的 `DIRECT` 路径，都不自动等于近期可达。
- “切换准备度（观测）”：只有声明了远端 Root、当前服务实例至少观测到一个远端 Root、且运行中的 World ID/时间戳与配置元数据一致时才显示为可观测。独立探针只能作为辅助证据，不能代替 Controller 的上游路径。它是运维前置条件，不是客户端已经切换的承诺。

Root 路径必须活跃且在最近 90 秒内收到回应才显示“近期有回应”；无回应、过期、尚未识别为 PLANET、探针不可用分别展示。页面保留服务器、探针或两者的证据来源；仅探针看到 Root 会明确标注为“仅探针可达”，不能作为 Controller 已经能走该 Root 的证明。两侧都没有有效回应时显示“未观测到备用 Root”。这里的延迟是 ZeroTier peer 路径延迟，不是 HTTP 请求耗时，也不是全部业务流量的延迟。远端 Root 的 CPU、累计流量及所有客户端之间的路径不在这个观测范围内；当前流量卡片只统计本实例。

监控页还按 Controller 网络汇总成员数、已授权数、本实例已观测 peer 的活跃路径比例，以及可选本机探针观测到的 DIRECT/RELAY/未知数量。总数按网络成员记录累加，同一设备加入多个网络会重复计数。未观测到的成员单独列为未知，不计入本 Root 已观测路径可达率的分母；成员经其他 Root 通信时，不能把本 Root 的低比例当成全网离线。DIRECT/RELAY 只是路径观测，不等于业务连通性，也不能从 Controller 单方面生成终端两两直连矩阵；要判断 `.125` 与 `.175` 是否直连，仍需在端点查看 `peers` 或执行端到端探测。异常负延迟会被单独标记（正常未知值 `-1` 不告警），因为某些旧客户端可能把异常延迟带入 Root 选路。当前为按页面请求采样，不提供历史丢包率、SLA 或任意端点间流量统计。

如果需要把“Root 路径可达”与“实际业务端口可达”分开，可将 [examples/endpoint-probes.json](../examples/endpoint-probes.json) 复制到持久化 `config/endpoint-probes.json`。监控会按配置执行最多 32 个、最多 8 路并发的 TCP connect，超时限制为 100–5000ms，每次页面采样另有约 10 秒总预算，建连后立即关闭。只接受不带接口 zone 的字面 IP，不做 DNS 解析、不执行远程命令；状态分为可达、拒绝、超时、不可达、禁用和配置无效。缺少文件时显示“未配置”，不会自动扫描端口。该结果仍只代表管理实例到目标 `IP:port` 的可达性，不代表 ZeroTier 直连、应用协议健康或流量经过哪个 Root。

管理入口建议使用回环主监听，加上明确的 ZeroTier 地址：

```dotenv
API_PORT=3443
HTTP_HOST=127.0.0.1
HTTP_EXTRA_HOSTS=172.16.100.97
```

访问 `http://172.16.100.97:3443` 即进入同一个后台；这不会把管理页面开放到公网。不能把 `172.16.*` 或 `172.16.0.0/16` 作为监听地址，必须填写本机实际持有的 IP。主监听地址必须可绑定，附加 ZeroTier 地址若在启动时尚未出现会重试，不影响回环管理入口。两个地址共用账户、会话存储和业务数据，但浏览器 Cookie 按主机隔离，换 IP 不保证自动保留登录。

这是管理页面的监听配置，不会自动代理其他主机的业务端口。业务服务如需统一入口，应另外配置 Nginx upstream；Cloudflare 隧道、Root UDP 路径以及 Controller 单活是独立的部署事项。管理页面如需 HTTPS，可由 Nginx 代理到 `127.0.0.1:3443`，本次无需迁移 Cloudflare。

## 在线更新、回滚与监控

- ZeroTier 协议支持已知上游提供的、签名链有效的更高时间戳 world 更新；但部署不能假定所有版本/改版客户端都会立即在线更新。应分批替换文件、重启并核对，而不是只看服务器的新文件。
- 本项目 external 启动会拒绝低于本地运行文件时间戳的候选，或签名链不匹配的候选。不要把 `config/planet` 留在旧版本。如果守护进程在线学习到新 world，健康检查会提示运行文件与配置/下载文件不一致；验证签名后同步当前发布版本再重启。
- **拓扑回退需要签发时间戳更高的新 world**，其 roots 恢复为原列表。不能简单重新下发旧文件；已更新的在线客户端会拒绝时间戳倒退。
- 镜像回滚与 World 回滚不同。旧镜像可能把 external 当成普通单 Root，不能直接回滚到不支持多 Root 的入口脚本。`manage.sh upgrade` 在 external 模式升级失败时保留备份和旧镜像标签，但禁止自动激活旧镜像，交由管理员核查恢复；generated 模式保留原来的镜像回滚。任何镜像回滚都不等于整个 Planet 签名链的事务回滚。
- 管理页面按 `config/planet-roots.json` 识别预期 Root，备用私有 Root 不再被误报为公共 Root。该元数据在启动时刷新；配置与 runtime hash 不一致时应先核查发布状态。

## 热切换与流量配额

多 Root 是冗余上游，不是“列表第一台主用、第二台备用”。ZeroTier 按可达性/路径质量选上游，双活时两台都可能产生中转流量，也不会读取云厂商流量额度。

当 A 流量已用尽，正确次序是：B 已经公网可达 → 客户端已经识别 B → 确认经 B 的中转可用 → 再让 A 的 Root 路径不可用。不能先停 A 再期待只认识 A 的离线客户端自动发现 B。

如果 A 同时承载 Controller，不应直接停整个 `myztplanet` 来节流。已有连接/缓存可能短期继续通信，但新成员授权、配置刷新与重连不能据此保证。后续应规划 Controller 的单活迁移或拆分：

- 保留原 Controller 身份、Network ID、成员授权与固定地址，停旧实例后再启动迁移实例。
- 不要在 A/B 同时启动同一份 Controller identity；文件 rsync 本身不是集群或防双主机制。
- 切换时的管理通道、数据一致性与旧实例隔离应单独演练。

## 验证标准

两台客户端能 ping 通不等于经过了 Root。已经 DIRECT 的节点可能在所有 Root 不可用时仍维持一段时间，不能用这种测试证明中转容灾。

可靠实验应使用独立身份、独立测试网段和隔离网络命名空间：

1. 禁止实验客户端之间的物理直连，只允许到测试 Root 的 UDP；关闭实验客户端的 TCP 公共 fallback。
2. 记录 peer 中对端为 RELAY、Root 的实际物理端点、Root 收发计数。
3. 连续带时间戳 ping/应用请求，切断当前 Root 路径，记录连续丢包、恢复耗时和客户端 IP 是否变化。
4. 反向切换再验证；区分 Root 不可用、Controller 不可用、整机不可用。
5. 不能把待测试的 ZeroTier 网络当作两个 Root 的唯一 underlay，然后宣称已经验证整个原网络的独立容灾。

### 多 Root 的实际优化边界

- 多 Root 负责上游冗余和中转选路，不提供 Controller 多主写入，也不是按 Planet 文件 Root 顺序的主备。Controller 仍应保持单活；备份数据可以同步，但不能同时运行同一 Controller identity。
- 正常运行时应让所有签名 World 中的 Root 都可达，由客户端按路径质量选择。为了省某台 Root 的流量而在宿主机临时丢弃其 UDP，会让客户端仍看见该 Root，却可能在旧版本选路异常时黑洞；若要长期 B-only，应签发更高时间戳、只含 B 的候选 World，分批更新客户端，并准备更高时间戳的恢复 World。
- 客户端兼容性应作为 Root 切换前置条件：至少抽样验证 Windows、Android/移动网络和旧版 1.12/1.14 客户端的 Root peers、真实中转和端到端业务，不要只看 Root `DIRECT` 或服务器收发计数。
- 监控只能发现风险，不能把 Controller 视角伪装成端到端事实。更完整的自动化方案是部署受控端点探针，对关键节点对执行定时 ping/TCP/SSH 探测，并把结果与 Root path、负延迟和中转比例关联。

离线回归测试（要求本机已构建测试镜像）：

```bash
docker build -t zerotier-planet:multi-root .
node tests/ui-models.cjs
node tests/communication-stats.cjs
node tests/endpoint-probes.cjs
node tests/install-config.cjs
node tests/root-status.cjs
node tests/ui-listen.cjs
node tests/manage-upgrade.cjs
node tests/native-root.cjs
sudo node tests/multi-root.mjs zerotier-planet:multi-root
```

容器回归需要 root 读取 ZeroTier 自动收紧为 0700 的临时状态目录；不要为了通过测试放宽生产数据权限。该测试仅使用临时目录和 `--network none` 容器，覆盖双 Root 签名、递增时间戳、错误签名/私钥 identity/端口拒绝、仅公开文件的候选包、external 启动/升级/旧版本拒绝、原单 Root Web 服务启动、双地址共享后台、中英文页面、登录保护和拓扑数据异常时的页面降级。

同一测试还覆盖当前镜像 generated 单 Root → external 双 Root 的同挂载转换：World ID 保持、时间戳增加，原 identity、签名密钥、Controller 网络/成员授权/固定 IP 和 Web 密码/别名/session key 保留。它不代表任意历史镜像均可直接替换，也不衡量真实公网切流时间。`install-config.cjs` 单独验证 external 暂存、已有 `.env` 复用及严格启动前置检查，不启动服务。

### 2026-09-20 两机隔离实验记录

本次用两台主机上独立的实验身份和 `10.203.219.0/24` 测试网络验证，不替换生产 Planet 或 Controller。客户端命名空间禁止实验客户端之间的物理 UDP 直连，关闭公共 TCP fallback，仅放行实验 Root 路径；对端 peer 显示 RELAY。

- 备用 Root B 公网 `UDP/9994` 可以通信，实验用的 `UDP/19994` 在主机间不可达；Root A 的一段实验物理路径经现有 ZeroTier 网段转发。
- 最后一次强制 A-only 基线后开放 B，再停 A 的连续测试中，停 A 后约 3 分钟记录到的 144 次探测全部失败，未记录到恢复点。原始记录保留在实验机 `/tmp/zt-forced-failover-1789907476798.jsonl`。
- 后续在 A 仍停止、未重启实验客户端的情况下抽测，10 次 ping 全部成功，平均约 11.1 ms；两端仍保留原测试 IP，并均能直接联系 Root B，对端仍为 RELAY。
- 因为连续测量结束与后续抽测之间没有覆盖记录，**不能据此给出准确切换耗时，也不能声称秒级或无缝热切换验收通过**。只能确认经 B 的通信可以恢复。
- 实验服务已停止并移除临时容器，测试数据、签名材料和日志仅保留在两机各自的临时实验目录供复核；未写入仓库。实验不包含完全摆脱生产 ZeroTier 物理承载依赖的整机容灾验证。

上述历史实验未覆盖的生产公网 Root 路径，已在下述后续实验中复测。Controller 单活恢复仍属于独立容灾工作，不由多 Root 自动提供。

### 2026-09-21 生产双 Root 的隔离客户端复测

生产 A/B Root 已使用同一份签名 Planet。两台主机分别新建独立客户端 identity 和 Docker 网络命名空间，使用临时测试网络 `10.204.77.0/24`；没有替换普通客户端身份/IP，没有停止生产 Root 或 Controller，也没有改动宿主机/云防火墙。实验 SSH 走备用机公网，不依赖被测 ZeroTier 网络。

客户端版本为 1.16.2 和 1.16.1。关闭 TCP fallback 和端口映射；在两个实验命名空间内只允许各公网 Root 的 UDP/9994，禁止普通 peer 的物理 UDP。两端 peer 记录持续没有对端直连路径，规则计数验证流量经允许的 Root；公网 hairpin 在两端均实际可用，不再通过旧 ZeroTier 网段承载实验 Root 路径。

每 5 秒分别进行一次双向 ping，并记录 Root RTT、路径、`lastReceive`、`preferred`；各阶段另存防火墙计数。结果中的时间是首次成功样本时刻，不是精确到毫秒的恢复边界：

| 场景 | 连续观测窗口 | 双向结果 |
| --- | --- | --- |
| B 已可达后屏蔽 A，只允许 B | 420 秒 | 各 84/84 个样本成功，平均 RTT 约 8.9 / 8.6 ms |
| B 正在承载时屏蔽 B，只允许 A | 420 秒 | 各前 49 个样本失败，首次成功样本约为第 245 秒，随后各 35/35 成功，平均 RTT 约 10.7 / 10.4 ms |
| 另建两客户端，先仅经 A；屏蔽 A 后立即开放此前不可达的 B | 420 秒 | A 侧首个样本失败、第 5 秒首次成功，此后 83/83 成功；B 侧首个样本约第 2 秒即成功，84/84 成功；平均 RTT 约 9.0 / 9.3 ms |
| 两个 Root 路径恢复 | 30 秒 | 各 6/6 成功 |

第一行只能证明 B 独立中转正常，不能证明从 A 故障开始零丢包，因为开放 B 后客户端可能已选中 B。第二行记录了真正的旧路径失效与自动收敛，期间没有重启客户端或更换 Planet/IP。实验网络的两端 IP 保持 `.1`、`.2`。

第三行是单独重建实验客户端后的突发 A 路径故障；此前 B 没有有效路径，故该结果不能作为所有双活客户端的 5 秒上限。与第二行的 245 秒结果一起看，备用路径状态、缓存 RTT 和旧路径年龄会明显影响收敛时间。两轮实验完成后，实验容器/命名空间和临时 Controller 网络均已清理；原有两个生产 Network ID、成员数据和普通客户端 IP 保持不变。原始日志归档在运维机未入库的 `backups/failover-20260921/`，未将节点私钥或令牌加入仓库。

这一结果与客户端保留旧 Root 路径约数分钟的行为相符。**双 Root 能提供自动中转冗余，但不能承诺秒级或无缝热切，也不保证既有 TCP/应用会话不超时。** 如果业务要求确定的秒级恢复时间，需要另外设计并验证客户端故障检测/切换机制；服务端多列一个 Root 无法改变已经安装的客户端选路算法。

该实验模拟的是客户端到 Root 的 UDP 路径故障，不是完整主机断电或 Controller 数据容灾。其他客户端版本、不同 RTT 比例和 NAT 环境的结果可能不同；5 秒周期的 ping 采样也不等同于对所有业务包的零丢包保证。
