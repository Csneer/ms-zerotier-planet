# 版本与发布约定

项目使用 SemVer `vX.Y.Z`：不兼容的使用或配置变化递增主版本，兼容功能递增次版本，兼容修复递增补丁版本。首个正式版本为 `v1.0.0`（2026-10-16）；历史未发布变更统一归入该版本，不补造历史版本。

项目版本与 ZeroTier 版本独立：`ghcr.io/csneer/ms-zerotier-planet:v1.0.0` 是项目镜像，而 `:1.16.2` 是跟随 ZeroTier 版本更新的滚动标签。

仓库已更名为 `Csneer/zerotier-planet-ms`；GHCR 包名 `ghcr.io/csneer/ms-zerotier-planet` 为现有部署保留的兼容地址，发布和安装文档继续使用它，不要因仓库改名而替换已部署的镜像引用。

## 构建与镜像标签

| 触发方式 | ZeroTier 版本来源 | 发布的镜像标签 |
|---|---|---|
| 正式 `vX.Y.Z` tag | 该 tag 的 `.env.example` 中的 `ZT_VERSION` | 仅对应 `vX.Y.Z` |
| `main`/`master` 推送、每周计划任务 | 上游最新稳定 release | `latest`、ZeroTier 版本、`sha-…` |
| 普通手动构建 | 指定版本，留空时用上游最新稳定 release | `latest`、ZeroTier 版本、`sha-…` |

`v1.0.0` 使用 ZeroTier `1.16.2`。正式 tag 构建不覆盖滚动标签。不要移动或重新使用已发布的项目 tag；修复应发布新版本。固定 ZeroTier 版本并不代表基础镜像、系统包和 npm 依赖全部锁定；需要固定部署内容时，在发布记录中保存构建产出的 digest，并使用 `ghcr.io/csneer/ms-zerotier-planet@sha256:…`。

## 仓库专用身份

在当前仓库目录执行，禁止修改机器全局 Git 身份。首次配置及每次发布前核对：

```bash
git config --local user.name Csneer
git config --local user.email 113568521+Csneer@users.noreply.github.com
git config --show-origin --get user.name
git config --show-origin --get user.email
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
gh api user --jq .login
git remote -v
```

确认有效作者、提交者均为上述仓库身份，GitHub 登录账号为 `Csneer`，远端为 `Csneer/zerotier-planet-ms`。Git 作者配置不等于推送认证；有其他账号、环境变量覆盖或错误远端时，先修正该仓库使用的身份及认证再提交。

## 发布步骤

1. 日常修改累积到 [CHANGELOG.md](../CHANGELOG.md) 的 `Unreleased`。准备发布时，把这部分归档为 `## [X.Y.Z] - YYYY-MM-DD`，保留空 `Unreleased`，增加版本链接，并核对 `.env.example` 中的 `ZT_VERSION`。
2. 通过 PR 合入 `main`。确认待发布的 **main 提交** 的 `Validate and publish image` 工作流全部成功；PR 的成功结果不能替代合并后提交的验证。
3. 工作区干净且身份已核验后，为已验证的提交创建 annotated tag。以下以首个版本为例，仅首次发布时执行：

```bash
git switch main
git pull --ff-only
git status --short
git rev-parse HEAD
gh run list --workflow image-build.yml --branch main --limit 5
# 核对成功运行的 headSha 与上面的 HEAD 一致后：
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin refs/tags/v1.0.0
```

4. tag 推送触发镜像工作流。核对运行的 tag、提交及成功结论，并确认多架构镜像和 digest：

```bash
gh run list --workflow image-build.yml --branch v1.0.0 --limit 5
# 选取对应 tag 推送产生的运行 ID：
gh run watch RUN_ID --exit-status
docker buildx imagetools inspect ghcr.io/csneer/ms-zerotier-planet:v1.0.0
```

5. 镜像发布成功后，从 CHANGELOG 对应版本段提取发布说明，创建 GitHub Release；不要先发布一个尚未构建成功的版本。以下命令在仓库根目录执行：

```bash
release_tag=v1.0.0
release_notes=$(mktemp)
python3 - "$release_tag" > "$release_notes" <<'PYTHON'
from pathlib import Path
import re
import sys

version = sys.argv[1].removeprefix("v")
text = Path("CHANGELOG.md").read_text()
match = re.search(
    rf"^## \[{re.escape(version)}\] - [^\n]+\n(.*?)(?=^## |^\[[^\]]+\]:|\Z)",
    text,
    re.M | re.S,
)
if not match:
    raise SystemExit(f"Missing changelog entry: {version}")
print(match.group(1).strip())
PYTHON
# 上一步提取成功且内容核对无误后：
gh release create "$release_tag" --verify-tag --title "$release_tag" --notes-file "$release_notes"
rm "$release_notes"
```

若 tag 构建失败，先排查失败原因，保持 GitHub Release 未发布；不要强推移动已发布的 tag。发布完成后核对 Release 页面、tag 指向的提交和镜像 digest，并在运维记录中保存实际部署引用。
