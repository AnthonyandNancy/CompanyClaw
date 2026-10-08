# 09 — 打包与发布

## 产品标识（已改）

| 项 | 值 |
|---|---|
| appId | `com.companyclaw.desktop` |
| productName | `CompanyClaw` |
| MSIX artifactName | `CompanyClaw-<version>-<arch>.msix` |
| MSIX identityName | `CompanyClaw.Desktop` |
| 快捷方式名 | `CompanyClaw` |

由 `desktop/src/companyclaw/product-identity.test.ts` 与 `installer-scope.test.ts` 锁定，防止回归。

## 安装范围（已改）

| 配置 | 值 | 原因 |
|---|---|---|
| `nsis.perMachine` | `false` | 普通用户日常使用不得依赖管理员权限 |
| `nsis.allowElevation` | `false` | 禁止静默提权 |
| `nsis.oneClick` | `false` | 保留可见安装向导 |
| `nsis.allowToChangeInstallationDirectory` | `true` | 允许选择用户可写目录 |

## Node 运行时（已改）

- 默认目录从 `C:\Program Files\nodejs` 改为 `%LocalAppData%\Programs\nodejs`（用户可写）
- 机器级运行时仍受支持，但改为**显式选择**：设 `OPENCLAW_NODE_DIR`
- **事实**：Node.js Windows MSI 是 per-machine 安装器，不支持 per-user（上游记录 `MSIINSTALLPERUSER=1` 以 1603 失败）。因此策略是"优先复用用户目录下已有运行时；确需机器级安装时向操作者明示"，并已修正 `install_node_windows` 中**声称 per-user 的不实文档**

## Defender 排除项（已改）

- `ensure_defender_exclusions` 由**无条件执行**改为**显式 opt-in**：需 `COMPANYCLAW_DEFENDER_EXCLUSIONS=1`（或旧名 `OPENCLAW_DEFENDER_EXCLUSIONS=1`）
- 默认路径记录一条明确的跳过日志
- 未识别或空值一律视为"不改动主机 AV 配置"

## 卸载（已改）

`scripts/windows/uninstall-dependencies.ps1`：

| 行为 | 默认 | 显式开关 |
|---|---|---|
| 保留 `~/.openclaw`（模型密钥、微信绑定、浏览器 Profile、任务历史） | **保留** | `-PurgeUserData` |
| 保留主机 Defender 配置 | **不动** | `-RemoveDefenderExclusions` |

## 构建

```powershell
.\build.ps1                                        # 便携 zip + PyInstaller 安装器
cd desktop; npm run dist                           # electron-builder NSIS
```

工具链要求：Node `>=24.16.0 <25 || >=26.1.0`、Python 3.10+（打包）、.NET 9/10 SDK（AppContainer 与 Windows Node Host）。

## 未完成

| 项 | 说明 |
|---|---|
| **安装包产物** | 本机**未产出**：无 `dist/`、无 `desktop/release/`。构建需要完整工具链与时间 |
| **代码签名** | 无证书（`BLOCKERS.md` B6）；签名状态无法核验 |
| SHA-256 与 SBOM | 未生成 |
| 自动升级 | 上游 `update-checker.ts` 为骨架，本项目未改；升级回滚未验证 |
| 卸载数据保留的真机验证 | 脚本已改并有测试，但未在真机执行卸载 |
| MSIX 通道 | 保留但不作为主通道（裁决：不并行维护两套升级链路） |
| Per-User 安装实测 | 未验证（需目标机，`BLOCKERS.md` B7） |
