# 02 — ADR：权限档位、渠道分化与两段式审批

- 状态：已接受（2026-10-10）；**§7 为同日产品负责人裁决，覆盖本 ADR 第 1、2 节的部分原文**
- 关联需求：V5 §4；Q1、Q3、Q5、Q6、Q-A、Q-B、Q-C、Q-D、Q-E

## 决策

### 1. 三档预设是一个「配置意图」，不是授权本体

`BASIC` / `FULL_DAILY` / `CUSTOM` 只决定**默认裁决输入**，本身不产生任何具体授权。
真实生效的授权在 `permissions.json` 的 `trustedApps` / `trustedSites` / `workFolders` / `taskGrants` / `remote` / `vision`。

**禁止**将 `FULL_DAILY` 实现为 `sandbox=false`、`policy.allowAll=true`、`shell.*=allow` 或 `R2|R3 自动批准`。

> 该禁令已被 §7 的裁决部分覆盖：`FULL_DAILY` 现在**就是**「完全权限」，`R2/R3 自动批准` 正是它的定义。
> `sandbox=false`、`policy.allowAll=true`、`shell.*=allow` 三项**仍然禁止**——沙箱与不可绕过的系统限制不受档位影响。

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

---

### 7. 产品负责人裁决（2026-10-10）：三档语义与「完全权限」

本节由产品负责人显式裁决，**覆盖**需求书 `CompanyClaw__修改实施书5.0.md` 的 §225、§512、§741，以及本 ADR 第 1 节关于 `R2|R3 自动批准` 的禁令、第 5 节「开启 `FULL_DAILY` 不联动」。

#### 7.1 三档语义与持久化 id 的映射

| 持久化 id | 界面显示名 | 语义 |
|---|---|---|
| `BASIC` | 仅查看 | 已授权范围内查询、查看、受控浏览器阅读与只读任务；新应用操作、文件修改、业务写入需确认 |
| `CUSTOM` | 需审核 | 逐项管理应用、网站、文件目录与特殊业务权限；超出自定义范围或高风险时仍需确认 |
| `FULL_DAILY` | **完全权限** | **所有操作一律放行，不需要人为确认，不存在不放行的情况** |

`FULL_DAILY` 承载最宽档位而非新建 id，因为该标识在本 ADR 中的既有含义本就是「最宽的选择」，既有安装的配置语义因此不变。

#### 7.2 裁决要点

1. **`FULL_DAILY` 是最优先级放行**：`decideAction()` 中该分支先于永禁类别、remote R3、remote 授权状态、`commitInterceptable`、本地可确认性检查。
2. **裁决 ③**：`FULL_DAILY` 下即使 `remoteAuthorization` 未开启也放行。落点在同一分支，因此不依赖渠道来源识别。
3. **首次启用弹一次确认**，此后切换不再弹。
4. **视觉开关独立于档位**：两个开关任一开启即放行（裁决 a-2）；`FULL_DAILY` 下同时短路 `remote-authorization-missing`。
5. 审计日志保留 `level`（后果分类）与 `decision`（是否放行）两列，二者可以并存，以便事后追溯。

#### 7.3 结构性限制（档位无法覆盖，非策略性拒绝）

以下四项是物理或架构事实，**不是**可放行的判定点：

1. **Windows UAC 安全桌面不可交互** —— 操作系统限制；
2. **AppContainer 沙箱边界** —— 进程隔离，不在策略层；
3. **broker 票据完整性校验** —— 防伪造凭证而非用户确认，放行等于取消整条链路的防篡改；
4. **`enterpriseRestrictions.stricterRules`** —— 企业策略字段，当前为空。

#### 7.4 遗留风险

需求书 §225「不得用『无条件完全控制整台电脑』的承诺误导」与本次档位命名存在措辞冲突。裁决采用「完全权限」作为显示名；界面仍需说明「与 Windows 管理员权限无关、不会关闭系统安全机制」，弹出确认中已包含该说明。

---

### 8. 产品负责人裁决（2026-10-10 追加）：完全权限覆盖 broker 白名单与浏览器 SSRF

本节记录 V5.2 修复轮的扩展裁决。现场反馈两条：QQ 操作被 `process-not-allowed` 拒绝；浏览器「browser navigation blocked by policy」。

#### 8.1 完全权限放开 broker 的进程与窗口标题白名单

**背景**

broker 的 `authorize()` 有两道**配置类**闸门：`allowedProcesses` 与 `allowedWindowTitles`。前者来自 `broker-targets.json`，实测该文件不存在、`trustedApps` 为空数组，因此**空集即全拒**。而 `setPreset()` 此前与 broker 白名单**零联动**——策略层已按完全权限放行，broker 仍按空白名单拒绝。

这是 V5.1 修好工具参数透传后**暴露**的既有缺陷：参数打通后，QQ 操作首次携带 `processName`，broker 白名单才第一次被触发。

**裁决**

完全权限档位下，`allowedProcesses` 与 `allowedWindowTitles` 不再构成拒绝理由。实现为显式的 `unrestricted` 字段（而非空数组承担两种相反语义）：

| 位置 | 取值来源 |
|---|---|
| `broker/policy.ts` | `BrokerPolicyConfig.unrestricted` 为真时跳过两处判定 |
| `broker/main.ts` | 读 env `COMPANYCLAW_BROKER_UNRESTRICTED === "true"` |
| `broker-targets.json` | `unrestricted` 字段（旧文档读作 `false`） |
| `runtime.setPreset()` | **档位是权威**，写权限后投影到该字段 |
| `runtime.reconcileBrokerTargets()` | 启动时以档位为准纠正不一致（手改文件或旧数据） |

**保留的四类校验**（`unrestricted` 不影响，因为它们不是"偏好"）：

1. `owner-mismatch` / `device-mismatch` —— 身份
2. `expired` / `not-yet-valid` —— 时效
3. `target-required` —— 元素操作仍需目标
4. `approval-required` / `invalid-approval-ticket` —— mutating 票据（防伪造，非确认）

**已知代价**：完全权限下模型可驱动任意进程（含任务管理器、注册表编辑器、安全软件界面），broker 不再有进程级兜底。

#### 8.2 浏览器 SSRF 策略按 fake-IP 代理环境配置

**背景（实测修正了初始判断）**

现场是「打不开 `https://www.sheapi.top`」。实测本机 7 个公网域名：

```
www.sheapi.top → 198.18.0.78     www.baidu.com  → 198.18.0.90
github.com     → 198.18.0.45     example.com    → 198.18.0.94
```

**全部落在 `198.18.0.0/15`（RFC 2544）**——Clash/Mihomo 在 TUN 模式下 fake-IP 的固有行为。因此不是该站点特殊，而是**任何网站**都被 OpenClaw 的 SSRF 防护拦为保留段。

`dist/schema-C9vBoeg0.mjs` 明确 `browser.ssrfPolicy.allowRfc2544BenchmarkRange` 的用途是 *"for trusted fake-IP proxy environments"* —— 即官方为该环境提供的正规配置项。

**裁决**

在 `browser.ssrfPolicy` 写入两个键（`planBrowserConfig()`，仅缺失时补齐、不覆盖用户显式值）：

```jsonc
"browser": {
  "ssrfPolicy": {
    "dangerouslyAllowPrivateNetwork": true,  // 覆盖其余 8 类保留段，并让解析链路整体跳过
    "allowRfc2544BenchmarkRange": true       // 覆盖 198.18.0.0/15（独立判定，不在上述集合内）
  }
}
```

两者缺一不可：`allowRfc2544BenchmarkRange` 只豁免 RFC 2544 一段；`dangerouslyAllowPrivateNetwork` 才让 `shouldSkipPrivateNetworkChecks` 为真、两个地址断言分支都不执行。

**已排除的陷阱**：`chrome-CGpnReO4.mjs:250` 有一条反向判定——`dangerouslyAllowPrivateNetwork === false` 且非 IP 字面量时会以"需要 IP 字面量"拒绝。实测本方案解析结果为 `{"dangerouslyAllowPrivateNetwork":true, "allowRfc2544BenchmarkRange":true}`，不触发该分支。

**保留的结构性限制**：非 http/https 协议、带凭据的 URL 仍被拒（与 SSRF 无关的独立判定）。

**已知代价（产品负责人明确接受）**：浏览器此后可访问 `127.0.0.1` 上的任意本地服务（含 CompanyClaw 自己的 MCP 端点与 Gateway）、企业内网、路由器管理页。页面内容或模型被诱导时可形成 SSRF。

#### 8.3 需求书覆盖范围（进一步扩大）

| 位置 | 原文要点 | 本次 |
|---|---|---|
| §225 | "不得用『无条件完全控制整台电脑』的承诺误导" | 覆盖范围扩大至 broker 白名单与浏览器 SSRF |
| §512 | 列有"不得被永久预批准"的动作清单 | 覆盖 |
| §741 | "R3、UAC 绕过或敏感写入永久自动允许"列为禁止项 | 覆盖 |

本 ADR 不改需求文档，仅作显式记录，便于后续审查追溯。
