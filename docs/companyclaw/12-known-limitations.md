# 12 — 已知限制

本文件如实记录**未实现、未验证、以及无法通过代码解决**的限制。任何一项都不得被当作已完成。

## A. 需要外部资源才能验证（BLOCKED）

| 项 | 阻塞 |
|---|---|
| 微信扫码、消息收发、审批卡片实际送达 | 无微信测试账号 |
| 内网业务系统上的查询与写入 | 无内网测试系统与脱敏数据 |
| 安装 / 升级 / 卸载实机验证 | 无目标机（本机为非管理员会话） |
| 公司 Fork 与推送 | 无 GitHub 登录权限 |
| 代码签名 | 无证书 |

## B. 未实现的功能

| 项 | 现状 |
|---|---|
| **浏览器实际驱动** | 策略层完备（域名白名单、读写分级、能力开关），但无受控的 OpenClaw Browser 调用器 |
| **微信插件审批接入** | 桌面侧格式化/解析/越权防护已完备；插件侧拦截分支未接（见 ADR 0002） |
| **`session-source` 生产者** | 全库缺失。`main.ts` 有消费者但无人发送，`cachedRemoteSource` 恒为 `undefined`，`notifyRemotePermissionNeeded()` 是死代码 |
| **任务自动执行编排** | 状态机、执行桥、Broker 单次操作均可用且已测；但没有"收到任务 → 自动推进 → 调用 Broker → 回读 → 完成"的调度器 |
| **应用白名单配置** | BrokerClient 以空白名单创建（失败关闭默认），但无 UI/IPC 配置入口 → 当前所有进程操作都会被拒绝 |
| **`describe-element` / `wait-for-window`** | 未实现（返回 `not-implemented`，不伪造成功） |
| **`vision` / `reasoning` / `structuredOutput` 探针** | 恒为 `unknown`（有意不猜） |
| **计划与任务关联** | 计划进度仍从模型文本解析，未与任务实体关联 |
| **步骤级证据** | `evidenceRefs` 字段存在但未写入 |

## C. 无法通过代码解决

| 限制 | 原因 |
|---|---|
| **微信无送达回执** | 插件 `send.ts` 返回本地 `clientId`，非服务端回执。`DELIVERED` 无法自动达成；默认只能标到 `SENT`，无证据时为 `UNKNOWN` |
| **Node.js MSI 不支持 per-user** | 上游记录 `MSIINSTALLPERUSER=1` 以 1603 失败。已改为"优先复用用户目录运行时 + 明示"，但机器级安装仍需管理员 |
| **通用桌面交互无法可靠识别业务写入** | 这是需求明示的前提。因此：无法证明无副作用的操作不得归类为 R0；不能拦截最终写入的路径默认拒绝远程自动写入 |

## D. 未验证的安全相关行为

| 项 | 说明 |
|---|---|
| 锁屏 / UAC 安全桌面 / 无交互会话下的 UIA 行为 | 设计为安全失败，未实测 |
| 多显示器 / DPI 100-125-150% | 未测 |
| Windows 多桌面 | 未测 |
| AppContainer 与 Broker 组合 | 未测（架构上 Broker 经非沙箱侧调用） |
| MXC 模式回归 | 无法构建（缺 .NET SDK 与子模块） |
| 升级回滚与数据保全 | 未验证 |

## E. 上游既有问题（非本项目引入，已核实）

| 项 | 证据 |
|---|---|
| `eslint .` 报 2 个 error：`chat-attachments.ts:105`（`no-control-regex`）、`openclaw-upgrade-recovery.ts:235`（未使用变量） | 这两文件与上游 `main` 完全一致（`git diff` 为空） |
| Python 测试 2 个 error：`rmtree(onexc=...)` | 需 Python ≥3.12；本机为 3.11.9，CI/release 使用 3.12。对应文件未改动 |
| 仓库无 browser 技能 | `skills/` 仅 7 个目录，与 README 描述不符 |
| `startup-order.test.ts` 断言过期 | 上游 PR #192 重命名后未更新；已修复（`f497085`） |

## F. 文档

`docs/companyclaw/` 下架构、数据安全、模型、微信、浏览器、Windows、编排、打包、E2E、运维、限制等文档已补齐。**员工操作手册与开发手册**尚未单独成文。
