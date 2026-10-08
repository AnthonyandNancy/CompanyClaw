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
