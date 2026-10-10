# CompanyClaw V5.0 — 依赖锁定

## 新增组件：Windows-MCP

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/CursorTouch/Windows-MCP` |
| 锁定 SHA | `b455c2766c63599d466a6178641bac70787979a4` |
| 版本 | `0.8.7` |
| 许可证 | MIT |
| Python 要求 | `>=3.14`（以 `pyproject.toml` 为准；manifest 中 `>=3.13` 不作为构建依据） |
| 传输 | stdio（仅由 Broker 以固定路径启动，不对外监听） |
| 遥测 | **禁用**（`ANONYMIZED_TELEMETRY=false`） |
| Watchdog | **保持关闭**（README 明确其可致 server 崩溃） |

### 直接依赖（用于离线装配与 SBOM）

click, comtypes, dxcam, fastmcp, fuzzywuzzy, markdownify, pillow, platformdirs, posthog,
psutil, pygments, python-levenshtein, pywin32, requests, tabulate, thefuzz, uuid7

## 既有组件（本次不升级）

| 组件 | 版本 | 来源 |
|---|---|---|
| OpenClaw | `2026.9.3` | `deployer/openclaw_version.py` |
| openclaw-weixin | `2.4.6` | `plugins/openclaw-weixin`（vendored） |
| Node（私有运行时） | v26.7.0 | `desktop/resources/node.exe` |
| Electron / electron-builder | 33 / 26 | `desktop/package.json` |

## 构建约束

- 员工端**不运行** `npm` / `pip` / `uvx` / `git`，不联网下载依赖。
- 上游 Server 只能由 Adapter 以**固定路径 + 哈希校验**启动，禁止任意 `command/args`。
- 版本漂移或校验失败必须显示具体中文错误码，不得伪装成"模型无法操作"。
