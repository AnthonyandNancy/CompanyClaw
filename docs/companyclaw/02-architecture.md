# 02 — 架构

- 上游基线：`6f080a07f43bd65b8b27ec6f859438fc038bb912`
- 架构决策：**方案 B —— 独立受限 Windows Execution Broker**（见《源码调查结论与实施架构方案 V1.0》）

## 目标架构

```text
员工微信
   │
   ▼
腾讯微信插件（vendored 2.4.6，最小改动）
   │
   ▼
MicroClaw / OpenClaw Gateway（loopback 18789 + Ed25519 设备鉴权）
   │
   ▼
Agent（原生智能：自主规划、工具选择、错误恢复）
   │
   ▼
CompanyClawRuntime（唯一裁决入口）
   ├── IdentityBindingStore    微信身份 → 设备 → Windows SID
   ├── RemoteAuthorization     远程操作开关 / 有效期 / 撤销
   ├── TaskStore               任务状态机 + 持久化 + 幂等
   ├── ApprovalStore           审批生命周期（单次、防重放）
   ├── RiskClassifier          R0–R3 分级
   ├── ApprovalTicket          一次性 HMAC 票据
   ├── BrowserPolicy           域名白名单 + 读写分级
   └── ExecutionBridge         失败关闭执行闸门
   │
   ▼
BrokerClient（进程拉起 + 环回 IPC）
   │
   ▼
Windows Execution Broker（独立进程，普通用户交互会话）
   ├── BrokerPolicy            服务端强制：SID / 设备 / 时效 / 应用白名单 / 票据
   ├── list-windows / find-elements / read-value   （只读）
   ├── set-value / invoke-pattern / send-keys      （写入，需票据）
   └── scripts/*.ps1           UI Automation 探针
   │
   ▼
公司 Windows 电脑
   │
   ▼
结果回传（产物目录 + 校验 + 送达状态）
```

## 信任边界

| 组件 | 信任级别 | 职责 | 明确不做 |
|---|---|---|---|
| 微信插件 | 低 | 消息收发、扫码、媒体 | 不做安全判定、不读票据、不执行动作 |
| Gateway / Agent | 中 | 理解、规划、自主选择工具 | 不承担安全裁决 |
| CompanyClawRuntime | **高** | R0–R3 裁决、票据签发、任务状态、身份绑定 | 不执行 UI 动作 |
| ExecutionBridge | 中 | 透传已裁决动作、失败关闭 | 不判定 |
| Broker | 中（执行侧强制） | 服务端二次校验 + UIA 执行 | 不以管理员运行；不提供任意命令 |
| AppContainer | 高（OS 级） | `exec()` 子进程 ACL 强制 | 未被本方案修改 |
| MXC 模式 | 高 | 独立实验路径 | 未被本方案修改 |

## 关键安全属性

1. **唯一裁决点**：所有 R0–R3 判定集中在 `RiskClassifier` + `ExecutionBridge`；微信插件、Browser、Broker 均不自行放宽。
2. **双层强制**：桌面侧签发票据，Broker 侧**独立**校验（`BrokerPolicy`），任一侧失效即拒绝。
3. **失败关闭**：存储不可读/格式非法 → 什么都不授权；传输失败 → `unavailable`（不是策略决定）；写后回读不一致 → `failed`。
4. **身份三重绑定**：微信 userId ↔ 设备 ↔ Windows SID；绑定只解决"是谁"，不授予"能做什么"。
5. **R3 无开关**：删除/付款/发布/系统配置/注册表/任意命令/未知程序/绕过策略 → 恒拒绝。

## 与上游的边界

**保留不动**
- `appcontainer/**`（沙箱与敏感路径屏蔽）
- `windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`（MXC 与 ingress 隔离）
- `plugins/openclaw-weixin/src/**` 核心逻辑
- `skills/**`

**新增**
- `desktop/src/companyclaw/**`
- `broker/**`

**最小修改**
- `desktop/src/main.ts`：仅新增接线（未改动既有逻辑）
- `desktop/src/preload.ts`：新增 `companyClaw` 命名空间
- `desktop/electron-builder.yml`：产品标识 + 安装范围
- `deployer/windows_setup.py`：Defender 排除项默认关闭 + Node 目录 Per-User
- `scripts/windows/uninstall-dependencies.ps1`：用户数据默认保留

## 未落地部分（如实记录）

- Browser **实际驱动**未实现：策略层（域名白名单、读写分级）已实现并测试，但尚无 OpenClaw Browser 的受控调用器。
- 微信插件的审批文本通道未接入（桌面侧逻辑已完整，见 ARD 0002）。
- `session-source` 生产者仍未打通（全库缺失）。
