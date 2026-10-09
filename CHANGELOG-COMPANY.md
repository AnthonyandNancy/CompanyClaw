# CompanyClaw 二次开发变更日志

上游基线：`microsofthackathons/MicroClaw` @ `6f080a07f43bd65b8b27ec6f859438fc038bb912`
分支：`feat/companyclaw-foundation`

本日志按功能分组记录二次开发改动。每条都可定位到具体 commit 与文件。

---

## 基础设施

| 改动 | 文件 |
|---|---|
| 修复上游遗留的过期断言（PR #192 重命名后未更新测试） | `desktop/src/startup-order.test.ts` |
| 产品标识改为 CompanyClaw | `desktop/electron-builder.yml` |

## 安全内核 `desktop/src/companyclaw/`

| 模块 | 文件 | 作用 |
|---|---|---|
| 任务状态机 | `tasks/task-state.ts` | 14 状态；`PAUSED→RUNNING` 直连禁止 |
| 任务持久化 | `tasks/task-store.ts` | 版本化 + 归属隔离 + 幂等键 |
| 风险分级 | `policy/risk-classifier.ts` | R0 需系统级只读证据；R3 恒拒绝 |
| 审批票据 | `policy/approval-ticket.ts` | HMAC-SHA256、短 TTL、单次、绑 11 字段 |
| 审批生命周期 | `approvals/approval-store.ts` | 仅本人可决定；读取时投影过期 |
| 执行桥 | `bridge/execution-bridge.ts` | 到达传输前裁决；失败关闭 |
| 产物校验 | `results/artifact-validator.ts` | 魔数 + 容器结构 |
| 送达状态 | `results/delivery-status.ts` | `SENT ≠ DELIVERED` |
| 任务产物目录 | `results/task-artifacts.ts` | 包含性检查 + 文件名净化 |
| 远程授权 | `remote/remote-authorization.ts` | 默认关闭、有 TTL、可撤销 |
| 微信身份绑定 | `remote/identity-binding.ts` | 微信 ↔ 设备 ↔ SID |
| 审批消息 | `remote/approval-message.ts` | 卡片格式化 + 回复解析 |
| 浏览器策略 | `policy/browser-policy.ts` | 域名白名单 + 读写分级 |
| 能力探针 | `model/capability-probe.ts` | 三态结果，`unknown` 不当作可用 |
| 运行时门面 | `runtime.ts` | 唯一裁决入口 |
| 桌面接线 | `ipc.ts`、`broker-client.ts`、`broker-paths.ts`、`broker-proof.ts`、`broker-protocol.ts`、`owner-sid.ts` | IPC + Broker 进程管理 |

## Windows Execution Broker `broker/`（新增独立进程）

| 模块 | 文件 | 作用 |
|---|---|---|
| 进程入口 | `main.ts` | 环境变量引导；stdout 公告端口；stdin 关闭即退出 |
| 环回 IPC | `server.ts` | 仅 127.0.0.1；上限 256 KiB |
| 服务端策略 | `policy.ts` | SID/设备/时效/白名单/票据，逐请求校验 |
| 线协议 | `protocol.ts` | 封闭操作集 |
| UIA 探针 | `uia.ts` + `scripts/*.ps1` | 窗口枚举、控件树、读写、语义激活 |

## 安装器

| 改动 | 文件 |
|---|---|
| Defender 排除项改为显式 opt-in（默认不加） | `deployer/windows_setup.py` |
| 卸载默认保留用户数据与主机安全配置 | `scripts/windows/uninstall-dependencies.ps1` |
| Node 默认目录改为用户可写；修正不实的 per-user 文档 | `deployer/windows_setup.py` |
| NSIS 改为 per-user 安装且禁止提权 | `desktop/electron-builder.yml` |

## 渲染端

| 改动 | 文件 |
|---|---|
| 任务中心状态存储（不在本地推导授权） | `stores/companyclaw.ts` |
| 任务中心视图（远程授权 + 待审批 + 任务控制） | `views/TasksView.vue` |
| `/tasks` 路由 + 侧边栏入口 | `router.ts`、`components/SidePanel.vue` |
| 双语新增 55 个键（zh/en 各 908 键对齐） | `i18n/zh-CN.ts`、`i18n/en-US.ts` |

## 文档

`docs/companyclaw/`：00 基线 / 00 审计 / 00 核对 / 01 范围 / 02 架构 / 03 数据与安全 / 04 模型 / 05 微信 / 06 浏览器 / 07 Windows / 08 编排 / 09 打包 / 10 E2E / 11 运维 / 12 限制 / ADR 0001–0002 / IMPLEMENTATION_STATUS
根目录：`BLOCKERS.md`、`CHANGELOG-COMPANY.md`

---

## 未做的改动（有意）

- 未修改 `appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`
- 未修改 `plugins/openclaw-weixin/src/**` 核心逻辑
- 未修改 `skills/**`
- 未重构 `main.ts` 既有逻辑（仅追加接线）

---

## V2 自包含安装与运行时闭环（2026-10-09，基线 `929a995`）

目标：普通同事只需"安装一个 EXE → 填自己的模型 Key → 微信扫码"，其余依赖全部在构建阶段装配进包内。

### 构建与打包

| 改动 | 文件 |
|---|---|
| 新增统一资源流水线（私有 Node + OpenClaw asar + Windows Node/MXC + Broker + 清单），失败即中止并清理 staging | `desktop/scripts/prepare-production-resources.mjs` |
| `dist` 改走 `release:win`；新增 `prepare-production-resources` 脚本 | `desktop/package.json` |
| `extraResources` 移除死引用 `resources/openclaw/`，新增 `companyclaw-broker/{dist,scripts}` 与 `runtime-manifest.json` | `desktop/electron-builder.yml` |
| 正式入口改为产出 NSIS Per-User 安装包；PyInstaller/旧 NSIS 壳降级为兼容渠道并显式标注 | `build.ps1` |
| 新增 3 项契约测试（清单完整性、流水线产物、extraResources 分类） | `runtime-manifest.test.ts`、`production-resources.test.ts`、`extra-resources-contract.test.ts` |

### 运行时

| 改动 | 文件 |
|---|---|
| 资源完整性契约与失败关闭校验（缺文件/哈希不符/越界路径/重复项） | `companyclaw/runtime-manifest.ts` |
| 首次运行自动生成 `gateway.auth.token`/`mode`/`port` 与 `browser.{enabled,executablePath}`（幂等、不覆盖用户值、MXC 模式跳过） | `companyclaw/first-run-init.ts` |
| 打包版启动时校验资源清单并用中文提示修复方式 | `main.ts` |
| Broker 改用私有 Node 运行时启动（`nodePath`），令牌始终只走环境变量 | `companyclaw/broker-client.ts`、`companyclaw/ipc.ts`、`main.ts` |
| Broker 状态区分"进程存活"与"最近一次真实 UIA 成功" | `companyclaw/broker-client.ts` + IPC/preload/store/UI |

### 首次使用向导

| 改动 | 文件 |
|---|---|
| 保存模型后执行真实能力探针并展示结论（未验证不冒充可用） | `views/SetupWizard.vue` |
| 复用既有微信扫码页作为绑定入口 | `views/SetupWizard.vue` |
| 任务中心展示 Broker 存活/可操作性/失败原因 | `views/TasksView.vue`、`stores/companyclaw.ts` |
| 双语新增键（探针 6 项 + Broker 状态 6 项） | `i18n/zh-CN.ts`、`i18n/en-US.ts` |

### 微信远程闭环

| 改动 | 文件 |
|---|---|
| 插件新增桌面桥（发布可信来源、转发审批回复、超时放行） | `plugins/openclaw-weixin/src/messaging/desktop-bridge.ts` |
| 入站路径**纯追加**分支（+32 行，无删除） | `process-message.ts`、`index.ts` |
| 桌面侧应答处理，裁决仍留在 `applyApprovalReply` 之后 | `main.ts` |
| 决策记录 | `docs/companyclaw/ADR/0003-weixin-plugin-bridge.md` |

### 文档

`docs/superpowers/plans/2026-10-09-companyclaw-v2-selfcontained-installer.md`（实施计划）、
`docs/companyclaw/13-employee-install-guide.md`（员工说明书，零命令行）、
`IMPLEMENTATION_STATUS.md`（V2 里程碑）、`12-known-limitations.md`（V2 增补）、
`00-source-audit.md`（V2 一致性修正）、`BLOCKERS.md`（责任主体分类）。

### 未做的改动（有意）

- 未修改 `appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`、`skills/**`
- 未实现浏览器执行器（保持 `UNVERIFIED`，见 `12-known-limitations.md`）
- 未把 `TaskOrchestrator` 接入生产路径（超出本轮范围）
- 未产出真实安装包（受构建机 .NET SDK 与签名证书影响）
