# CompanyClaw Implementation Status

上游基线：`microsofthackathons/MicroClaw` @ `6f080a07f43bd65b8b27ec6f859438fc038bb912`（2026-09-11）
分支：`feat/companyclaw-foundation`
最后更新：2026-10-08

本文件是中断恢复的入口。新接手者请先阅读：
1. `docs/companyclaw/ADR/0001-security-core-modules.md`
2. `docs/superpowers/plans/2026-10-08-companyclaw-security-core.md`
3. 本文件的状态表

---

## 1. 阶段状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0-A 源码审计 + 构建基线 | **PASS** | 依赖安装完成；`npx vitest run`（desktop）44 文件 / 1143 通过；上游遗留断言修复见 `f497085` |
| P0-B / V4 Windows-MCP 评估 | NOT-STARTED | 需网络与目标机 |
| P0-B / V2 Broker 通信选型 | NOT-STARTED | 命名管道 / loopback / stdio 三选一 |
| P0-C / V1 最小真实链路 | **BLOCKED** | 需中文 Windows 目标机 + 微信测试账号 + 内网测试系统 |
| P0-D V3/V5/V6/V8/V9 | NOT-STARTED | 依赖 P0-C |
| 安全内核（Task 1–10） | **PASS（逻辑层）** | 见下表；仅逻辑层，无 Electron/UI/Broker 接线 |
| P1–P11 其余部分 | NOT-STARTED | — |

---

## 2. 已完成：CompanyClaw 安全内核

所有模块位于 `desktop/src/companyclaw/`，**未修改 `main.ts` 及任何既有上游模块**。

| 模块 | 文件 | 测试 | 状态 |
|---|---|---|---|
| 任务状态机（含 PAUSE_REQUESTED/PAUSED/RESUMING） | `tasks/task-state.ts` | `tasks/task-state.test.ts` | PASS 6/6 |
| 任务持久化（版本化 + 归属隔离 + 幂等键） | `tasks/task-store.ts` | `tasks/task-store.test.ts` | PASS 6/6 |
| R0–R3 风险分级 | `policy/risk-classifier.ts` | `policy/risk-classifier.test.ts` | PASS 9/9 |
| 一次性 HMAC 审批票据 | `policy/approval-ticket.ts` | `policy/approval-ticket.test.ts` | PASS 7/7 |
| 审批生命周期 | `approvals/approval-store.ts` | `approvals/approval-store.test.ts` | PASS 7/7 |
| 执行桥（失败关闭） | `bridge/execution-bridge.ts` | `bridge/execution-bridge.test.ts` | PASS 7/7 |
| 产物校验（魔数 + 容器） | `results/artifact-validator.ts` | `results/artifact-validator.test.ts` | PASS 6/6 |
| 送达状态机 | `results/delivery-status.ts` | `results/delivery-status.test.ts` | PASS 5/5 |
| 远程授权 + 会话来源 | `remote/remote-authorization.ts` | `remote/remote-authorization.test.ts` | PASS 7/7 |
| 组合链路验证 | — | `companyclaw-core.test.ts` | PASS 4/4 |
| 需求级不变量（独立断言） | — | `requirement-invariants.test.ts` | PASS 20/20 |

合计：**84 个测试通过**（11 个测试文件）。

### 独立验证证据

| 验证 | 命令 | 结果 |
|---|---|---|
| 模块测试 | `npx vitest run src/companyclaw` | 11 文件 / **84 passed** |
| 全量桌面回归 | `npx vitest run`（desktop） | 55 文件 / **1227 passed**, 2 skipped |
| 全量渲染端回归 | `npx vitest run`（desktop/renderer） | 26 文件 / **304 passed** |
| 类型检查 | `npx tsc --noEmit` | **PASS** |
| 新增模块 lint | `npx eslint src/companyclaw` | **PASS**（0 error / 0 warning） |
| 范围纪律 | `git diff --name-only main..HEAD` | `main.ts` **未改动**；`appcontainer/**`、`windows-node-host/**`、`plugins/**`、`skills/**`、`windows-node-mxc*.ts` **未改动** |

### 上游既有问题（非本工作引入，已核实）

- `npx eslint .` 报 2 个 error：`src/chat-attachments.ts:105`（`no-control-regex`）、`src/openclaw-upgrade-recovery.ts:235`（未使用的 `readJsonObject`）。
- 证据：这两文件 `git diff main..HEAD` 为空（与上游完全一致），且上游 `main` 分支同样存在该源码。
- 处理：**不在本计划范围内修改**（`desktop/src/startup-order.test.ts` 的同类上游遗留断言已单独修复并提交 `f497085`）。

---

## 3. 与 Requirement 的映射

| Requirement / 裁决项 | 落点 |
|---|---|
| F6 任务状态机；`PAUSED→RUNNING` 必须经 `RESUMING` | `task-state.ts` |
| F6 暂停 / 恢复 / 取消 / 急停四态控制 | `task-state.ts` `nextStateForControl` |
| F7 R0 需系统级只读证据；不可证明则不得 R0 | `risk-classifier.ts` |
| F7 不按工具名判级 | `risk-classifier.ts`（`unknown` → R2） |
| F7 R3 永久拒绝且无开关 | `risk-classifier.ts`（R3 恒 `deny`） |
| F7 R2 无法拦截最终写入则拒绝 | `risk-classifier.ts` `commitInterceptable` |
| F7 票据绑定任务/系统/记录/字段/原值/新值；短时、单次、防重放 | `approval-ticket.ts` |
| F7 审批只能由本人决定；终态不可再授权 | `approval-store.ts` |
| F7 守卫在到达执行器前生效；失败关闭 | `execution-bridge.ts` |
| F8 产物按魔数与容器校验 | `artifact-validator.ts` |
| F8 `SENT ≠ DELIVERED`；不回执则 `UNKNOWN` | `delivery-status.ts` |
| F3/F7 远程授权显式开启、有 TTL、可撤销 | `remote-authorization.ts` |
| F3/F7 会话来源来自通道元数据，不接受用户文本自证 | `bindSessionSource` |
| 数据约束：版本化、归属隔离、fail-safe 默认 | `task-store.ts` / `approval-store.ts` / `remote-authorization.ts` |

---

## 4. 已知边界（**UNVERIFIED**）

以下均**未经真实验证**，不得标记为 PASS：

- 微信 → Gateway → Broker → UIA 整条链路
- Broker 与 AppContainer 的 IPC 可达性
- Windows-MCP 可复用性（是否直接复用 / 包装 / 不采用）
- Broker 进程本体（UIA 执行器）——尚未实现
- 微信插件审批文本通道——尚未实现
- `main.ts` 装配与 IPC 注册——尚未实现
- 任务中心 UI——尚未实现
- 每任务产物目录落盘（`jobs/<taskId>/artifacts`）——尚未实现
- 安装器 Per-User 化、Defender 排除项默认关闭——尚未实现
- 普通用户无管理员安装与运行
- 锁屏 / UAC / DPI / 多屏下的 UIA 行为
- 微信文件真实送达

---

## 5. 下一步（按依赖顺序）

1. **P0-B / V4**：Windows-MCP 专项评估（离线可做）。
2. **P0-B / V2**：Broker 通信机制选型（离线可做）。
3. **P0-C / V1**：最小真实链路验证（需目标机）。
4. 策略层 + 任务层接线到 `main.ts`（新增 IPC，不改既有逻辑）。
5. Broker 进程 + UIA 执行器。
6. 微信插件审批文本通道（最小 patch + ADR）。
7. 任务中心 UI。
8. 安装器 Per-User 化。
