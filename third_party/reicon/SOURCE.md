# Reicon outline subset

- Official repository: https://github.com/dqev/reicon
- Website: https://reicon.dev/
- Fixed source commit: `fe6975391b80c808c25d98b2a21081cf180482f9`
- Source: [`data/icon-data.json`](https://github.com/dqev/reicon/blob/fe6975391b80c808c25d98b2a21081cf180482f9/data/icon-data.json), `weights.Outline.code`.
- License: MIT, Copyright (c) 2025 REICON. The original license is preserved in [LICENSE](LICENSE).

`patch/icons.pug` embeds the original outline SVG paths unchanged. The local SVG wrapper adds `app-icon`, fixed 24 × 24 viewBox, and decorative accessibility attributes. No remote assets, runtime dependencies, or scripts are required. Icons supplement visible text labels.

| Local name | Upstream category / icon |
| --- | --- |
| `home` | `ui/home` |
| `globe` | `map/globe` |
| `plus` | `ui/plus` |
| `download` | `arrows-action/download` |
| `user` | `users/user` |
| `activity` | `newicons/activity` |
| `arrow-right` | `arrows/arrow-right` |
| `sign-in` | `arrows-action/login` |
| `sign-out` | `arrows-action/logout` |
| `refresh` | `arrows/refresh` |
| `lock` | `security/lock` |
| `search` | `search/search` |
| `chevron-right` | `arrows/chevron-right` |

Aliases: `dashboard` → `home`, `signal` → `activity`, `download-alt` → `download`, `log-in` → `sign-in`, `log-out` → `sign-out`. Unknown names retain the existing local Bootstrap Glyphicons fallback; invalid names use `question-sign`.
