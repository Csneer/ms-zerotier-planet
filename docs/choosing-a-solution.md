# 选择适合自己的私有网络方案

先决定你要连接的是设备、网段，还是几个服务，再选择工具。
本文根据各项目官方文档整理，核对日期为 **2026-10-31**；比较的是工作方式与维护取舍，不是安全评分、速度排名或同条件性能测试。

## 从需求开始

| 你的主要目标 | 优先了解 |
| --- | --- |
| 让异地电脑、NAS 和服务器通过虚拟 IP 互访，并自己维护 ZeroTier 的 Root 与网络授权 | **zerotier-planet-ms** |
| 尽快连通设备，希望使用成熟客户端和托管管理服务 | **Tailscale**、**NetBird Cloud**、**ZeroTier Central** |
| 保留 Tailscale 客户端生态，同时把协调服务部署到自己服务器 | **Headscale** |
| 自托管组网，还需要集中管理用户、身份和访问策略 | **NetBird** |
| 倾向去中心化节点连接，想使用 CLI、GUI 或 Web 配置组网 | **EasyTier** |
| 主要发布家中一个 Web 服务、SSH 端口或若干 TCP/UDP 服务 | **frp** |

这些路径并不互斥。例如，个人设备可以通过私有网络访问 NAS，而一个需要面向访客开放的网站仍使用反向代理。

## 工作方式与维护取舍

| 方案 | 主要网络模型 | 自托管与管理界面 | 接入和维护时要考虑 |
| --- | --- | --- | --- |
| **[zerotier-planet-ms](../README.md)** | ZeroTier 的虚拟以太网（L2），承载 IP 流量；整合自建 Planet/Root 与 Controller | 本仓库提供 Web 管理、Root 观测、配置分发及备份恢复；可从单机扩展到独立 Root | 需要分发并验证客户端 Planet，维护 World 签名链与节点身份；多 Root 不等于 Controller 高可用 |
| **[Tailscale](https://tailscale.com/kb/1151/what-is-tailscale)** | 基于 WireGuard 的设备/IP 组网（L3），支持子网路由 | 官方服务提供托管控制面和管理台；可以配置自建 DERP 中转 | 托管服务减少控制面的日常运维；身份、访问策略及可用功能需按实际方案核对 |
| **[Headscale](https://headscale.net/stable/)** | 使用 Tailscale 客户端进行 L3 组网，自托管协调服务 | 可使用内置或自建 DERP；核心不内置 Web 管理台，有多个社区 UI 可选 | 维护控制服务、TLS、客户端兼容性及可选 UI；功能范围不等同于完整 Tailscale 商业服务 |
| **[NetBird](https://docs.netbird.io/about-netbird/how-netbird-works)** | WireGuard 加密 IP 组网（L3），结合集中访问控制 | 提供托管与自托管方式，管理 UI、管理服务、信令和中转可自行部署 | 适合需要用户、身份与策略管理的团队；自托管时仍需维护相关服务和认证配置 |
| **[EasyTier](https://github.com/EasyTier/EasyTier)** | 以 IP 组网、子网代理和对等节点互联为主；支持多种传输与组网模式 | 可使用自建或共享节点，提供 CLI、GUI 与 Web 配置方式 | 根据客户端平台选择原生客户端或 WireGuard 接入；节点信任、网络密钥和中转资源由部署者规划 |
| **[frp](https://github.com/fatedier/frp)** | 成熟用途是按 TCP/UDP 端口或 HTTP(S) 域名发布服务；也有 XTCP P2P 与实验性 VirtualNet | 自建 frps/frpc，提供服务端 Dashboard 和客户端管理功能 | 适合针对服务配置访问；XTCP 受 NAT 环境影响，VirtualNet 仍为 ALPHA，不能当作所有版本的稳定默认能力 |

### L2、L3 和服务代理意味着什么

- **L2 虚拟以太网**：保留虚拟网卡、以太网帧及相应广播/组播语义。适合已有 ZeroTier 网络，或需要这类网络行为的场景；不能因此假定所有局域网发现协议、移动端或桥接场景都自动可用。
- **L3 IP 组网**：通过 IP、路由和访问策略连接设备与子网。SSH、RDP、HTTP、数据库等常见远程访问通常不需要 L2。
- **服务代理**：围绕端口、域名和具体服务组织访问，不必让每位访客加入一张完整虚拟网络。frp 也在扩展组网能力，所以这里比较其成熟的主要用途，而非给项目划定永久边界。

不要仅凭“支持 L2”判断某方案更高级。对普通远程访问而言，客户端可用性、访问策略、可达性与维护负担通常更影响体验。

## ZeroTier 官方服务、自托管和本仓库

这些组成部分负责不同的事情：

| 组成 | 负责什么 | 与本仓库的关系 |
| --- | --- | --- |
| **ZeroTier One** | 客户端、加密传输、虚拟网卡和对等连接等底层能力 | 本仓库使用上游引擎，没有重新实现一套加密协议 |
| **ZeroTier Central** | 官方托管的网络配置和成员管理服务 | 使用官方管理服务是一条省运维的路径；本项目选择自托管 Controller 与 Web 管理 |
| **Planet / Root** | 描述根节点集合，协助节点发现、连接与必要的中转 | 本项目支持自建根节点及统一签名的 Planet 分发 |
| **zerotier-planet-ms** | 把引擎、Root/Controller 部署、Web 和运维脚本整合起来 | 主要价值是部署和日常维护体验，以及对私有网络基础设施的控制 |

**只自托管 Controller，不等于已经替换公共 Root。**
Controller 管理网络配置与授权；Root 协助底层连接。它们可以运行在同一机器上，也可以分离。
选择本项目的自建 Planet 路径，还需要让客户端实际加载并验证对应的 Planet 文件。

单 Root 是明确的资源与可用性选择。增加 Root 可以提供更多连接路径，但不能自动复制 Controller 数据、选举主 Controller，或按 Root 列表顺序实现主备。
部署细节见[多 Root 指南](multi-root.md)与[Controller 备用指南](controller-standby.md)。

## 加密与自托管的含义

**加密保护数据传输，自托管决定由谁维护控制服务与网络入口。** 两者相关，但不能互相替代。

根据 [ZeroTier 协议文档](https://docs.zerotier.com/protocol)，正常加密路径上的 ZeroTier 虚拟网络数据在客户端之间端到端加密；即使经 Root 中转，Root 也不能读取其中的业务载荷。
本项目沿用这套上游能力。自建 Root 的价值在于控制部署位置、端点和维护方式，不是让原本明文的 ZeroTier 流量突然获得加密。

使用时应区分以下边界：

- **业务载荷和连接元数据不同。** 中转服务仍可能观察外层地址、流量规模和时间等信息，端到端加密不等于匿名网络。
- **虚拟网络和物理局域网不同。** 如果通过一个网关访问未安装客户端的设备，加密隧道终止于网关；后面的 LAN 链路是否加密取决于应用或其他保护措施。
- **网络身份和应用身份不同。** 授权某个 ZeroTier 成员不会代替 SSH 密钥、Web 登录、数据库权限或应用 TLS。
- **加密也有配置范围。** 上游提供 `trustedPaths` 供明确受信的物理路径跳过加密与认证；它是主动放弃这层保护的选项，不属于本文所说的正常加密连接。

Tailscale、Headscale 对应的客户端网络和 NetBird 同样利用 WireGuard 提供加密连接；NetBird 官方文档明确说明其 Relay 不能解密 WireGuard 载荷。
frp 也支持 TLS 和其他加密设置，并非“明文方案”：其加密覆盖范围应结合 frpc/frps、访客连接和具体代理模式判断。

因此，选择本项目的理由应是 **ZeroTier 生态、私有 Root 与集成运维**，而不是假定其他成熟方案没有加密或不能自托管。

## 客户端与移动端

“能安装客户端”与“能加入你的私有 Planet”是两次不同的验证。
先确认所用客户端支持目标引导方式，再核对实际连接到的 Root、网络成员授权及业务访问。

| 客户端路径 | 可以依据什么准备 | 仍需验证什么 |
| --- | --- | --- |
| Linux / Windows / macOS 的 ZeroTier One | 支持服务管理与状态目录访问时，可按项目[客户端接入步骤](operations.md#客户端配置)替换 Planet | 文件权限、服务重启、Root 观测、网络 ID、IP 和目标服务 |
| 官方 ZeroTier 移动客户端 | 当前[官方 Root 文档](https://docs.zerotier.com/roots)描述从 **1.16.0** 起可用自定义 URL 或 Settings → Add Planet File 导入 Planet | 实际平台、应用版本、导入内容与私有 World 行为；文档能力不等于本项目已完成所有移动设备测试 |
| Android ZerotierFix | [上游 README](https://github.com/kaaass/ZerotierFix)列出文件与 URL 导入自定义 Planet 的能力 | APK 来源与签名、内置引擎版本、导入与重连；升级时保留原身份或安排重新授权 |
| Tailscale / Headscale / NetBird / EasyTier | 查看各项目对应平台的客户端文档；Headscale 使用 Tailscale 客户端，自定义服务器设置因平台而异 | 客户端与自托管服务版本匹配、后台/VPN 权限、子网路由和实际业务链路 |

官方 Root 文档同时包含 **Moon 补充根节点**和 **Planet 文件导入**内容。加入 Moon 通常仍保留公共 Planet Root；替换为独立的私有 World 是另一种部署目标，不能把“成功导入”直接当作“已经只使用自建 Root”。
当前官方文档已将私有 Moon 标为不推荐新部署，本文也不把 Moon 作为新建私有网络的默认推荐路线。

对具体手机，建议完成一次短验收：

1. 记录当前客户端与内置引擎版本，以及当前节点 ID。
2. 导入预期 Planet 并重新连接，核对 Root 与网络 ID。
3. 在管理台找到同一节点 ID，确认授权和分配地址。
4. 通过实际 SSH、Web 或其他目标服务验证访问，而非只看“已连接”。

已有 Android 客户端版本提示时，先看[升级与排障指引](client-troubleshooting.md)。不要仅为消除版本数字提示而卸载应用，导致节点身份与授权变化。

## 选型时值得实际测的事情

在你的家庭宽带、手机移动网络和云服务器之间运行一轮业务测试，比照抄其他项目的吞吐数字更有价值：

- **连得上吗**：分别用家庭 Wi-Fi、移动网络以及可用的 IPv4/IPv6 环境验证。
- **走哪条路**：区分端点直连和中转，确认谁承担云主机流量费用。
- **体验如何**：测试真实文件传输、远程桌面或开发服务，记录延迟、吞吐与稳定性。
- **能维护吗**：升级后身份和授权是否保持，备份是否可恢复，移动客户端是否方便更新。

本项目的 [2 vCPU / 2 GiB 基准](capacity-benchmark.md)记录的是受限环境下的运行与功能回归开销，不能用于宣称比上述方案更快，或推导固定中转带宽和成员上限。

## 资料与核对范围

以下为官方资料，不使用营销对比文章作为唯一依据。在线文档可能更新；部署时请匹配实际版本。

- ZeroTier：[协议与角色](https://docs.zerotier.com/protocol)、[Root 与移动端导入](https://docs.zerotier.com/roots)。
- Tailscale：[产品工作方式](https://tailscale.com/kb/1151/what-is-tailscale)。
- Headscale：[功能范围](https://headscale.net/stable/about/features/)、[客户端](https://headscale.net/stable/about/clients/)、[DERP](https://headscale.net/stable/ref/derp/)、[社区 Web UI](https://headscale.net/stable/ref/integration/web-ui/)。
- NetBird：[工作方式与自托管组件](https://docs.netbird.io/about-netbird/how-netbird-works)。
- EasyTier：[本次核对的 README 快照](https://github.com/EasyTier/EasyTier/blob/24e0303fc55e4e645a11818954dd5b712fb94510/README.md)。
- frp：[本次核对的 README 快照](https://github.com/fatedier/frp/blob/93b52799bb7e6dad7ae1152c8b593eefcc17d595/README.md)、[VirtualNet 说明](https://github.com/fatedier/frp/blob/93b52799bb7e6dad7ae1152c8b593eefcc17d595/doc/virtual_net.md)、[XTCP](https://gofrp.org/en/docs/features/xtcp/)、[TLS](https://gofrp.org/en/docs/features/common/network/network-tls/)。
- ZerotierFix：[本次核对的 README 快照](https://github.com/kaaass/ZerotierFix/blob/0373a58c03ffe053e92212a6fa2d98245db8aa9c/README.md)。

本项目并非 ZeroTier、Tailscale、Headscale、NetBird、EasyTier 或 frp 的官方关联产品；相关名称和商标归各自所有者。
