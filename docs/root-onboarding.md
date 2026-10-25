# 本地 Root 接入工具

`root-manage.sh` 把独立 Root 准备和签名候选生成分为两个命令：`prepare` 与 `add`。它只操作明确指定的本地专用目录，不 SSH、不启动或重启服务、不修改防火墙、不替换生产 Planet，也不创建/复制 Controller。

本机需已有可信 Docker 镜像、Docker daemon、Bash、jq、Python 3、GNU coreutils、find 和 flock。镜像必须包含本项目的 `mkworld`、`zerotier-idtool`、bash 和 jq。命令先解析已经存在的镜像为不可变 image ID，此后只用该 ID，容器使用 `--pull never`、`--network none`；不会自动拉取或构建镜像。签名镜像可以读取签名材料，**固定 ID 不等于审计过镜像**，应使用自己构建并验证的版本。

## 1. 在新 Root 主机准备申请

例如，备用机实际公网端点为 `198.51.100.20/9994`，本机已有可信 `zerotier-planet:multi-root` 镜像：

```bash
./root-manage.sh prepare \
  --image zerotier-planet:multi-root \
  --data-dir /srv/zt-root-b \
  --endpoint 198.51.100.20/9994
```

IP 是文档示例，需要换成真实地址。支持重复 `--endpoint` 添加 IPv4/IPv6，最多 32 个；仅接受字面 `IP/端口`，不接受域名、HTTPS URL、网段或 IPv6 zone。端口必须在 1–65535；拒绝 wildcard、loopback、multicast、IPv6 link-local、IPv4-mapped IPv6、IPv4 全网广播和重复端点。私网/ULA 地址可用于专门设计的内网 Root，但工具不会声称这些地址公网可达，仍需操作者验证所有客户端的物理路径。

只生成：

```text
/srv/zt-root-b/
├── one/
│   ├── identity.secret    # 留在本机，0600
│   └── identity.public    # 公开身份
└── root-request.json      # 只含公开身份和端点
```

目录必须是绝对路径、位于仓库外、没有符号链接。不能使用 `/var/lib/zerotier-one` 或其他已有客户端/Controller 状态。仅接受全新空目录，或只有上述 identity/request 的专用目录；发现 `planet`、token、`networks.d`、`controller.d`、签名密钥及其他文件均拒绝继续。已有公私钥必须匹配且通过 identity 校验；缺少其中一个时不会重建。相同 identity/端点的重复执行幂等，改变已有申请则拒绝覆盖，需单独审查公开申请。

申请格式：

```json
{
  "schemaVersion": 1,
  "identity": "节点完整的identity.public",
  "stableEndpoints": ["198.51.100.20/9994"]
}
```

`prepare` 验证的是本地文件，**公开申请文件本身不是私钥持有证明，也不是 Root 所有权或公网 UDP 可达性证明**。发布者应通过核验过 host key 的可信 SSH/受控传输取得它，核对目标主机、完整公钥、地址和授权。不要复制 `identity.secret`、`authtoken.secret`、Controller 数据或 World 签名密钥，不要关闭 SSH 主机密钥校验。接入其他人运维的 Root，必须由对方配合运行同一份签名 Planet 和对应 identity；不能简单把另一套 Planet 或任意 IP 当作自己的 Root。

## 2. 在可信发布者生成追加候选

`SIGNER` 必须是原 World 的受保护目录，至少包含当前实际已签名的 `planet` 和匹配的 `previous.c25519`、`current.c25519`。它不能是临时拼出的新 World，也不能拿陈旧导出替代当前发布基线。

先记录并检查基线：

```bash
sha256sum /srv/planet-signer/planet
```

将得到的 64 位哈希填入下方 `BASE_SHA256`。先预览：

```bash
./root-manage.sh add \
  --image zerotier-planet:multi-root \
  --signer /srv/planet-signer \
  --request /srv/zt-root-requests/root-b.json \
  --output /srv/planet-releases/release-002 \
  --base-sha256 BASE_SHA256 \
  --dry-run
```

输出父目录必须已经存在，目标目录必须是全新路径，不能与 signer 重叠。`--base-sha256` 可省略，但生产准备强烈建议提供，以拒绝操作员审查后已经变化的基线。`--dry-run` 读取并验证当前 Planet、公钥和端点，展示原有 Root 加新 Root 的差异，不签名、不创建正式 output、不激活。

确认差异后，使用相同参数删除 `--dry-run` 生成候选。工具从 `signer/planet` 解出原 Root 列表并追加，不能通过申请修改/删除现有 Root；不接受私钥 identity 或额外申请字段。重复 ID 无论端点相同与否都明确报错，不生成另一个版本。默认兼容格式最多 4 个 Root，达到上限即拒绝。旧 World 内已有不合规端点也会要求先审查，不会自动修正。

生成时：

1. 对 signer 目录 inode 取得 `flock` 排他锁，限制同一目录的本工具并发运行；不向 signer 写锁文件。
2. 检查基线 SHA-256，取得公开 World 快照，验证新公钥，并保留完整原 Root 列表。
3. 调用现有 `planet-bundle.sh`，签名材料只读挂载、在容器 tmpfs 工作；输出只允许 `planet`、`roots.json`、`SHA256SUMS`。
4. 再验证候选相对于原快照的签名链、更高时间戳、最终 Root 集合、元数据和校验和。
5. 签名前后检查 signer 的 World 和签名材料未变，最后以 no-clobber 方式把候选移至 output；绝不覆盖已有 output。

输出仍只有公开的三个文件，原 identity、签名材料和 signer/planet 不变。任何失败不会激活候选，临时公开数据会清理。不要把 signer 放进 GitHub、Web UI 或每个 Root；该工具不是让每台 Root 都具备签名能力。

## 3. 候选不等于发布

同 signer 的 `flock` 和前后指纹检查仅防止合作运行的本地接入流程互相穿插，**不是完整 release 发布 CAS**。工具不会更新 signer head；两次串行执行仍可以从同一个旧 head 生成不同候选。外部脚本、另一份 signer 副本、在线 World 学习和人工变更也不受该锁统一控制。正式发布前仍须再次比较当前运行/发布 World、候选基线哈希和最新签名链，串行批准一个 release。其他候选需重新基于已发布 head 生成，不能直接抢占。

现有 `planet-bundle.sh` 将 signer 目录只读挂入可信签名镜像。无网络和 tmpfs 保护正常流程下的签名材料，但不能防御恶意镜像将机密写入 output；因此镜像、Docker daemon、发布主机和本地脚本都是信任边界。不要把这个本地命令直接封装成接受任意 image/path 的公开 HTTP API。

首次在新 Root 导入仍需通过可信渠道核对 Planet SHA-256；同目录 `SHA256SUMS` 只检查完整性，不能认证来源。已运行 Root 的更新应验证当前 World→候选的签名链和本机 identity，先启用/验证新 Root，再滚动更新现有 Root 和客户端，核对实际公网 UDP 与隔离中转。Root 元数据面板只能观察，不能把编辑 `planet-roots.json` 当作发布。

上线方式、Controller 单活约束、客户端兼容性和拓扑恢复分别见：

- [多 Root 发布与切换](multi-root.md)
- [系统 ZeroTier Root-only](native-root.md)
- [原地升级](in-place-upgrade.md)

移除 Root 或改端点不是 `add` 的职责，必须另外审查并签发更高时间戳的 World。缺少原签名密钥、签名轮换状态不明或身份不能确认时应暂停；不能创建新密钥绕过验证。Controller HA 也不属于 Root 接入工具，不能把相同 Controller identity/数据复制后同时启动。

## 测试

测试只使用临时目录和隔离 `--network none` 工具容器，不启动 ZeroTier 服务、不挂载生产状态：

```bash
bash -n root-manage.sh
sudo node tests/root-manage.cjs zerotier-planet:multi-root
```

覆盖独立准备、重复幂等、不覆盖已有身份、拒绝客户端/Controller/签名状态和非法端点、保留全部原 Roots、公开候选输出、重复 ID/私钥申请拒绝、基线冲突及 dry-run。
