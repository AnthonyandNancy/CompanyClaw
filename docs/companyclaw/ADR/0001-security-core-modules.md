# ADR 0001：安全内核作为独立纯逻辑模块

- 状态：已采纳
- 日期：2026-10-08
- 上游基线：`6f080a07f43bd65b8b27ec6f859438fc038bb912`
- 依据：《CompanyClaw 源码调查结论与实施架构方案 V1.0》§4、§5；Requirement V1.1 F6/F7/F8

## 背景

CompanyClaw 需要在远程（微信）场景下具备执行层强制的授权、拦截与审计能力。上游 MicroClaw 的现状：

- `desktop/src/main.ts` 已 8046 行，承载 Gateway 生命周期、约 130 个 IPC handler、沙箱编排、MXC 事务、权限分发等全部安全决策（证据：`wc -l desktop/src/main.ts`）。
- 权限风险分级（low/medium/high）只存在于展示层 `PermissionDialog.vue`，没有执行层策略。
- `lastInputFromRemote`（`main.ts:542`）是单布尔值，且 `session-source` IPC 只有消费者没有生产者（`main.ts:543`、`main.ts:4106`），远程审批链路实际从未生效。
- 既有 `PermissionDialog` 的只读判定（`accessNeeded: "ro"`）由被调用方自报，不能作为安全依据。

## 决策

1. **安全内核作为独立纯逻辑模块**，位于 `desktop/src/companyclaw/`，不依赖 Electron、不依赖 `electron-store`，可在 Node 环境下直接单测。
2. **不修改 `main.ts` 既有逻辑**。接线阶段只新增装配代码与 IPC handler，既有分支保持不变。
3. **不修改上游安全机制**：AppContainer（`appcontainer/**`）、MXC（`desktop/src/windows-node-mxc*.ts`、`windows-node-host/**`）、微信插件核心源码（`plugins/openclaw-weixin/src/**`）保持不变。
4. **所有默认值 fail-safe**：远程操作默认关闭；存储不可读/格式非法/版本不符时"什么都不授权"；R3 恒拒绝且无开关。
5. **R0 必须由系统级证据证明**（只读账号 / 只读 ACL / 已证明无副作用的动作集），否则一律按业务写入处理。
6. **分级不由工具名决定**：`unknown` 类动作按 R2 处理，因为仅凭名称无法证明安全。

## 理由

- **避免继续放大 `main.ts`**：新能力全部外置，降低回归风险，符合 Requirement "禁止无意义重构"与 Design §5.4。
- **可独立测试**：纯逻辑模块使 R0–R3 裁决、票据生命周期、状态机可在无 Windows 环境、无 Electron 环境下被验证。当前 P0-C 受目标机阻塞，这一选择让安全内核仍能真实交付并被验证。
- **信任分层**：策略层是唯一裁决点，执行桥只透传与失败关闭，Broker（后续）做服务端二次强制。既不依赖 Agent 自律，也不依赖提示词。
- **复用而非重造**：票据采用 HMAC-SHA256 + 短时 + 单次消费 + 多字段绑定，语义对齐上游 `windows-node-host/ApprovalProof.cs` 的既有设计；存储采用 `contract` + `schemaVersion` 版本化，对齐 `windows-node-mxc-durable-approvals.ts`。

## 被否决的方案

- **扩展现有 `PermissionDialog` 作为策略层**：风险分级属于展示逻辑，且只读判定来自自报，无法满足"不得仅凭提示词或按钮名称判断"的红线。
- **在 `windows-node-host` 内扩展 UI 能力**：裁决明确禁止把 MXC Host 扩展为通用桌面控制器。
- **直接接入 Windows-MCP 全量工具**：裁决明确禁止；且无法满足 R2 的"执行层能可靠拦截最终写入"。

## 影响

- 后续接线（IPC、UI、Broker）依赖本 ADR 定义的接口边界。
- 安全内核的 64 个测试成为回归基线；任何后续修改必须保持其通过。
- 未覆盖项（Broker 进程、微信审批通道、UI、安装器）需各自独立计划，不得因本 ADR 已采纳而视为完成。

## 验证

- `cd desktop && npx vitest run src/companyclaw` → 10 文件 / 64 测试通过
- `cd desktop && npx tsc --noEmit` → 通过
- `cd desktop && npx eslint src/companyclaw` → 无告警
- `cd desktop && npx vitest run` → 全量回归（含上游 44 文件）
