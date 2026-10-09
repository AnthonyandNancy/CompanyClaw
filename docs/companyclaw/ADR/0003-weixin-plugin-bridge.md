# ADR 0003：微信插件与桌面端的最小桥接

- 状态：已采纳
- 日期：2026-10-09
- 基线：`adc0520`（`feat/companyclaw-foundation`）
- 依据：ADR 0002 决策 5；Requirement V1.1 §10.1（微信插件先拦截审批回复）、§10.3 第一条（会话来源不可自然语言自报）

## 背景

ADR 0002 已交付桌面侧的审批格式化、解析与裁决（`desktop/src/companyclaw/remote/approval-message.ts`、`CompanyClawRuntime.applyApprovalReply`），并把插件侧接入列为"延后"。

缺口（源码证据，基线 `f1ab74e7`）：

- `desktop/src/main.ts` 的 `startGatewayInner()` 中有 `session-source` 的消费者分支与 `cachedRemoteSource` 声明，但**全仓库没有生产者**；`plugins/openclaw-weixin/` 内 `process.send` 零命中。因此 `cachedRemoteSource` 恒为 `undefined`，`runtime.isRemoteCallerAuthorized()` 永远拿不到可信来源。
- `plugins/openclaw-weixin/src/messaging/process-message.ts` 的 `processOneMessage()` 命中 `/` 前缀走 `handleSlashCommand`，否则直接进入 Agent（`dispatchReplyFromConfig`），**没有任何审批回复拦截**。
- 通道早已具备：`main.ts` 的 Gateway spawn 使用 `stdio: ["ignore","pipe","pipe","ipc"]`。

## 决策

1. **插件只转发，不裁决。** 新增 `plugins/openclaw-weixin/src/messaging/desktop-bridge.ts`，把原始文本与发送者 id 转发给桌面并等待答复；真正的校验（归属人、状态、过期、单次使用）全部留在 `CompanyClawRuntime.applyApprovalReply`。
2. **超时即放行。** 桌面 1.5s 内未答复时，文本原样进入 AI 管道。安全后果为零——没有票据就写不了——但绝不能把"审批失败"当成"已拒绝"。
3. **纯追加改动。** `process-message.ts` 仅在既有 slash 分支之后追加一个分支；`index.ts` 的 `register()` 仅追加一次监听安装。腾讯既有函数体一行未改。
4. **监听只装一次。** 应答监听在插件注册时安装（而非每条消息），`pending` 映射随应答或超时清理，不会无限增长。
5. **无桌面父进程即降级。** 开发运行或其他宿主下 `process.send` 不存在时，`forwardApprovalReply` 立即返回 `false`，不抛错、不阻塞消息处理。

## 理由

- **可测性**：桥接模块只依赖 `process` 的最小表面（`send` / `on`），因此能在无微信账号、无插件依赖的环境下完整单测。
- **信任分层**：插件一旦承担判定，就会形成"能聊天就能授予写入权"的路径。
- **不吞消息**：`handled === false` 与"未命中"走同一条放行路径，用户正常说"批准"不会被误判为授权。
- **升级冲突面最小**：符合裁决第七节第 8 条"尽量减少对腾讯原始源码的侵入修改"。

## 影响

- 插件侧：`desktop-bridge.ts`（新增）、`process-message.ts`（+25 行追加）、`index.ts`（+7 行追加）。
- 桌面侧：`main.ts` 的 `startGatewayInner()` 消息处理器新增 `approval-reply-request` 分支；`companyClawOwnerSid` 提升为模块级变量（与既有 `companyClawRuntime` 同样做法）。
- 未覆盖：微信出站实际发送与入站拦截的**真实端到端验证**依赖微信测试账号（`BLOCKERS.md`），在此之前相关 E2E 记 `BLOCKED`。

## 验证

- `cd desktop && npx vitest run --root ../plugins/openclaw-weixin` → 12 passed（桥接模块：发送元数据、无父进程、发送失败、命中/未命中、超时清理、监听路由）。
- `cd desktop && npx vitest run src/companyclaw/broker-client-spawn.test.ts` → 10 passed（含桌面侧必须应答、必须经 `isRemoteCallerAuthorized` 与 `applyApprovalReply`、插件分支必须放行未命中文本）。
- `cd desktop && npm run lint:weixin` → 0 errors。
