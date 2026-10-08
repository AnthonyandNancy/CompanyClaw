# CompanyClaw Implementation Status

上游基线：`microsofthackathons/MicroClaw` @ `6f080a07f43bd65b8b27ec6f859438fc038bb912`
分支：`feat/companyclaw-foundation`
最后更新：2026-10-09

**中断恢复入口**。新接手者请按序阅读：
1. 本文件（进度与下一步）
2. `docs/companyclaw/00-verification-audit.md`（总实施书逐项核对）
3. `docs/companyclaw/00-upstream-baseline.md`（版本与依赖事实）
4. `docs/companyclaw/00-source-audit.md`（真实调用链与关键事实）
5. `docs/companyclaw/ADR/0001-security-core-modules.md`（安全内核边界决策）
6. `docs/superpowers/plans/2026-10-08-companyclaw-security-core.md`（安全内核实施计划）
7. `BLOCKERS.md`（9 项阻塞及解除条件）

> **完成状态声明**：整体项目**未完成**。已完成并在本机验证的是安全内核、Broker 策略与读取探针、安装器安全策略、产品标识。需要真实微信账号/内网系统的验收项全部记为 `BLOCKED`。

---

## 1. 阶段状态

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0-A 源码审计 + 构建基线 | **PASS** | 审计见 `00-source-audit.md`；desktop 59 files / 1256 passed；上游遗留断言修复 `f497085` |
| P0-B / V4 Windows-MCP 评估 | NOT-STARTED | 需网络调研 + 源码审计 |
| P0-B / V2 Broker 通信机制选型 | NOT-STARTED | 三项候选未定 |
| P0-C / V1 最小真实链路 | **BLOCKED** | 缺微信测试账号（`BLOCKERS.md` B1） |
| 安全内核 | **PASS** | 15 files / 113 passed |
| 安全内核接线 | **PASS** | `main.ts` IPC + `preload.ts` 命名空间，5 项契约测试通过 |
| Broker 策略、读取与写入操作 | **PASS** | 8 files / 54 passed，**含 9 项真实 UIA 实机验证** |
| 安装器安全策略（冲突 2） | **PASS** | Defender 排除项默认关闭；卸载默认保留用户数据；8 tests |
| 产品标识（P1 部分） | **PASS** | `com.companyclaw.desktop` / `CompanyClaw`；4 tests |
| P1 其余（用户数据目录、版本迁移） | NOT-STARTED | — |
| P2 模型 BYO 企业化补齐 | PARTIAL | 上游能力可用；能力探针未做 |
| P3 微信身份映射 / 送达状态接线 | PARTIAL | 扫码解绑上游既有；送达状态机已实现未接线；身份映射未做 |
| P4 受控 Browser 执行通道 | NOT-STARTED | — |
| P5 Windows UIA 自主操作 | PARTIAL | 读取 + set-value + invoke-pattern 已实机验证；send-keys 与整任务编排未接通 |
| P6 任务编排接入运行时 | PARTIAL | 状态机+持久化+控制已实现、接线并可在 UI 操作；自动调度未做 |
| P7 远程审批闭环 | PARTIAL | 服务端策略/票据/审批域已实现；**微信出站卡片与入站拦截未实现** |
| P8 文件结果闭环 | PARTIAL | 校验器+送达状态机已实现；产物目录落盘与接线未做 |
| P9 桌面 UI | PASS（任务中心） | `/tasks` 路由 + 侧边栏入口 + 远程授权/待审批/任务控制；55 个新 i18n 键 |
| P10 安装器 Per-User 化 | PARTIAL | 安全策略已改；Per-User 安装路径未改 |
| P11 E2E 验收 | **BLOCKED** | 缺目标环境 |

---

## 2. 已完成模块与测试

### 安全内核 `desktop/src/companyclaw/`（113 tests）

| 模块 | 文件 | 测试数 |
|---|---|---|
| 任务状态机 | `tasks/task-state.ts` | 6 |
| 任务持久化 | `tasks/task-store.ts` | 6 |
| R0–R3 分级 | `policy/risk-classifier.ts` | 9 |
| 一次性审批票据 | `policy/approval-ticket.ts` | 7 |
| 审批生命周期 | `approvals/approval-store.ts` | 7 |
| 执行桥（失败关闭） | `bridge/execution-bridge.ts` | 7 |
| 产物校验 | `results/artifact-validator.ts` | 6 |
| 送达状态机 | `results/delivery-status.ts` | 5 |
| 远程授权 + 会话来源 | `remote/remote-authorization.ts` | 7 |
| 运行时门面 | `runtime.ts` | 14 |
| Owner SID 解析 | `owner-sid.ts` | 6 |
| 产品标识 | `product-identity.test.ts` | 4 |
| 组合链路 | `companyclaw-core.test.ts` | 4 |
| 需求级不变量 | `requirement-invariants.test.ts` | 20 |
| IPC 契约 | `ipc-contract.test.ts` | 5 |
| 产品标识 | `product-identity.test.ts` | 4 |

### Broker `broker/`（54 tests，含 9 项实机）

| 模块 | 文件 | 测试数 |
|---|---|---|
| 线协议（封闭操作集） | `protocol.ts` | 9 |
| 服务端策略（SID/设备/时效/白名单/票据） | `policy.ts` | 13 |
| UIA 探针（窗口/控件树/读/写/激活） | `uia.ts` | 9 |
| loopback IPC 服务 | `server.ts` | 14 |
| **UIA 实机验证** | `uia.live` / `uia-binding.live` / `uia-write.live` / `server.live` | **9（真实 OS 调用，含写入回读）** |

### 安装器策略 `tests/`

| 内容 | 文件 | 测试数 |
|---|---|---|
| Defender 默认关闭 + 卸载保留数据 | `test_companyclaw_installer_policy.py` | 8 |

---

## 3. 独立验证证据（命令与实测结果）

| 验证 | 命令 | 结果 |
|---|---|---|
| 安全内核 | `cd desktop && npx vitest run src/companyclaw` | 15 files / **113 passed** |
| 桌面全量 | `cd desktop && npx vitest run` | 59 files / **1256 passed**, 2 skipped |
| 渲染端全量 | `cd desktop/renderer && npx vitest run` | 26 files / **304 passed** |
| Broker 全量 | `cd broker && npx vitest run` | 8 files / **54 passed** |
| **Broker 实机 UIA** | `cd broker && npx vitest run uia.live.test.ts uia-binding.live.test.ts uia-write.live.test.ts server.live.test.ts` | **9 passed（真实 Windows UIA，含写入回读验证）** |
| 类型检查（desktop） | `cd desktop && npx tsc --noEmit` | clean |
| 类型检查（broker） | `cd broker && npx tsc --noEmit` | clean |
| Lint（新模块） | `cd desktop && npx eslint src/companyclaw` | clean |
| Python 全量 | `python -m unittest discover -s tests` | 294 tests，**2 个既有 error**（Python 3.11 缺 `rmtree(onexc=)`；CI 用 3.12） |
| PowerShell 语法 | `[Parser]::ParseFile(...)` | clean |

### 本机环境事实（实测）

| 项 | 值 |
|---|---|
| OS | 中文 Windows 11 专业版 `10.0.26100` |
| 权限 | 非管理员（`IsAdmin=False`） |
| Windows UIA | **可用**，成功枚举真实顶层窗口并返回有效 PID |
| Node | `v26.7.0`（满足 `>=24.16.0 <25 \|\| >=26.1.0`） |
| Python | `3.11.9` |
| .NET | 仅 runtime `8.0.27`，**无 SDK**（阻塞 B4） |

---

## 4. 尚未完成（按依赖顺序）

1. **P0-B / V4**：Windows-MCP 专项评估（离线可做）。
2. **P0-B / V2**：Broker 通信机制选型（命名管道 / loopback / stdio）。
3. **`send-keys` 与 `describe-element`**：仍为 `not-implemented`（不伪造成功）。
4. **Broker 进程启动接线**：`main.ts` 尚未拉起 Broker 子进程并注入 token/SID/白名单。
5. **微信审批文本通道**：出站卡片 + 入站拦截（最小 patch + ADR）。
6. **会话来源打通**：`session-source` 生产者（当前全库缺失）。
7. **受控 Browser 执行通道**（P4）。
8. **安装器 Per-User 化**（P10）。
9. **E01–E20 与 S1–S9**：需目标环境。

---

## 5. 阻塞

见 `BLOCKERS.md`（B1–B9）。核心是 B1（无微信测试账号）与 B2（无内网系统/脱敏数据）——二者直接决定 P0-C、P3、P4、P7、P11 能否真实验收。
