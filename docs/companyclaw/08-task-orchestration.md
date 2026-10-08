# 08 — 任务编排

## 状态机

```text
CREATED → AUTHENTICATED → PLANNING → RUNNING ⇄ AWAITING_APPROVAL
RUNNING → VERIFYING → COMPLETED / PARTIAL / FAILED

PLANNING / RUNNING / AWAITING_APPROVAL → PAUSE_REQUESTED → PAUSED → RESUMING → RUNNING | AWAITING_APPROVAL
任意活动态 → CANCELLED / EXPIRED
```

| 属性 | 规则 |
|---|---|
| 初始态 | `CREATED` |
| 关键闸门 | `AWAITING_APPROVAL`（未获确认不得进入写入） |
| 终态 | `COMPLETED` / `PARTIAL` / `FAILED` / `CANCELLED` / `EXPIRED` |
| 禁止转换 | `PAUSED → RUNNING` 直连（必须经 `RESUMING`） |
| 回退 | `VERIFYING → RUNNING`（未通过修正）；已提交写入**不可状态回退** |
| 转换入口 | 唯一：`TaskStore.advance` / `Runtime.controlTask` |

## 四个控制能力

| 控制 | 行为 | 说明 |
|---|---|---|
| pause | `RUNNING/AWAITING_APPROVAL/PLANNING → PAUSE_REQUESTED` | 立即停止派发新动作；在途动作继续等待并记录真实结果 |
| resume | `PAUSED → RESUMING` | **必须经过复核**；已过期授权不复用 |
| cancel | 任意活动态 → `CANCELLED` | **不等于**撤销已发生的业务修改 |
| emergency-stop | 任意活动态 → `CANCELLED` | 同上；不得宣称可撤销已提交交易 |

对终态任务的任何控制返回 `accepted: false` 并给出原因（不抛异常）。

## 幂等

- 幂等键：`createTaskIdempotencyKey(taskId, stepId, payloadHash)` → `taskId:stepId:payloadHash`
- 可通过 `findByIdempotencyKey` 查回既有任务，避免重复提交写入

## 所有者隔离

- 所有读取与操作按 `ownerSid` 过滤；跨 owner 访问返回 `null` 或抛 `not owned by`
- `advanceTask` 在任何转换前校验归属

## 并发

- 每个 store 单写队列，避免并发覆盖
- 审批终态唯一：并发情况下第二个决定被拒（`already-consumed`）
- Broker 侧：单次操作串行处理

## 界面

`/tasks` 任务中心（`TasksView.vue` + `stores/companyclaw.ts`）：

- 远程操作授权（15 分钟 / 1 小时 / 8 小时 + 立即撤销）
- 待审批列表（系统 / 记录 / 字段 / 原值→新值 / 有效期 + 批准/拒绝）
- 任务列表（14 种状态中文标签 + 暂停/恢复/取消/急停；终态不显示操作按钮）

## 未完成

| 项 | 说明 |
|---|---|
| 自动执行编排 | 尚无"收到任务 → 自动推进状态机 → 调用 Broker → 回读 → 完成"的调度器。当前状态机与执行桥均已可用且已测试，但未由 Agent 调用自动驱动 |
| 步骤级证据 | `evidenceRefs` 字段存在但未写入 |
| 计划与任务关联 | `usePlanProgress` 从模型文本解析，未与任务实体关联 |
| 队列 | 同一桌面独占写任务的排队未实现 |
| 中断恢复 | 重启后任务可查（持久化已实现），但"重启后复核并继续"未实现 |
