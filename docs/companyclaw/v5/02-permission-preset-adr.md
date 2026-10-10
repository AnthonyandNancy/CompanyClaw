# 02 — ADR：权限档位、渠道分化与两段式审批

- 状态：已接受（2026-10-10）
- 关联需求：V5 §4；Q1、Q3、Q5、Q6、Q-A、Q-B、Q-C、Q-D、Q-E

## 决策

### 1. 三档预设是一个「配置意图」，不是授权本体

`BASIC` / `FULL_DAILY` / `CUSTOM` 只决定**默认裁决输入**，本身不产生任何具体授权。
真实生效的授权在 `permissions.json` 的 `trustedApps` / `trustedSites` / `workFolders` / `taskGrants` / `remote` / `vision`。

**禁止**将 `FULL_DAILY` 实现为 `sandbox=false`、`policy.allowAll=true`、`shell.*=allow` 或 `R2|R3 自动批准`。

### 2. 渠道分化：本地与微信远程独立判定

同一动作在 `origin=local-ui` 与 `origin=weixin-private` 下可以得出不同结论。
**R3 在微信远程恒拒绝**；本地对「可恢复性明确的高风险文件操作」可经本机逐项确认执行，
但 `payment`/`bypass-security`/`system-config`/`arbitrary-command` 在任何渠道均拒绝。

理由：需求明确「不能因为远程禁止 R3 就让本地正常文件管理能力整体失效」，
同时明确「不允许借本地模式绕过 Windows UAC、企业安全策略或系统权限」。

### 3. 七级优先级链

系统/企业限制 → CompanyClaw 不可绕过规则 → 更严格企业管控 → 员工档位 → 任务授权 → 一次性审批 → Agent 请求。
**低优先级不得覆盖高优先级的拒绝决定。**

### 4. 两段式审批时效（分离）

| 阶段 | 时长 | 说明 |
|---|---|---|
| 微信审批等待窗口 | **600s** | 人不在电脑旁也来得及回复 |
| 执行票据 TTL | **≤120s** | 单次消费 + nonce；超时需重新确认 |
| 本机审批弹窗 | 沿用现有生效配置（60s 倒计时，超时默认拒绝） | Q-E 要求不改动 |

**不得**通过延长票据有效期来解决微信等待问题。

### 5. 云端视觉独立授权

绑定 user + device + provider + baseUrl + model + origin + captureScope + expiresAt。
默认关闭；本地与远程分别开关；**开启 `FULL_DAILY` 不联动**。
有效期默认 7 天；远程视觉授权不得超过远程操作授权剩余期限。

### 6. 一键恢复安全默认值

对本地与远程同时生效；落盘先行；作废全部未消费票据与任务级授权；暂停全部活跃任务至 `PAUSE_REQUESTED`；
确认前展示影响清单；**重启后旧授权不得复活**。

## 后果

- `permissions.json` 成为唯一权限事实来源，`policyVersion` 单调递增，UI/Gateway/执行器共读同一版本号。
- 既有 `broker-targets.json` 迁移为 `trustedApps` 的子集，旧条目 `scope="local"` 且 `legacy=true`，**不扩大、不升档**。
