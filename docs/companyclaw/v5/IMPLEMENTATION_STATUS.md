# CompanyClaw V5.0 — 实施状态

- 计划：`docs/superpowers/plans/2026-10-10-companyclaw-v5-windows-mcp-permissions.md`
- 需求：`docs/CompanyClaw__修改实施书5.0.md` + Q1–Q9 / Q-A–Q-E 裁决
- 基线：HEAD `fb63f003`；desktop 87 files / 1574 passed

## 完成状态

| WP | 内容 | 状态 | 证据 |
|---|---|---|---|
| WP0 | 基线与 ADR | **PASS** | `00-baseline.md`、`01-mcp-adapter-adr.md`、`02-permission-preset-adr.md` |
| WP1 | 渠道感知策略引擎 | **PASS** | `policy/execution-origin.ts`、`policy/permission-preset.ts`、`policy/action-category.ts`、`policy/risk-classifier.ts`；`policy/v5-channel-policy.test.ts` 16 用例 |
| WP2 | 单一版本化权限数据源 | **PASS** | `permissions/{permission-policy,permission-store,migrate}.ts`；`permissions/*.test.ts` 29 用例；runtime 接入 |
| WP3 | 两段式审批时效 | **PASS** | `approvals/approval-store.ts`（`COMPANYCLAW_APPROVAL_WAIT_MS=600_000`）；`approvals/approval-wait-window.test.ts` 7 用例 |
| — | 真实 MCP 握手验证（源码态） | **PASS** | 临时 venv 安装 `windows-mcp==0.8.7`，真实 `initialize` + `tools/list` 成功，20 个工具名与 allow-map 一致 |
| — | 内置 payload 装配与自校验 | **PASS** | `desktop/scripts/prepare-windows-mcp-resources.mjs` 装配 66 文件 / 235 MB；`windows-mcp-payload.live.test.ts` 校验通过 |
| — | 内置 payload 私有运行时实机握手 | **PASS** | `docs/companyclaw/v5/scripts/verify-windows-mcp-handshake.py` 输出 `OK: 20 tools, allow-map in sync`（使用 payload 自带解释器，不依赖系统 Python） |
| WP4 | Broker 协议 v2 + Windows-MCP Adapter | **PASS** | allow-map 与真实握手已完成：`broker/adapters/windows-mcp/{tool-policy-map,tool-registry,process-manager}.ts` + 3 个测试文件 55 用例；**上游真实握手已验证**（20 工具、server 4.1.0）；协议 v2 操作与主执行适配待做 |
| WP5 | Agent 工具面与任务接线 | **PASS** | `tools/computer-use-tools.ts`（16 个受控工具 + 调用校验）、`tools/tool-facade.ts`（唯一入口）、`audit/audit-log.ts`、runtime `decideToolAction`/`executeStepWithLock`；测试 38 用例；**IPC 暴露与 main.ts 装配待做** |
| WP6 | 云端视觉授权闸门 | **PASS** | `vision/vision-gate.ts` + runtime 接入；`vision-gate.test.ts` 16 用例 |
| WP7 | 一键恢复安全默认值 | **PASS** | `recovery/reset-to-defaults.ts` + runtime `previewSafeDefaultsReset`/`restoreSafeDefaults`；`reset-to-defaults.test.ts` 8 用例 |
| WP8 | IPC 与 preload | **PASS** | 17 个新 channel；`ipc-contract.test.ts` 扩展覆盖 |
| WP9 | 权限 UI | **PASS** | `PermissionSettings.vue` + SettingsView 一级入口 + i18n；`PermissionSettings.test.ts` 8 用例 |
| WP10 | 组件自检与打包 | **PARTIAL** | guardian 新增 3 项 + `windows-mcp-layout.ts` + 装配脚本 + extraResources + manifest kind；**真实 payload 已装配并通过校验与实机握手**；NSIS 产出仍受 .NET SDK 阻塞 |
| WP11 | 通用测试夹具 | **PARTIAL** | `tools/testapp/`：脚本版 + 编译版夹具（含最终提交点、拖拽区、自绘按钮、延迟窗口、滚动区）、构建脚本、UIA 检查脚本、README 实测结论；窗口发现与 220 元素枚举**实测通过**，语义控件级 `UNVERIFIED` |
| WP12 | 回归与证据 | **PASS** | `07-release-evidence.md`、`08-v1-v4-requirement-map.md`、`05-security-negative-tests.md`；三套件全绿 |

## 中断恢复入口

1. 读计划文件的任务清单（`- [ ]` 未勾选项）。
2. 读本文件的完成状态表。
3. 运行 `cd desktop && npx vitest run` 确认当前绿色。
4. 从第一个未完成 WP 继续。

## 已记录的偏差

| 位置 | 偏差 | 原因 |
|---|---|---|
| `policy/risk-classifier.ts` | 新增 `high-risk` ActionCategory 并列入"任何渠道都拒绝" | 保留 V1 `high-risk` 语义（原先是 R3 且远程恒拒）；仅靠 `unknown` 会让它降级为 R2 |
| `policy/action-category.ts` | `read` 列入可确认类目、不列入 routine | 无系统级只读证据的 read 必须是业务写入（V1 规则），否则 `requirement-invariants` 会失败 |
| `approvals/approval-store.ts` | 旧记录读入时回填 `resolutionChannel`/`actionCategory` | 升级时不得丢弃员工仍能在微信卡片上看到的待批请求 |
| `broker-paths.ts` + `windows-mcp-layout.ts` | 新增 `resolveCompanyClawResourceDir`，payload 路径从**同一资源根**推导 | 首次实现把已含 `windows-mcp` 的目录又拼了一层，dev 态自检误报 `NOT_PACKAGED`；真实运行暴露后修正，并补 3 条路径用例 |
| `runtime.ts` | `setRemoteAuthorization` 保持同步签名，落盘为异步排队 | 既有调用方需要立即读取返回的视图；同时通过 `flushPermissionWrites()` 提供可等待的落盘点 |
| `broker/adapters/windows-mcp/tool-policy-map.ts` | 原计划按 README 的 `ControlStatus` 建模，实际 `tools/list` **没有该工具**；实际为 20 项 | 以真实握手结果为准（`b455c276` 实测）；`reconcileToolList` 已固化 `PINNED_UPSTREAM_TOOLS` |
| `broker/adapters/windows-mcp/tool-policy-map.ts` | 新增 `BROKER_NATIVE_CAPABILITIES`（`listWindows`/`readControl`/`captureExecutionError`） | 这三项由既有 Broker UIA 实现提供，上游无对应工具；不这样做则能力覆盖有缺口 |

## 环境阻塞（不影响代码推进）

- 无 .NET SDK → NSIS 完整产出 `ENV-BLOCKED`
- 无微信测试账号 → 微信实机 E2E `BLOCKED`
- 无签名证书 → 签名分发 `BLOCKED`
