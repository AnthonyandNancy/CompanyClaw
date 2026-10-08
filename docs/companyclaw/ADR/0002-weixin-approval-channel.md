# ADR 0002：微信审批通道的接入方式

- 状态：已采纳
- 日期：2026-10-09
- 上游基线：`6f080a07f43bd65b8b27ec6f859438fc038bb912`
- 依据：Requirement V1.1（冲突 4）、Design §4.3；《需求冲突裁决》第七节第 8 条「微信插件升级时应尽量减少对腾讯原始源码的侵入修改」

## 背景

远程审批闭环需要一个双向文本通道：

```
待执行写入 → 生成审批卡 → 微信展示 → 用户回复 → 服务端校验 → 执行
```

现有实现缺口（有源码证据）：

- `desktop/src/main.ts` 中存在 `session-source` IPC 的**消费者**（`main.ts:543` 注释、`main.ts:4106` 判断），但**全仓库没有生产者**；`plugins/openclaw-weixin/` 内 `process.send` / `ipc` 零结果。
- 因此 `cachedRemoteSource` 恒为 `undefined`，`notifyRemotePermissionNeeded()` 从不生效——它是一段死代码。
- 该函数本身也只做**单向通知**（"请在 Windows 桌面上授予权限"），没有任何回复处理能力。

## 决策

1. **审批消息的格式化与解析放在桌面侧**：`desktop/src/companyclaw/remote/approval-message.ts`，纯函数、无 IO、可独立单测。
2. **裁决权不下沉到插件**：`parseApprovalReply` 只把文本映射成"批准/拒绝 + 序号"；真正的校验（归属人、状态、过期、单次）全部由 `CompanyClawRuntime.applyApprovalReply` → `CompanyClawApprovalStore.resolve` 完成。
3. **不接受模糊输入**：只有显式形式（`Y` / `N` / `Y1` / `N2` / `批准` / `拒绝` / `全部批准` / `批准第2项` 等）被识别；其它文本返回 `null`，由调用方放行给 AI，**不吞掉普通聊天**。
4. **越权不可达**：回复只能作用于 `ownerSid` 匹配的待审批项，别人的请求既看不见也批不了。
5. **插件侧改动延后到最小 patch**：本 ADR 先交付桌面侧可测的完整逻辑；插件接入时只在 `process-message.ts` 的入站路径增加一个拦截分支（参照既有 slash 命令先例），不改动腾讯核心逻辑。

## 理由

- **可验证性**：把逻辑放在桌面侧，使其在无微信账号、无插件依赖的环境下也能被完整单测（当前已 19 项）。若把逻辑写进插件，则必须安装插件依赖并 mock 腾讯 SDK 才能验证。
- **安全边界**：审批的最终裁决必须在策略层，而非消息通道。插件一旦承担判定，就会形成"能聊天就能授予写入权"的路径，与 Requirement 的信任分层直接冲突。
- **可升级性**：满足裁决对"减少侵入"的要求；插件升级时冲突面最小。
- **不吞消息**：把"看起来像回复"和"确实是回复"严格分开，避免用户正常说"Y"（或"批准"作为语气词）时被误判为授权。

## 被否决的方案

- **在插件内实现审批判定**：破坏信任分层，且审批存储位于桌面进程，插件无法读取。
- **复用 `notifyRemotePermissionNeeded()`**：该函数无生产者、只做单向通知，且其数据源（`lastInputFromRemote` 单布尔值）已被裁决明令废弃。
- **宽松匹配（如包含"批准"即视为批准）**：会让自然语言误触发授权，属于需求红线。

## 影响

- 桌面侧：`approval-message.ts`（纯逻辑）+ `runtime.ts` 的 `buildApprovalMessage` / `applyApprovalReply`。
- 插件侧：待接入。接入时必须在 `docs/companyclaw/ADR/` 追加记录所用方式（patch / vendor / 上游升级）与差异。
- 未覆盖：微信出站实际发送与入站拦截的**真实验证**依赖微信测试账号（`BLOCKERS.md` B1），在此之前相关 E2E 只能记 `BLOCKED`。

## 验证

- `cd desktop && npx vitest run src/companyclaw/remote/approval-message.test.ts` → 19 passed
- `cd desktop && npx vitest run src/companyclaw/runtime.test.ts` → 23 passed（含 9 项审批消息用例）
- `cd desktop && npx tsc --noEmit` → clean
