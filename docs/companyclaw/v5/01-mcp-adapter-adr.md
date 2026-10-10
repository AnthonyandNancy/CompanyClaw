# 01 — ADR：Windows-MCP 集成与工具 allow-map

- 状态：已接受（2026-10-10）
- 关联需求：V5 §2.2、§3、§5、§6；Q7（拖拽必修）
- 关联计划：WP4、WP10

## 决策

1. **内置真实上游 Windows-MCP**，不伪造同名接口。
   锁定 `CursorTouch/Windows-MCP` @ `b455c2766c63599d466a6178641bac70787979a4`（v0.8.7，MIT）。
2. Windows-MCP 是 **Broker 管理的受限执行后端**，不是 Agent 可直连的 MCP 服务器。
   调用链固定为 `Agent → Tool Facade → Policy Engine → ExecutionBridge → Broker → Adapter → Windows-MCP`。
3. **不把上游工具原样映射给模型**。先取真实 `tools/list`，按 allow / wrap / deny 三分（见 `00-baseline.md` §4）。
4. 上游 `PowerShell`、`FileSystem`、`Registry`、`Process`、`Clipboard`、`Scrape`、`Notification` 一律 **DENY**。
5. Adapter 只允许启动**固定路径 + 哈希已校验**的 Server；**禁止**接受任意 `command/args`，
   否则 `launchApp` 会退化为任意命令执行。
6. `ANONYMIZED_TELEMETRY=false`；`WINDOWS_MCP_WATCHDOG` 保持默认关闭（README 明确其可致 server 崩溃）。
7. 采用**应用私有 Python 解释器 + 隔离 site-packages**，员工端不运行 `uvx`/`pip`/联网下载。
8. 上游某项能力在中文 Win11 上不可用时，用既有 Broker 的同等受限能力替补；
   **整套集成不得因此被移除**。

## 被否决的替代方案

- **直接让 Agent 连接 Windows-MCP**：Agent 将获得 `PowerShell` 与任意文件删除能力，违反「一键授权 ≠ 无边界 Shell」。
- **自己实现同名 windows-mcp 接口**：违反「使用上游真实 MCP 工具」的明确要求。
- **同时打包 desktop-touch-mcp**：需求明确不要求，且引入版本与供应链负担。

## 后果

- 需要在 Broker 内新增 adapter 层与工具策略映射，并在打包流水线新增私有运行时与哈希校验。
- Agent 可见工具集合比上游窄；这是**有意为之**，窄集合由 W01–W18 的产品能力补齐。
