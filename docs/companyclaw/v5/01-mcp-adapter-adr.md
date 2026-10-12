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

---

## 8. 实施补充（2026-10-10）：四项已核实事实改变了落地方式

### 8.1 `list-installed-apps` 改由 Broker 原生承载

上游固定版本（0.8.7 / `b455c2766c63`）**没有任何工具**枚举已安装应用：`get_apps_from_start_menu()` 只被 `launch_app` 内部调用，不对外暴露。因此该能力改由 Broker 自有只读探针 `broker/scripts/list-installed-apps.ps1`（`Get-StartApps`，含 Start Menu `.lnk` 回退）承载，并登记进 `BROKER_NATIVE_CAPABILITIES`；`App` 工具的 capability 列表相应去掉 `listInstalledApps`。

这与本 ADR 第 8 条「上游能力不可用时用既有 Broker 的同等受限能力替补」一致。

### 8.2 内置副本的加载机制与哈希约束（决定了「零改动 vendored Python」）

实测：`session.ts` 以 `cwd: layout.serverDir` 启动 `python -m windows_mcp serve`，`python -m` 会把 `cwd` 置于 `sys.path[0]`，因此实际加载的是**内置副本** `server/windows_mcp/`，而 `python-runtime/Lib/site-packages/windows_mcp/` 虽存在但永不被加载。

`MANIFEST.json` 覆盖 66 个文件，**全部**是 `windows_mcp/**/*.py`，且 `process-manager.ts` 逐文件校验 sha256，不符即返回 `HASH_MISMATCH`（用户可见「组件校验失败」）。因此：

- 改 `server/windows_mcp/*.py` → 必报 `HASH_MISMATCH`；
- 改 `python-runtime/.../site-packages/` → 不被校验，但也不生效。

**结论：vendored Python 保持零改动。** 所有新增能力落在 Broker 自有目录（`broker/scripts/`、`broker/adapters/`）。

### 8.3 MCP 端点是进程级共享连接，无法识别渠道来源

`mcp-endpoint.ts` 的 `callTool` 签名只有 `{name, arguments}`；OpenClaw 的 MCP client 按 server 名统一管理连接（`mcp-client-lifecycle`），且 `mcp.servers` 没有 per-agent 作用域。因此本机对话与微信对话共用同一连接，端点侧**收不到可信的来源信息**。

两条推论：

1. `runAgentToolCall` 固定以 `origin: "local-ui"` 进入策略层是**结构性**的，不是遗漏；
2. 依赖渠道区分的规则不能靠「识别来源」实现。裁决 ③（完全权限下 remote 未开启也放行）因此落在 `decideAction()` 的档位分支上，与来源无关。

### 8.4 探针输出必须显式设置为 UTF-8

`runScript`（`broker/uia.ts`）以 `encoding: "utf8"` 读取探针 stdout，但 Windows PowerShell 默认按控制台代码页写出，实测导致中文窗口标题与中文应用名全部变成 U+FFFD（15 个窗口中 8 个标题损坏），使 `launch-app` 按显示名匹配、`focus-window` 按标题匹配对中文用户完全不可用。

所有 `broker/scripts/*.ps1` 因而显式设置 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` 与 `$OutputEncoding`。
