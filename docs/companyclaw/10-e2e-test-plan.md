# 10 — E2E 测试计划与验收矩阵

## 等级定义

| 等级 | 含义 |
|---|---|
| PASS | 有真实运行证据、断言和目标环境信息 |
| FAIL | 执行后不符合，记录复现与根因 |
| BLOCKED | 受外部权限、测试账号、物理机阻塞，写清所需条件 |
| UNVERIFIED | 仅有代码或 Mock，无真实系统证据。**不计作 PASS** |

## E01–E20 矩阵

| ID | 用例 | 当前状态 | 说明 |
|---|---|---|---|
| E01 | 新设备首次安装 | **BLOCKED** | 无目标机（B7）；安装器已改但未实测 |
| E02 | DeepSeek 配置与 Tool Calls | **BLOCKED** | 需可用 API Key 与网络 |
| E03 | 微信扫码/解绑 | **BLOCKED** | 需微信测试账号（B1） |
| E04 | 微信 A/电脑 A 与 B/电脑 B 隔离 | **BLOCKED** | 同上 |
| E05 | Web 多级菜单搜索 | **BLOCKED** | 需内网系统（B2） |
| E06 | Web 修改字段 + 回读验证 | **BLOCKED** | 同上 |
| E07 | 复杂 Web 控件 | **BLOCKED** | 同上 |
| E08 | Windows 客户端查询 | **PARTIAL PASS** | Broker 已实机读取真实窗口与控件树；针对业务客户端的查询未验证 |
| E09 | Windows 客户端修改 + 审批 | **PARTIAL PASS** | Broker 已实机写入记事本并回读；审批回读闭环在逻辑层已验证，端到端未验证 |
| E10 | Browser → 桌面 → Excel | **BLOCKED** | 依赖 Browser 驱动（未实现）与内网系统 |
| E11 | 微信文件回传 | **BLOCKED** | 需微信账号；且平台无送达回执 |
| E12 | 电脑锁屏/睡眠/离线 | **UNVERIFIED** | 设计为安全失败，未实测 |
| E13 | MFA 过期 / SSO 失效 | **BLOCKED** | 需内网系统 |
| E14 | 微信断线/消息重发 | **BLOCKED** | 需微信账号 |
| E15 | 模型失败/超时/429 | **PARTIAL PASS** | 能力探针已覆盖 401/402/403/429/5xx/网络的错误映射；真实端点未验证 |
| E16 | 提示词注入/越权 | **PARTIAL PASS** | 逻辑层已验证"用户文本不能自证来源"、"回复不可越权"、"R3 恒拒绝"；端到端未验证 |
| E17 | 沙盒与执行桥接 | **PARTIAL PASS** | Broker 环回限定、令牌鉴权、空白名单拒绝一切 已实测；AppContainer 组合未验证 |
| E18 | 中文 Windows + DPI/多屏 | **PARTIAL PASS** | 中文 Windows 11 上 UIA 实测可用；DPI/多屏未验证 |
| E19 | 安装/升级/卸载 | **BLOCKED** | 需目标机 |
| E20 | 中断恢复 | **UNVERIFIED** | 持久化已实现（任务重启后可读），复核后继续未实现 |

## 裁决新增专项（S1–S9）

| ID | 专项 | 状态 |
|---|---|---|
| S1 | 微信与 Windows UIA 同时工作 | **BLOCKED**（需微信账号） |
| S2 | Browser 与 Windows UIA 混合执行 | **BLOCKED**（Browser 驱动未实现） |
| S3 | Broker 在 AppContainer 环境下正确连接 | **UNVERIFIED**（需真机） |
| S4 | 员工普通账号安装及运行 | **BLOCKED**（需目标机） |
| S5 | 未授权调用被 Broker 拒绝 | **PASS**（实机：错误令牌被拒、SID 不匹配被拒、空白名单拒绝一切） |
| S6 | R2 审批无法被重放或绕过 | **PARTIAL PASS**（逻辑层：单次消费、防篡改、防跨绑定、恢复不复用；端到端未验证） |
| S7 | 微信插件及 Gateway 重启后状态恢复 | **BLOCKED** |
| S8 | Windows 锁屏、会话不可交互时安全失败 | **UNVERIFIED** |
| S9 | 原版 AppContainer 与 MXC 模式回归通过 | **UNVERIFIED**（需 .NET SDK 与子模块） |

## 本机已获得的真实证据

| 证据 | 命令 |
|---|---|
| 桌面全量 | `cd desktop && npx vitest run` |
| Broker 全量（含实机） | `cd broker && npx vitest run` |
| Broker 实机专项 | `cd broker && npx vitest run uia.live.test.ts uia-binding.live.test.ts uia-write.live.test.ts server.live.test.ts main.live.test.ts` |
| 渲染端 | `cd desktop/renderer && npx vitest run` |
| Python | `python -m unittest discover -s tests` |

## 执行约定

- 实机测试在非 Windows 主机上自动 skip（`describe.skipIf(process.platform !== "win32")`）
- Broker 实机测试**串行执行**（`fileParallelism: false`）：并发运行多个 PowerShell UIA 探测会争抢桌面并产生与代码无关的抖动
- 实机写入测试自建记事本进程并在结束后终止，不改变用户桌面状态
- 缺少真实账号/系统时只记 `BLOCKED`，**不得以逻辑层测试代替**
