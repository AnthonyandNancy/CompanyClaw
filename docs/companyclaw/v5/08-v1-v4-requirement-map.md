# 08 — V1/V4 功能映射（F01–F14）

需求基线：V1 原始目标与 V4 的 `F01–F14` **不可删减**；V5 只补缺口、纠正权限体验、收口发行。
本表记录每项在 V5 改动后的落点，用于确认「修 F06 没有破坏其余 11 项」。

| ID | 功能 | V5 前的落点 | V5 改动后的落点 | 状态 |
|---|---|---|---|---|
| F01 | Windows 单机桌面产品与自动运行 | `main.ts` 启停链、`guardian.ts` | 新增 `windows-mcp` / `mcp-tools` / `vision-authorization` 三项健康条目；启停链未改 | 不退化 |
| F02 | 员工 BYO 模型 | `model/capability-probe.ts` | 未改动；新增视觉授权在 provider/baseUrl/model 变更时失效 | 不退化 |
| F03 | 官方微信扫码与身份隔离 | `identity-binding.ts`、`trusted-context.ts` | 未改动；远程判定新增 `origin` 维度，身份来源仍只取本地绑定 | 不退化 |
| F04 | OpenClaw 原生 Agent 智能 | 任务状态机 + Gateway | 新增 `tools/computer-use-tools.ts` 作为可见工具面；未替换 Agent 循环 | 增强 |
| F05 | 自主 Web 浏览器操作 | `browser/browser-adapter.ts` | 未改动；`trustedSites` 与任务级授权为域名策略留出扩展点 | 不退化 |
| **F06** | **自主 Windows UIA/桌面操作** | Broker 8 类 UIA 操作 | **新增**：协议 v2（W01–W18）、Windows-MCP Adapter、执行适配层、票据注入、桌面锁接线 | **补齐** |
| F07 | 一条任务混合 Web/桌面/Office | `task-orchestrator.ts` | 未改语义；现在真正被 `handleAgentToolCall` 使用 | 增强 |
| F08 | 微信 R2 双向远程审批 | `approvals/*`、`approval-message.ts` | 等待窗口 600s 与票据 ≤120s 分离；记录 `resolutionChannel` | 增强 |
| F09 | 任务管理（暂停/恢复/取消/急停） | `task-state.ts` | 未改语义；恢复默认值复用 `pause` 转移 | 不退化 |
| F10 | 文件/Office/报表回传 | `results/*` | 未改动 | 不退化 |
| **F11** | **独立权限边界与安全** | `risk-classifier.ts` 单一远程开关 | **新增**：渠道感知裁决、7 级优先级、R3 双渠道语义、任务级授权、视觉闸门、审计 | **补齐** |
| F12 | 傻瓜式自包含安装升级 | `prepare-production-resources.mjs` | 新增 Windows-MCP payload 装配与 manifest kind；员工端仍零安装 | 增强 |
| **F13** | **中文员工界面与诊断** | `SettingsView.vue` 无权限区块 | **新增**：`PermissionSettings.vue` 一级设置、三项新健康条目、中文故障码 | **补齐** |
| F14 | 一人一机身份/凭据/会话隔离 | `owner-sid.ts`、`identity-binding.ts` | 未改动；任务级授权额外绑定 `ownerSid/deviceId/origin` | 增强 |

## 历史契约

| 契约 | 状态 | 证据 |
|---|---|---|
| V1 `E01–E20` | 未删减 | 既有用例全部保留且通过 |
| V3 `PKG-01–10` | 未删减 | 新增 extraResources 源已纳入分类；`extra-resources-contract.test.ts` 通过 |
| Broker v1 协议（8 操作） | 保持可读 | `broker/protocol.test.ts` 与镜像一致性用例通过 |
| MXC / AppContainer 语义 | 未改动 | `windows-node-mxc*.test.ts` 全部通过 |
