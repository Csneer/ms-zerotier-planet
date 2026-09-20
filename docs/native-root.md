# 使用系统 ZeroTier 部署独立 Root-only

备用机已经安装 `zerotier-one` 时，可以复用二进制，用独立身份、数据目录和 systemd unit 运行第二个实例。只需要传输公开的签名 Planet 包和小型配置文件，不必下载完整 Web/Controller 镜像。

这适合[同一 Planet、多 Root](multi-root.md)中的备用 Root B。它不复制 Controller，不更换原 Network ID，也不影响本机已经加入网络的普通 ZeroTier 客户端。管理页面仍由当前单活 Controller 提供。

本文命令统一使用 `zerotier-root-b.service` 作为示例 unit 名称；现场如果采用 `zt-root-b.service` 等名称，安装后请把后续 `systemctl` 命令中的 unit 名称一致替换。

## 隔离边界

| 对象 | 已有客户端 | 新 Root B |
| --- | --- | --- |
| systemd unit | `zerotier-one.service` | `zerotier-root-b.service` |
| 状态目录 | `/var/lib/zerotier-one` | `/srv/zt-root-b/one` |
| identity | 保持原样 | 专用目录中生成新身份 |
| 主端口 | 通常 `9993` | `9994` |
| 加入/管理网络 | 保留已有网络 | 不 join，也不创建 Controller 网络 |
| Web UI | 原有部署决定 | 不运行 ztncui，禁用原生可选 Web 页面 |

不能复制另一节点的 `identity.secret`，不能复用 `/var/lib/zerotier-one`，也不能把 Controller 的 `controller.d`、Web 密码或 World 签名私钥复制给 Root B。旧部署遗留的数据目录也不应当作新实例的空目录使用。

“Root-only”在这里是部署约束，并不是一个裁剪掉 Controller 和 HTTP API 的专用二进制。系统 ZeroTier 仍有内置本地管理 API，也仍有管理网络的能力；拥有本地 `authtoken.secret` 的管理员可以调用这些能力。因此必须保护状态目录，不执行 `join` 或创建 Controller 网络，并核查网络列表为空。模板中的 `-U` 表示跳过权限检查及自动降权，以 root 身份运行这份专用实例；它不表示移除 API 或启用某种 Root-only 协议。

## 1. 先检查条件

以下命令在备用机执行，仅查询状态：

```bash
command -v zerotier-one zerotier-idtool jq systemctl
zerotier-one -v
systemctl status zerotier-one.service --no-pager
ss -lntup '( sport = :9993 or sport = :9994 )'
df -h /srv
```

需要 systemd、可执行的系统 ZeroTier 和空闲 `9994` 端口。确认公网 UDP `9994` 已在云安全组、宿主机防火墙和必要的 NAT 映射中放行；`ss` 只能证明本机监听，不能证明公网 UDP 可达。

先保留独立于 ZeroTier 的公网/控制台管理通道，再进行启动、停止和换 Planet 操作。不要让待测试网络成为唯一 SSH 通道。

## 2. 生成新身份

以下是新部署模板，只能用于新实例。若已经准备了 pending 目录或专用 identity，应核对并沿用它，不要再次执行生成步骤。

```bash
(
  set -eu
  umask 077
  install -d -m 0700 /srv/zt-root-b/one
  test -z "$(find /srv/zt-root-b/one -mindepth 1 -maxdepth 1 -print -quit)"
  /usr/sbin/zerotier-idtool generate \
    /srv/zt-root-b/one/identity.secret \
    /srv/zt-root-b/one/identity.public
)
```

只把 `identity.public` 交给签名发布者。发布者把它与原 Root A 的公开身份一起写入 `roots.json`，为 B 填写真实公网地址和 `/9994` 稳定端点，再使用 `planet-bundle.sh` 生成候选包。B 不需要 `previous.c25519`、`current.c25519` 或包含签名私钥的 `moon.json`。

## 3. 可信地安装签名包

发布者必须先在可信机器上执行 `mkworld --verify-update OLD NEW`，验证候选是当前已发布 World 的签名更新，然后通过已经校验主机密钥的 SSH 等可信通道发送候选包。不要为了传文件关闭 SSH 主机密钥检查。

假设 B 收到包的位置为 `/srv/zt-root-b/releases/release-001`，其中只有 `planet`、`roots.json`、`SHA256SUMS`。首先在该目录执行：

```bash
cd /srv/zt-root-b/releases/release-001
sha256sum -c SHA256SUMS
sha256sum planet
```

必须将第二条命令输出的 Planet SHA-256 与可信发布者提供的值逐字核对。仅有文件和同目录校验和不能认证来源，因为二者都可能被替换。`roots.json` 是方便检查的公开元数据，不是独立的信任根；首次安装信任来自发布者和经过验证的传输/哈希。

核对 Root B 的完整公钥确实在发布者提供的元数据中，并要求其稳定端点为这台服务器真实公网地址的 UDP `9994`：

```bash
(
  set -eu
  cd /srv/zt-root-b/releases/release-001
  zt_root_public=$(/usr/sbin/zerotier-idtool getpublic /srv/zt-root-b/one/identity.secret)
  jq -e --arg identity "$zt_root_public" \
    '.roots | any(.identity == $identity)' roots.json >/dev/null
  jq '.roots | map({nodeId: (.identity | split(":")[0]), stableEndpoints})' roots.json
)
```

在核对完成后安装文件。下面的 `examples/` 路径相对于本项目根目录；也可以只把这两个模板传给备用机后使用其实际路径。

```bash
install -m 0644 /srv/zt-root-b/releases/release-001/planet /srv/zt-root-b/one/planet
install -m 0600 examples/root-only.local.conf /srv/zt-root-b/one/local.conf
install -m 0644 examples/root-only.service /etc/systemd/system/zerotier-root-b.service
```

这是一份原生部署，不运行 Docker `entrypoint.sh`。systemd 模板检查必要文件存在，并拒绝实际 Controller 数据、符号链接或 World 签名密钥。只读查询 Controller API 也可能创建空的 `controller.d/network` 和 `controller.d/trace`，模板允许这些空目录，以免检查状态后无法重启。它不会替你验证签名链或自动安装 `config/planet`。后续候选必须在可信发布者一侧验证后再更新本实例的 `one/planet`。也可以单独部署兼容的 `mkworld` 工具进行本地复核，不必因此下载完整 Web 镜像。

## 4. 限制 API，启动并检查

模板配置使用以下边界：

- `9994/UDP` 是对外 Root 稳定端点。
- `9994/TCP` 是本实例的 HTTP 管理 API，不是给外部客户端使用的 HTTPS 中转端口。不要把它开放到公网或整个 `172.16.*` 网络。
- `allowManagementFrom` 只列出回环网段；ZeroTier 本身始终允许回环来源。普通管理操作仍需本实例的 `authtoken.secret`。不要复制客户端/Controller 的 token，也不要把 token 写到文档或终端日志。
- 即使 `ss` 显示 TCP socket 绑定 `0.0.0.0` 或 `::`，也不代表 API 被删掉或只有 loopback socket。API 来源限制是应用层检查；应同时用云安全组和宿主机防火墙阻止非回环来源访问 `9994/TCP`，包括 Docker/ZeroTier 接口上的请求。规则应由现有防火墙管理方式持久化，不要直接套用会改动 SSH 或现有服务的全局规则。
- `allowTcpFallbackRelay=false` 禁止本实例使用公共 TCP fallback；`portMappingEnabled=false` 禁止自动端口映射。黑名单避免把 ZeroTier、Docker 等虚拟接口当作 Root 的物理 underlay。
- `enableWebServer=false`、`enableMetrics=false` 关闭可选的原生页面和指标采集；它们不会关闭基础 HTTP 管理 API。

`allowSecondaryPort=false` 是 ZeroTier 1.16.1 中实际读取的配置，启动时会跳过随机 secondary 端口。但是该版本上游代码的离线/网络重启维护分支仍可能重新选择 secondary 端口，所以不能把此配置当作“永远只监听一个 UDP 端口”的安全保证。以 `ss` 和真实公网路径为准；公开稳定端点始终只配置 `9994`。`secondaryPort=0` 表示随机选择，不是禁用，因此模板不使用它。

完成防火墙核查后：

```bash
systemd-analyze verify /etc/systemd/system/zerotier-root-b.service
systemctl daemon-reload
systemctl enable --now zerotier-root-b.service
systemctl status zerotier-root-b.service --no-pager
journalctl -u zerotier-root-b.service -n 80 --no-pager
ss -lntup '( sport = :9994 )'
```

专用客户端命令必须显式选择新状态目录和端口，避免误操作已有 `9993` 客户端：

```bash
zerotier-cli -D/srv/zt-root-b/one -p9994 info
zerotier-cli -D/srv/zt-root-b/one -p9994 listnetworks
zerotier-cli -D/srv/zt-root-b/one -p9994 peers
systemctl is-active zerotier-one.service
zerotier-cli info
```

预期结果：Root B 的 node ID 与候选包一致，`listnetworks` 为空，Root peer 逐步可见；原客户端服务和原网络继续正常。不要仅因为进程是 active 就判定成功，Root 端点需要从另一台独立网络上的节点实际验证。

如需检查本实例是否意外产生 Controller 网络，可从本地读取 token 并请求 API，下面的写法不把 token 放在 curl 命令行参数中，也不会输出 token；不要开启 shell `set -x`：

```bash
(
  set -eu
  set +x
  zt_root_token=$(tr -d '\r\n' </srv/zt-root-b/one/authtoken.secret)
  printf 'header = "X-ZT1-Auth: %s"\n' "$zt_root_token" |
    curl --noproxy '*' --config - --fail --silent --show-error \
      http://127.0.0.1:9994/controller/network
)
```

结果应为 `[]`。状态目录权限应为 `0700`，`identity.secret`、`authtoken.secret` 为 `0600`。不要把 API 直接代理成免认证公共入口。

## 启停、更新与恢复

只操作新 unit，不操作 `zerotier-one.service`：

```bash
systemctl stop zerotier-root-b.service
systemctl start zerotier-root-b.service
systemctl restart zerotier-root-b.service
```

在更新前保留独立 SSH 通道，并确认另一个 Root 可用；如果 B 是唯一仍可用的 Root，停止它就是一次网络维护，不是无损操作。

推荐更新流程：

1. 记录 Root B 的 node ID、当前 Planet SHA-256、systemd unit 和 `local.conf`；在发布者侧保留当前世界及签名链。
2. 仅停止 `zerotier-root-b.service`，将 `/srv/zt-root-b/one` 完整复制到新的、权限 `0700` 的备份目录。这份备份含 identity 和 API token，不能提交到 GitHub，也不能同时在另一台主机启动。
3. 将实际运行的 `one/planet` 与发布者当前版本比较。如果守护进程在线学习到了更新的 World，应以其时间戳/签名链为依据重新核对，不能拿陈旧发布包覆盖它。
4. 在可信发布者侧验证新候选相对于当前 World 的签名链及更高时间戳，核对 B 的 identity 未被误删，然后将新 `planet` 安装到停止的实例中。需要时同步更新并复核 `local.conf`，保持身份不变。
5. 启动专用 unit，重复 `info`、空网络列表、Controller 网络列表、Root peer 和实际中转检查；再次确认原 `9993` 客户端未受影响。

进程或配置失败时，先查看 `journalctl`，修复 unit/`local.conf`；若触发启动频率限制，修复后执行 `systemctl reset-failed zerotier-root-b.service` 再启动。恢复 identity 时必须用这一个 Root B 自己的备份，不能用 A 或已有客户端的身份替代。

软件/配置回退和 World 拓扑回退不同。不要直接恢复旧 `planet` 来回退网络拓扑；已经接受新 World 的其他节点可能继续拒绝旧时间戳。应由发布者以更高时间戳签发恢复原 Root 列表的新 World，再统一发布。原生模板不会代替操作者做这个判断。

最后还要用隔离客户端做实际中转切换测试：直接 ping 通可能只是两客户端保持 DIRECT。两 Root 均已识别、稳定端点公网可达、切断一侧后能经过另一侧中转，才是多 Root 验证；它仍不等价于 Controller 或整机容灾。完整测试边界见[多 Root 验证标准](multi-root.md#验证标准)。

## 上游行为参考

本模板针对已核查的 ZeroTier 1.16.1。配置项和行为可对照该版本的 [`service/OneService.cpp`](https://github.com/zerotier/ZeroTierOne/blob/1.16.1/service/OneService.cpp)：`allowSecondaryPort` 的读取/初始绑定、离线后的 secondary 随机化、`allowManagementFrom` 的来源检查，以及管理 API 的 token 校验。更换系统版本后应复查监听、API 和实际 Root 路径，不要假定开关语义永远相同。
