# 00 — 上游基线与依赖矩阵

- 上游仓库：`https://github.com/microsofthackathons/MicroClaw`
- 本地克隆：`code/CompanyClaw`（`origin` 仍指向上游；公司 Fork 见 `BLOCKERS.md` B3）
- 上游 commit SHA：`6f080a07f43bd65b8b27ec6f859438fc038bb912`
- 提交信息：`Fix OpenClaw 9.3 SQLite worker startup in AppContainer mode (#226)`
- 提交时间：2026-09-11T14:33:45+08:00
- 分支：上游 `main` → 本地开发分支 `feat/companyclaw-foundation`
- 许可证：MIT（`LICENSE`），第三方声明见 `NOTICE`

## 依赖矩阵

| 组件 | 版本 / 范围 | 来源 | 备注 |
|---|---|---|---|
| OpenClaw | `2026.9.3` | `deployer/openclaw_version.py` `OPENCLAW_TARGET_VERSION` | 锁定，不替换 Agent 内核 |
| Node.js 引擎范围 | `>=24.16.0 <25 \|\| >=26.1.0` | `deployer/openclaw_version.py` `NODE_ENGINE_RANGE` | Node 22/25 不支持 |
| Node.js 下载回退版本 | `26.1.0` | `NODE_FALLBACK_VERSION` | — |
| Node.js（本机实测） | `v26.7.0` | `node --version` | 满足范围 |
| Python（本机实测） | `3.11.9` | Python 3.11 | 安装器可运行；`openclaw_upgrade` 的 `rmtree(onexc=...)` 需 3.12（见 `BLOCKERS.md`） |
| Python（CI/release） | `3.12` | `.github/workflows/release.yml` | 与本地差异见阻塞 B4 相关说明 |
| Electron | `^33.4.11` | `desktop/package.json` | — |
| electron-builder | `^26.8.1` | `desktop/package.json` | NSIS + MSIX |
| Vue | `^3.5.0` | `desktop/renderer/package.json` | — |
| Element Plus | `^2.9.0` | `desktop/renderer/package.json` | — |
| Pinia | `^2.3.0` | `desktop/renderer/package.json` | — |
| vue-router | `^4.5.0` | `desktop/renderer/package.json` | — |
| Vite | `^6.0.0` | `desktop/renderer/package.json` | — |
| Vitest | `^4.1.1` | `desktop/package.json` | main 与 renderer 各一套配置 |
| TypeScript | `^5.7.0` | `desktop/package.json` | CommonJS / strict |
| @microsoft/mxc-sdk | `0.7.0` | `desktop/package.json` | lockfile 锁定 |
| 腾讯微信插件 | `@tencent-weixin/openclaw-weixin` `2.4.6` | `plugins/openclaw-weixin/package.json` | vendored，含 `vendor/*.tgz` |
| 微信插件 host 最低版本 | `>=2026.5.12` | 插件 `peerDependencies` | 被锁定 2026.9.3 满足 |
| AppContainerLauncher | `net9.0-windows` | `appcontainer/AppContainerLauncher.csproj` | — |
| Windows Node Host | `net10.0-windows` | `windows-node-host/MicroClaw.WindowsNodeHost.csproj` | 依赖子模块 |
| 上游子模块 | `openclaw-windows-node` @ `fc9add75eda78daf548d80a55ffb64e63b159961` | `.gitmodules` + `PROVENANCE.json` | **未初始化**，见 `BLOCKERS.md` B5 |
| .NET SDK（本机实测） | 无（仅 runtime 8.0.27） | `dotnet --list-sdks` | 无法构建上述两个 .NET 工程，见 B4 |
| 目标 OS（本机实测） | 中文 Windows 11 专业版 `10.0.26100` | PowerShell 探测 | 符合「中文 Windows 11」要求 |
| 当前会话权限（实测） | 非管理员（`IsAdmin=False`） | PowerShell 探测 | 符合普通用户验收前提 |
| Windows UIA 可用性（实测） | 可用，枚举到 14 个顶层窗口 | PowerShell + UIAutomationClient | 中文窗口标题正常返回 |

## 本机可用的验证工具链

| 工具 | 命令 | 实测结果 |
|---|---|---|
| Node 单元测试（main） | `cd desktop && npx vitest run` | 59 files / 1256 passed, 2 skipped |
| Node 单元测试（renderer） | `cd desktop/renderer && npx vitest run` | 26 files / 304 passed |
| 类型检查 | `cd desktop && npx tsc --noEmit` | clean |
| ESLint（新增模块） | `cd desktop && npx eslint src/companyclaw` | clean |
| Python 测试 | `python -m unittest discover -s tests` | 294 tests，2 个既有 error（Python 3.11 限制） |
| PowerShell 语法校验 | `[Parser]::ParseFile(...)` | clean |

## 与实施书描述的差异（已核实）

| 实施书描述 | 实际情况 | 证据 |
|---|---|---|
| 仓库含 `deployer/`、`installer/`、`plugins/openclaw-weixin/`、`windows-node-host/`、`scripts/windows/`、`skills/` | 全部存在 | `ls` |
| README 称含 "browser automation managed skills" | `skills/` 仅 7 个目录，**无 browser 技能** | `find skills -maxdepth 2 -type d` |
| 技能数「52 built-in + 6 managed」 | `deployer/skill_catalog.py` 为 17 bundled + 6 managed | 读源码 |
| `pyproject.toml` `requires-python = ">=3.14"` | 实际 `pyproject.toml` **只有 Ruff 配置，无 `requires-python`** | 读文件 |
| Windows 构建 Node 要求 24.16+ 或 26.1+ | 一致 | `deployer/openclaw_version.py` |
