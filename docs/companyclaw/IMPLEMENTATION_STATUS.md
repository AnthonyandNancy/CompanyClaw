# CompanyClaw Implementation Status

上游基线：`microsofthackathons/MicroClaw` @ `6f080a07f43bd65b8b27ec6f859438fc038bb912`
分支：`feat/companyclaw-foundation`
最后更新：2026-10-09（V2 自包含安装实施）
本轮基线：`929a995`

**中断恢复入口**。新接手者请按序阅读：
1. 本文件（进度与下一步）
2. `docs/companyclaw/00-verification-audit.md`（总实施书逐项核对）
3. `docs/companyclaw/00-upstream-baseline.md`（版本与依赖事实）
4. `docs/companyclaw/00-source-audit.md`（真实调用链与关键事实）
5. `docs/companyclaw/ADR/0001-security-core-modules.md`（安全内核边界决策）
6. `docs/superpowers/plans/2026-10-08-companyclaw-security-core.md`（安全内核实施计划）
7. `docs/superpowers/plans/2026-10-09-companyclaw-v2-selfcontained-installer.md`（V2 自包含安装实施计划）
8. `BLOCKERS.md`（9 项阻塞及解除条件，含责任主体分类）

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
| V2 运行时清单契约 | **PASS** | `runtime-manifest.ts`，9 项负向/正向用例 |
| V2 统一资源流水线 | **PARTIAL** | 脚本与契约测试 PASS；本机构建机实跑在 `dotnet publish` 处 `BLOCKED`（B4），Node 与 OpenClaw 阶段已实测成功（527MB staging 产出） |
| V2 打包契约对齐 | **PASS** | `extraResources` 加 6 项契约测试；发现并归类 2 个未分类来源 |
| V2 首次运行初始化 | **PASS** | `first-run-init.ts`，17 项用例；`main.ts` 接线 |
| V2 Broker 生产启动 | **PASS** | 10 项用例（命令、令牌不落 argv、中文空格路径、回退） |
| V2 构建入口收敛 | **PASS**（静态） | `build.ps1` Step 3 → `release:win`；完整构建受 B4 阻塞 |
| V2 首次向导补齐 | **PASS** | 探针结果 + 微信入口；renderer 27 files / 320 passed |
| V2 Broker 可操作性区分 | **PASS** | 状态字段 + IPC + UI；desktop 75 files / 1451 passed |
| V2 微信桥接 | **PASS**（逻辑层） | 桥接 12 项 + 桌面接线 2 项；**真机 E2E 仍 BLOCKED（B1）** |
| 安装器安全策略（冲突 2） | **PASS** | Defender 排除项默认关闭；卸载默认保留用户数据；8 tests |
| 产品标识（P1 部分） | **PASS** | `com.companyclaw.desktop` / `CompanyClaw`；4 tests |
| P1 产品标识 | **PASS** | 已品牌化；**版本迁移未实现** |
| P2 模型 BYO | **PASS**（探针） | 能力探针（三态，`unknown` 不当作可用）；vision/reasoning/structured-output 未探测 |
| P3 微信身份映射 / 送达状态 | **PASS**（逻辑层 + UI） | 身份绑定（微信↔设备↔SID）+ 解绑 + 送达状态机；**插件侧接入与实机验证未做** |
| P4 受控 Browser 策略 | **PASS**（策略层） | 域名白名单/读写分级/能力开关已实现 + UI；**实际浏览器驱动未实现** |
| P5 Windows UIA 自主操作 | **PASS**（操作层） | 读取 + set-value + invoke-pattern + send-keys 均已实机验证；`describe-element`/`wait-for-window` 未实现 |
| P6 任务编排 | **PASS** | 状态机 + 编排器（逐步执行 + 回读证明 + 取消即时生效）；未接入微信入口 |
| P7 远程审批闭环 | PARTIAL | 服务端策略/票据/审批域/消息格式化与解析已实现并测试；**插件侧出站卡片与入站拦截未接入** |
| P8 文件结果闭环 | **PASS**（逻辑层） | 校验器 + 送达状态机 + 每任务产物目录（含包含性检查）已实现；未接入实际回传 |
| P9 桌面 UI | PASS（任务中心） | `/tasks` 路由 + 侧边栏入口 + 远程授权/待审批/任务控制；55 个新 i18n 键 |
| P10 安装与打包 | **PASS**（配置层） | Per-User + 禁止提权 + Node 目录用户可写 + Defender 默认关闭 + 卸载保留数据；**未产出安装包（无签名证书）** |
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
| Node 目录用户可写 + 文档不实修正 | `test_companyclaw_node_scope.py` | 4 |

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
3. **浏览器实际驱动**：策略层与 UI 完备，但**无执行器**（`skills/` 无 playwright/chromium）。
   `browser.*` 配置已由首次运行初始化补齐，但真实 Web 自动化仍需接入 OpenClaw 原生 Browser 或另行裁定。
4. **任务编排接线**：`TaskOrchestrator` 与 `CompanyClawRuntime.execute()` 仍无生产调用方（仅测试引用）。
5. **`describe-element` / `wait-for-window`**：仍为 `not-implemented`（不伪造成功）。
6. **微信审批出站卡片**：入站拦截与 `session-source` 已接通（ADR 0003）；
   主动推送审批卡片（`buildApprovalMessage` → 真实发送）尚需与任务编排一并接入。
7. **安装包产出**：脚本链已收敛为 NSIS Per-User 主线；完整产出受 B4（构建机 .NET SDK）与 B6（签名）影响。
8. **E01–E20 与 S1–S9**：需目标环境（微信账号 / 内网系统 / 目标机）。

**V2 本轮已关闭的缺口**：`dist` 不装配运行时资源、`extraResources` 死引用与 Broker 缺项、
Broker 用 `process.execPath` 启动、首次运行无人生成 Gateway 令牌与浏览器配置、
`session-source` 无生产者、审批回复无入站拦截、构建入口不产 NSIS 安装包。

---

## 5. 阻塞

见 `BLOCKERS.md`（B1–B9）。核心是 B1（无微信测试账号）与 B2（无内网系统/脱敏数据）——二者直接决定 P0-C、P3、P4、P7、P11 能否真实验收。
