# ADR 0004：受控 Browser 执行路径的落地方式

- 状态：已采纳
- 日期：2026-10-09
- 基线：`c6e090a`（`feat/companyclaw-foundation`）
- 依据：V3 实施书 §10.1、§10.2、§17.2；Requirement V1.1 F4；裁决「不得把原生 `browser`/`exec` 直通当作受控写入」

## 背景

需求要求远程任务的**每一个可执行动作**都经过受控适配器的服务端策略检查，并明确要求先回答一个技术问题：

> 不可假定内置 `browser` 工具可被简单外部重载；先检查工具注册入口、工具调用中间件与权限收口点，写 ADR。

调查结论（源码证据，基线 `c6e090a`）：

1. **不存在通用工具调用中间件。** 全仓库检索 `tool_call` / `beforeToolCall` / `toolMiddleware` 在 `desktop/src` 下**零命中**（唯一命中是 `model/capability-probe.ts` 解析模型响应里的 `tool_calls` 字段，与拦截无关）。
2. **唯一存在的运行时拦截机制是模块级 patch。** `desktop/src/openclaw-approval-replay-compat.mjs` 使用 `node:module` 的 `registerHooks` 重写 OpenClaw 内部模块，且依赖**三个模块文件名 + SHA256 白名单**（`EXPECTED_NODE_GATEWAY_MODULE`、`EXPECTED_SYSTEM_RUN_MODULE`、`EXPECTED_EXEC_APPROVAL_MODULE`），并在 `validatePinnedOpenClawApprovalPackage()` 中校验与被 patch 源码逐字节匹配。
3. **该机制默认不生效。** 它只在 `--import <approvalCompatPath>` 时加载，而 `main.ts:3965` 仅为 `windowsNodeMxcDesired`（`securityMode === "windows-node-mxc"`）注入该参数。默认 `securityMode` 是 `appcontainer`（`main.ts:333`），因此**普通员工的默认配置下没有任何模块级拦截**。
4. **Agent 的工具面由配置驱动，而非运行时拦截。** `windows-node-mxc.ts` 展示了产品已有的收口方式：`tools.allow` / `tools.deny` 白名单 + `WINDOWS_NODE_MXC_LOCKED_TOOL_DENYLIST` 显式包含 `"browser"` 与 `"group:runtime"`。也就是说，仓库既有能力是"**决定 agent 能看到哪些工具**"，而不是"在工具调用发生时拦截它"。
5. **Browser 能力来自上游 OpenClaw**（`config-write-policy.ts` 允许顶层键 `browser`；`first-run-init.ts` 只写 `browser.enabled` 与 `browser.executablePath`）。本仓库无 CDP/Playwright 依赖，**没有自己实现浏览器驱动的能力**。

## 决策

1. **不为本产品新增模块级 patch。** 用 `registerHooks` 去 patch 上游 browser 工具不是可靠收口点：它依赖 OpenClaw 内部模块名与字节级 SHA，任何上游版本变化都会让拦截**静默失效**（现有 MXC patch 已用显式校验把这个风险暴露为失败，但把它扩展到 browser 会让"远程写入安全"依赖一个随上游漂移的实现细节）。需求也禁止把这种假设当作安全依据。

2. **采用需求给出的备选路径：远程会话关闭不可控原生工具的可达性，只开放受控适配器。**
   - 受控 Browser 适配器（`desktop/src/companyclaw/browser/browser-adapter.ts`）是**唯一**放行远程 Web 动作的入口：它先调用 `CompanyClawRuntime.authorizeBrowserAction()`（域名白名单 + 能力开关 + 远程授权三闸门），再按 `risk` 决定是否需要票据，最后才把动作交给一个**注入的**执行器。
   - 无票据的 `write` / 任何 `high-risk` 动作**不产生执行器调用**（由执行桥的既有语义保证：`execution-bridge.ts` 在 transport 之前判定）。
   - 原生工具面收窄属于配置层（与 `windows-node-mxc` 的 `tools.deny` 同一种机制），因此复用既有能力而非新增拦截器。

3. **本地原生能力与远程安全基线分开验收。** 适配器不改变本机 Agent 的既有能力；它只约束"远程任务可以触发什么"。

4. **执行器实现保持注入式。** `browser-adapter.ts` 接收 `execute` / `readBack` 两个函数并只做策略与流程编排，因此：
   - 在没有可用上游驱动（本机受 B2 阻塞、仓库无驱动依赖）时，适配器仍可被完整测试；
   - 真实驱动接入是后续独立步骤，不需要改动适配器的安全语义。

5. **回读是完成条件。** 动作执行后必须回读；回读不匹配返回 `partial`（对齐 `TaskOrchestrator` 的 PARTIAL 语义），不得报完成。

## 被否决的方案

- **在 `registerHooks` 里 patch browser 工具**：依赖上游内部模块名与 SHA；上游升级会静默失效；需求 §10.2 明确不许假定可重载。
- **只依赖 `browser-policy.ts` 的存在**：需求 §10.1 与 §16.2 明确指出"策略层 PASS"不等于执行层受控；没有调用方时它什么也不保护。
- **把浏览器驱动打进本仓库**（Playwright/CDP）：新增第三方运行时依赖、需要处理下载与许可证，且与"优先接 OpenClaw 原生 Browser"的 §10.1 原则冲突；属 Plan Adjustment 范围，本次不做。

## 影响

- 新增 `desktop/src/companyclaw/browser/browser-adapter.ts`（纯策略编排 + 注入式执行/回读）。
- 不改 `browser-policy.ts`（既有规则符合 §10.3）；不改 `risk-classifier.ts` / `execution-bridge.ts`（R0–R3 语义唯一）。
- 远程会话的原生工具收窄沿用 `tools.allow/deny` 既有机制，属配置层，不在本 ADR 引入新代码。
- **未覆盖**：真实 Web 导航、真实业务写入与回读校验需要内网测试系统与脱敏数据（`BLOCKERS.md` B2），在获得前保持 `BLOCKED`；本 ADR 只保证"策略与流程闭环存在且可测"。

## 验证

- `desktop/src/companyclaw/browser/browser-adapter.test.ts`：未授权 / 域名不匹配 / 无票据写 / high-risk 四类拒绝，且**执行器零调用**；只读通过；回读不匹配返回 `partial`。
- 需求 §10.5 的测试站点 A/B/C 与打包态实测记 `BLOCKED`（B2）。
