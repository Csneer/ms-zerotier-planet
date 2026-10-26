# IPv6 与双栈 Root

Root 可以发布 IPv4、IPv6 或双栈 UDP 端点。这是 ZeroTier 的物理传输路径，与网络成员分配的虚拟 IPv4/IPv6 地址相互独立；在管理台启用成员 IPv6 分配不会让 Root 获得公网 IPv6。

本指南中的 IPv6-only 安装、显式移除旧地址族及分族观测已在 `v1.2.0` 发布。需要验证后续未发布修改时使用当前源码构建；部署时请使用已验证的版本镜像。`2001:db8::/32` 和文中的 IPv4 均为文档示例，部署时必须替换。

## 选择端点

| 部署 | 客户端条件与建议 |
| --- | --- |
| IPv4-only Root | 客户端需要一条能到该 IPv4 UDP 端点的物理路径。 |
| IPv6-only Root | 客户端及 Controller 都需要能到该 IPv6 UDP 端点的物理路径。没有 IPv6 接入的客户端不能直接通过它引导连接。 |
| 双栈 Root | 同一身份发布两族端点，客户端按实际可达性和路径质量选择；无需复制 Root 身份。 |
| IPv4 Root + IPv6 Root | 可以放入同一签名 Planet；逐一检查各类客户端和 Controller 至少能到一个 Root。Root 间有连通路径也不能代替客户端自身的引导条件。 |

面向混合客户端时，优先使用双栈 Root，或至少保留一个可达的 IPv4 Root。内置 TCP fallback 不能当作 IPv4 到 IPv6 的转换桥接。Root 列表顺序不控制主备或流量优先级；如需把旧机器退出中转，应发布移除它的新 Planet，并分发给客户端。

使用稳定的全球单播 IPv6，避免会轮换的隐私地址。ULA 只适合所有参与方已有相应路由的专用内网；链路本地、回环、未指定、组播及 IPv4-mapped IPv6 地址不能作为可用的 IPv6 Root 端点；IPv4 请填普通 IPv4 字段。ZeroTier 1.16.2 还在物理路径选择中拒绝 `2001:470::/32` 的 HE 隧道地址；部署前应确认所用版本的[路径规则](https://github.com/zerotier/ZeroTierOne/blob/fc5c3ec22090b5b2a0f274e863651fe9ca489bf4/node/Path.hpp#L250-L279)。

## 主机与防火墙

本项目使用 Linux `network_mode: host`，容器共享宿主机网络栈。无需为了 Root 开启 Docker bridge IPv6 或设置 `fixed-cidr-v6`。

```bash
ip -6 addr show scope global
ip -6 route show
ss -6 -lunp
```

确认主机拥有稳定 IPv6 和到客户端网络的路由；云安全组与主机防火墙允许配置的 UDP 端口（默认 `9994`）双向通信。双栈需要分别检查 IPv4 和 IPv6 规则。保留必要的 ICMPv6，特别是 Packet Too Big（路径 MTU 发现）和链路上的邻居/路由发现，避免“小包通、大包卡住”。不要把所有 ICMPv6 一概丢弃。

`ss` 中的监听、本机 `ONLINE` 或容器 `healthy` 都不能单独证明公网 IPv6 可达。ZeroTier 本地 TCP 管理 API 与 UDP Root 端口用途不同，不要为排障把管理 API 暴露到公网。

## 安装与迁移

在没有 `.env` 的新 checkout 中，IPv6-only 安装使用：

```bash
./install.sh --ipv6 2001:db8::10 --data-dir /srv/zerotier-planet
```

双栈安装同时提供两族：

```bash
./install.sh --ip 198.51.100.10 --ipv6 2001:db8::10 \
  --data-dir /srv/zerotier-planet
```

现有单 Root `generated` 部署切成 IPv6-only 时，先备份、确认独立管理通道和客户端 IPv6 条件，再在现有 `.env` 中明确设置：

```dotenv
IP_ADDR4=
IP_ADDR6=2001:db8::10
```

然后执行 `./manage.sh doctor`、`./manage.sh upgrade`，核对新 World 及客户端路径。Compose 的两项地址是完整声明：空值或省略字段都会禁用对应族，不再自动恢复旧地址；升级前检查手工维护的 `.env` 是否保留了所有仍需发布的地址。普通 `docker run` 也继承镜像中的空值默认值，不会因为省略 `-e` 而恢复旧地址。

`external` 部署以已签名 Planet 为准，改变 `IP_ADDR4` / `IP_ADDR6` 不会改变 World。发布者需在原签名链上生成更高时间戳的候选，验证差异及 `mkworld --verify-update` 后，按[多 Root 发布流程](multi-root.md#发布流程)滚动安装同一份候选。JSON 端点格式是 `2001:db8::10/9994`，不加方括号；HTTP URL 中的 IPv6 才使用 `[地址]:端口`。

## 从管理台到真实链路验收

首页和监控页会分别展示签名端点、服务实例和可选探针的 IPv4/IPv6 观测。没有发布且没有观测到的地址族显示“未配置”；本机 Root 显示“本机端点 / 外部未验证”。只有活跃路径在 90 秒内收到回应才视为近期可达；无样本或过期不直接等于故障。一族有回应即可形成当前实例的 Root 路径，不能推断另一族或所有客户端也可达。

1. 在独立的 IPv6 客户端安装新 Planet，重启并核对 `zerotier-cli -j peers` 中目标 Root 的 IPv6 物理路径与近期收包；不要用管理台探针代替该客户端的证据。
2. 加入测试网络、授权成员，验证实际业务端口和持续传输。观察 Root 的流量与资源使用；虚拟 IP 能通还不能证明正在经 IPv6 Root 中转，客户端可能已直连。
3. 如需验证 relay，在独立测试网络中有控制地阻断测试客户端间直连，同时保留 Root 和管理通道，确认中转路径后测吞吐、丢包和较大数据包。恢复测试规则后再验证直连。

当前自动测试覆盖安装配置、签名格式、地址族迁移、隔离容器启动及浏览器展示。2026-10-25 还在独立 Docker 内部 IPv6 网络上完成了实包检查：独立客户端使用同一签名 Planet，观测到 IPv6 PLANET 活跃路径，延迟 16 ms，最近收包距采样 6 ms；该检查验证本地 IPv6 UDP 通信，未使用真实公网 IPv6 主机，也未验证多客户端中转吞吐。公网 relay 的吞吐和运营商路径仍需以上现场验收。

参考：[ZeroTier 路由配置建议](https://docs.zerotier.com/routertips/)、[Docker host 网络](https://docs.docker.com/engine/network/drivers/host/)、[RFC 4890 ICMPv6 过滤建议](https://www.rfc-editor.org/rfc/rfc4890#section-4.3)。
