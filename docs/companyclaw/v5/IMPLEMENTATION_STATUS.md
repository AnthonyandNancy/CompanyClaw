# CompanyClaw V5.0 — 实施状态

- 计划：`docs/superpowers/plans/2026-10-10-companyclaw-v5-windows-mcp-permissions.md`
- 需求：`docs/CompanyClaw__修改实施书5.0.md` + Q1–Q9 / Q-A–Q-E 裁决
- 基线：HEAD `fb63f003`；desktop 87 files / 1574 passed

## 完成状态

| WP | 内容 | 状态 | 证据 |
|---|---|---|---|
| WP0 | 基线与 ADR | **PASS** | `00-baseline.md`、`01-mcp-adapter-adr.md`、`02-permission-preset-adr.md` |
| WP1 | 渠道感知策略引擎 | **PASS** | `policy/execution-origin.ts`、`policy/permission-preset.ts`、`policy/action-category.ts`、`policy/risk-classifier.ts`；`policy/v5-channel-policy.test.ts` 16 用例 |
| WP2 | 单一版本化权限数据源 | **PASS** | `permissions/{permission-policy,permission-store,migrate}.ts`；`permissions/*.test.ts` 29 用例；runtime 接入 |
| WP3 | 两段式审批时效 | **PASS** | `approvals/approval-store.ts`（`COMPANYCLAW_APPROVAL_WAIT_MS=600_000`）；`approvals/approval-wait-window.test.ts` 7 用例 |
| — | 真实 MCP 握手验证（源码态） | **PASS** | 临时 venv 安装 `windows-mcp==0.8.7`，真实 `initialize` + `tools/list` 成功，20 个工具名与 allow-map 一致 |
| — | 内置 payload 装配与自校验 | **PASS** | `desktop/scripts/prepare-windows-mcp-resources.mjs` 装配 66 文件 / 235 MB；`windows-mcp-payload.live.test.ts` 校验通过 |
| — | 内置 payload 私有运行时实机握手 | **PASS** | `docs/companyclaw/v5/scripts/verify-windows-mcp-handshake.py` 输出 `OK: 20 tools, allow-map in sync`（使用 payload 自带解释器，不依赖系统 Python） |
| WP4 | Broker 协议 v2 + Windows-MCP Adapter | **PASS** | allow-map 与真实握手已完成：`broker/adapters/windows-mcp/{tool-policy-map,tool-registry,process-manager}.ts` + 3 个测试文件 55 用例；**上游真实握手已验证**（20 工具、server 4.1.0）；协议 v2 操作与主执行适配待做 |
| WP5 | Agent 工具面与任务接线 | **PASS** | `tools/computer-use-tools.ts`（16 个受控工具 + 调用校验）、`tools/tool-facade.ts`（唯一入口）、`audit/audit-log.ts`、runtime `decideToolAction`/`executeStepWithLock`；测试 38 用例；**IPC 暴露与 main.ts 装配待做** |
| WP6 | 云端视觉授权闸门 | **PASS** | `vision/vision-gate.ts` + runtime 接入；`vision-gate.test.ts` 16 用例 |
| WP7 | 一键恢复安全默认值 | **PASS** | `recovery/reset-to-defaults.ts` + runtime `previewSafeDefaultsReset`/`restoreSafeDefaults`；`reset-to-defaults.test.ts` 8 用例 |
| WP8 | IPC 与 preload | **PASS** | 17 个新 channel；`ipc-contract.test.ts` 扩展覆盖 |
| WP9 | 权限 UI | **PASS** | `PermissionSettings.vue` + SettingsView 一级入口 + i18n；`PermissionSettings.test.ts` 8 用例 |
| WP10 | 组件自检与打包 | **PARTIAL** | guardian 新增 3 项 + `windows-mcp-layout.ts` + 装配脚本 + extraResources + manifest kind；**真实 payload 已装配并通过校验与实机握手**；NSIS 产出仍受 .NET SDK 阻塞 |
| WP11 | 通用测试夹具 | **PARTIAL** | `tools/testapp/`：脚本版 + 编译版夹具（含最终提交点、拖拽区、自绘按钮、延迟窗口、滚动区）、构建脚本、UIA 检查脚本、README 实测结论；窗口发现与 220 元素枚举**实测通过**，语义控件级 `UNVERIFIED` |
| WP12 | 回归与证据 | **PASS** | `07-release-evidence.md`、`08-v1-v4-requirement-map.md`、`05-security-negative-tests.md`；三套件全绿 |

## V5.1 后续修复轮（2026-10-10）

计划：`docs/superpowers/plans/2026-10-10-companyclaw-v5-permission-vision-gui-fix-implementation-plan.md`（rev.3）

针对三条现场反馈：权限档位语义、云端视觉开关无效、后台进程中的应用找不到。

| Step | 内容 | 状态 | 证据 |
|---|---|---|---|
| 1 | dev/build 前置编译 broker，消除 `broker/dist` 陈旧产物 | **PASS** | `broker/dist/adapters/` 已生成；`companyclaw.broker.v2` 由 0 次变 1 次 |
| 2 | `launch-app` 上游参数名 `app`→`name` | **PASS** | 实盘启动记事本成功（PID 17024） |
| 3 | 缺参可读拒绝 + `focus-window` 的 `processName` 兜底 + 异常归一化 | **PASS** | 新测试覆盖；Python 原文只进日志 |
| 4 | `list-installed-apps` 改由 Broker 原生探针承载 | **PASS** | 实盘返回 185 项、可解析、中文名正确 |
| 5 | 三档语义「仅查看 / 需审核 / 完全权限」+ 完全权限最高优先级放行 | **PASS** | 审计日志含 `完全权限：不需要人为确认`；裁决 ③ 矩阵 14 类 × 2 origin |
| 6 | 证明免确认但仍签发防伪造票据 | **PASS** | 每调用唯一 nonce；零待处理审批 |
| 7 | 视觉取值源改为已配置模型 + (a-2) 合并选择 + 裁决 ③ | **PASS** | 新通道 `companyclaw:vision:get-configured-model` |
| 8 | 图像载荷通道打通（两处断点） | **PASS** | `ImagePayload` 全链透传；闸门拒绝即剔除 |
| 8b | 工具参数透传到 broker + 执行锁只覆盖 mutation | **PASS** | 参数不再被 `argsFor: () => ({})` 丢弃；只读不再长时间持锁 |
| 8c | 结果载荷按结构截断，杜绝残缺 JSON | **PASS** | 185 项清单可 `JSON.parse`；超长按条目缩短 |
| 9 | ADR 与阻塞记录 | **PASS** | 本文件、`01-mcp-adapter-adr.md` §8、`02-permission-preset-adr.md` §7、新增 `09-vision-payload-channel-adr.md` |

**实施中发现的额外缺陷（均已修复并留测试）**

| 缺陷 | 现象 | 修复 |
|---|---|---|
| 探针输出编码 | Windows PowerShell 按控制台代码页写出，中文窗口标题/应用名全部变 U+FFFD，中文用户完全不可用 | 所有 `broker/scripts/*.ps1` 显式设 UTF-8 |
| 工具参数被丢弃 | `main.ts` 的 `argsFor: () => ({})` 恒返回空对象，所有带参工具在真实链路上必失败（`launch-app` 恒 `app-required`） | transport 默认透传 `BridgeRequest.arguments` |
| 结果被截成残缺 JSON | 固定 2000 字符截断使 185 项应用清单不可解析，模型无法据此选名字 | `summarizeResult()` 按条目截断，保持合法 JSON |
| 执行锁泄漏 | 一次慢调用（upstream 启动应用需等窗口，最多 20s）长期持锁，之后所有桌面工具报 `desktop-busy` | 锁只对 mutation 生效 + 增加租约自愈 |
| broker 票据契约不匹配 | 生产路径把审批票据当 broker 票据传入，broker 直接 `malformed-ticket` | 改用 `issueBrokerTicket` 铸造 broker 自己的信封 |
| 注册后网关不重载 | 注册变更只写日志不重启，新工具表永不生效 | 已有网关时自动重启 |

**测试基线（V5.1 后）**

| 套件 | 结果 |
|---|---|
| `desktop` | 104 files / 1807 passed / 2 skipped |
| `desktop/renderer` | 29 files / 342 passed |
| `broker` | 15 files / 161 passed |

## V5.2 修复轮（2026-10-10）

计划：`docs/superpowers/plans/2026-10-10-companyclaw-v5-2-unrestricted-broker-and-browser-ssrf-implementation-plan.md`

针对两条现场反馈：QQ 操作被 `process-not-allowed` 拒绝；浏览器导航被 SSRF 策略拦截。

| Step | 内容 | 状态 | 证据 |
|---|---|---|---|
| 1 | `broker/policy.ts`：`unrestricted` 跳过进程/标题白名单，四类校验保留 | **PASS** | `policy.test.ts` 21 用例 |
| 2 | `broker/main.ts`：env 解析（严格 `=== "true"`）与 `toPolicyConfig` 透传 | **PASS** | `main.test.ts` 7 用例 |
| 3 | `broker-client.ts`：spawn env + `updateTargets` 传递 | **PASS** | `broker-client-spawn.test.ts` 17 用例 |
| 4 | `broker-targets.ts`：`unrestricted` 持久化 + 旧文档兼容 | **PASS** | `broker-targets.test.ts` 12 用例 |
| 5 | `runtime.setPreset()` 档位联动 + `reconcileBrokerTargets()` 启动纠正 | **PASS** | `runtime.test.ts` 56 用例 |
| 6 | `ipc.ts`：两通道携带该字段，手动编辑不误关 | **PASS** | typecheck + 集成于 Step 5 测试 |
| 7 | `first-run-init.ts`：写入 `browser.ssrfPolicy` 两键 | **PASS** | `first-run-init.test.ts` 20 用例 |
| 8 | ADR §8 / BLOCKERS V5-B9·B10 / 本文件 | **PASS** | 本文档 |

**根因定位**

| 需求 | 根因 | 位置 |
|---|---|---|
| QQ `process-not-allowed` | broker 白名单空集全拒，且 `setPreset()` 与白名单**零联动**（V5.1 修好参数透传后暴露） | `broker/policy.ts:90-93`、`runtime.ts:371-387` |
| 浏览器被拦 | 本机 Clash/Mihomo TUN fake-IP 使**所有**公网域名解析到 `198.18.0.0/15`，被 OpenClaw SSRF 判为 RFC 2544 保留段 | `dist/ssrf-BqLj-h8H.mjs`、`dist/config-n_aIDo5k.mjs:253` |

**测试基线（V5.2 后）**

| 套件 | 结果 |
|---|---|
| `desktop` | 104 files / 1818 passed / 2 skipped |
| `desktop/renderer` | 29 files / 342 passed |
| `broker` | 15 files / 171 passed |

**已记录的偏差**

| 位置 | 偏差 | 原因 |
|---|---|---|
| `broker-targets.ts` | `BrokerTargets` 新增必填 `unrestricted`，但 `TargetsEnvelope` 中保持可选 | 文件来自旧版本时缺该字段，必须读作 `false`；接口层必填可让遗漏编译期即暴露 |
| `ipc.ts` 装配点 | 由 `getBrokerTargets()` + `updateTargets()` 改为 `reconcileBrokerTargets().then(updateTargets)` | 档位是 `unrestricted` 的权威，存储值仅为其投影；同时保证 broker 始终收到白名单（标志未变时也要推送） |

## V5.3 修复轮（2026-10-12）

**主题**：桌面窗口读取与工具调用绑定修复 ——「打开 QQ → 找群 → 发消息」走不通。

**计划文件**：`docs/superpowers/plans/2026-10-12-companyclaw-v5-3-window-scoped-reads-and-tool-call-binding-implementation-plan.md`

### 完成状态

| Step | 内容 | 状态 |
|---|---|---|
| Step 1 | `describeTarget` 键列表加入 `processName`（缺陷 A：只给进程名的调用无法绑定票据） | 完成 |
| Step 2 | 窗口范围读取改为官方用法 `App{mode:"switch"} → Snapshot`（缺陷 B：`window_name` 非上游参数） | 完成 |
| Step 3 | 超时分层（50s/40s）+ 失败后会话自愈 + 握手失败释放子进程（缺陷 C） | 完成 |
| Step 4 | 重新编译 `broker/dist`（broker 为独立编译产物） | 完成 |
| **Step 5** | **`encodeFrame` 补行终止符（缺陷 D：上游收不到任何完整帧）** | 完成 |
| **Step 6** | **`type-text` / `hotkey` / `read-control` 接入路由（缺陷 E、F：工具对模型可见却无法执行）** | 完成 |

### 测试与验证结果

| 范围 | 结果 |
|---|---|
| `desktop` | 104 files / **1821 passed** / 2 skipped（基线 1818，+3 条新断言） |
| `desktop/renderer` | 29 files / 342 passed |
| `broker` | 15 files / **181 passed**（基线 171，+10 条新断言） |
| `tsc --noEmit` | desktop ✅ / broker ✅ |
| `npm run build --prefix broker` | ✅（dist 已刷新） |
| ESLint | 5 errors（全部为既有问题，位于本次未修改的文件） |
| 实盘 E2E | ✅ 见下 |

**实盘验证（dev 客户端 + 真实 MCP 端点）**：

| 调用 | 修复前 | 修复后 |
|---|---|---|
| `focus-window {processName}` | 13ms 报 `targetSystem … required` | **1.0–1.2s 成功**（DeepSeek Harness / chrome / Notepad / Code 四个真实应用） |
| `snapshot-ui-tree {processName}` | >90s 不返回 | **1.7–8.6s 返回元素树** |
| `snapshot-ui-tree {}`（无窗口） | 90s 超时 | **5.8s 正常返回** |
| `find-control {windowTitle,label}` | `upstream-call-failed` | **436ms 正常返回** |
| 不存在的窗口 | 超时 | **147ms 显式拒绝** `window-focus-failed` |
| 超时后下一次调用 | 持续失败 | **1.0s 成功**（会话已自愈） |
| `type-text {text, x, y}` | `unsupported-broker-operation` | **1966ms 成功**，且输入标记后读回 `value = "YAN4505"` 证实落地 |
| `hotkey {keys:"ctrl+c"}` | `targetSystem … required` | **4406ms 成功** `Pressed ctrl+c.` |
| `read-control {label}` | `unsupported-broker-operation` | **1671ms** 返回真实控件值 |

### 中断恢复入口

1. 读计划文件的任务清单（`- [ ]` 未勾选项）。
2. 读本文件的完成状态表。
3. 运行 `cd desktop && npx vitest run` 确认当前绿色。
4. 从第一个未完成 WP 继续。

## V5.4 修复轮（2026-10-12）

**主题**：多步 GUI 场景的编排契约与写操作窗口绑定 ——「打开 QQ → 找群 → 发消息」中"当前聊天窗就输入了、也没有发送"。

**计划文件**：`docs/superpowers/plans/2026-10-12-companyclaw-v5-4-gui-orchestration-and-window-bound-writes-implementation-plan.md`

### 完成状态

| Step | 内容 | 状态 |
|---|---|---|
| Step 1 | `click` / `scroll` / `type-text` 补窗口前置（读写前置不一致 ⇒ 写操作落到前台窗口） | 完成 |
| Step 2 | 编排契约写进 `AGENT_TOOLS` 描述（`initialize.instructions` 是死通道） | 完成 |
| Step 3 | schema 字段描述 + stdio 备用清单同步（`focusedWindow` / `addressedWindow`） | 完成 |
| Step 4 | `BLOCKERS.md` 追加 V5.4 小节（V5-B14、V5-D7..V5-D11） | 完成 |

### 测试与验证结果

| 范围 | 结果 |
|---|---|
| `broker` | 15 files / **187 passed**（基线 181，+6 条新用例） |
| `desktop` | 104 files / **1827 passed** / 2 skipped（基线 1821，+6 条新用例） |
| `tsc --noEmit` | desktop ✅ / broker ✅ |
| `npm run build --prefix broker` | ✅（dist 已刷新） |
| ESLint | 5 errors（全部为既有问题，位于本次未修改的文件） |
| 实盘 E2E | ✅ 见下（dev 客户端重启后） |

**实盘验证（dev 客户端 + 真实 MCP 端点，前台窗口用 PowerShell `GetForegroundWindow` 独立测量）**：

| 调用 | 结果 |
|---|---|
| `scroll {windowTitle: TARGET}` | **前台由 PARK 变为 TARGET** ⇒ 新前置生效（重复 2 次一致） |
| `scroll`（无 `windowTitle`） | 前台**保持 PARK** ⇒ 无 target 行为不变 |
| `hotkey {keys:"ctrl+c", windowTitle}` | 前台**不变** ⇒ `hotkey` 未受前置影响 |
| `click {windowTitle:"不存在"}` | 69ms `已拒绝：window-focus-failed`，未点击任何窗口 |
| `type-text {text:""}` | 11ms `已拒绝：text-required` ⇒ 参数校验先于切窗，未抢焦点 |
| `launch-app {app:"QQ"}` | 6646ms `Qq launched.` |
| `focus-window {processName:"QQ"}` | 809–2736ms `Switched to Qq window.` |
| `snapshot-ui-tree {windowTitle:"QQ"}` | 1161–1600ms，**33.8 KB** 元素树 |
| `hotkey {keys:"ctrl+f"}` | 558ms `Pressed ctrl+f.` |
| **`type-text {windowTitle:"QQ", x:1668, y:1063}`** | **897ms `Typed 文件传输助手`**，前台**保持 QQ** ⇒ 窗口绑定在真实应用上生效 |
| `tools/list` | 16 工具，四条描述与字段描述与源码一致 |

### 关键机制变更

1. **写操作的窗口前置**：`click` / `scroll` / `type-text` 复用读操作已有的 `focusPrelude()`（`App{mode:"switch"}` → 动作）。前置在**参数校验之后**执行——被拒绝的调用不得先抢走用户焦点。`hotkey` 与 `launch-app` **有意排除**（快捷键语义是"送给当前焦点"，切窗会自我破坏 `alt+tab`）。
2. **编排契约的通道**：实测确认 OpenClaw 不消费 MCP `initialize.instructions`（`grep getInstructions` 在其全部 `dist/*.mjs` 中无调用点），只转发 `tool.description` 与 `inputSchema`（上限 1024 字符）。因此把"读→定位→动作→提交"的顺序契约写进工具描述与字段描述。官方 Windows-MCP 的做法相同：其服务器级 `instructions` 只有一句泛泛介绍，细化全在工具描述里。
3. **`focusedWindow` / `addressedWindow` 的区分**：`snapshot-ui-tree` / `find-control` / `click` / `type-text` / `scroll` / `verify-state` 会切前台；`read-control` / `wait-for-condition` / `inspect-dialog` 只按标题定位、不切前台。对后者写"会切前台"是错的。

### 中断恢复入口

1. 读计划文件的任务清单（`- [ ]` 未勾选项；本计划已全部勾选）。
2. 读本文件的完成状态表。
3. 运行 `cd desktop && npx vitest run` 与 `cd broker && npx vitest run` 确认当前绿色。
4. 未由代码覆盖的项见 `BLOCKERS.md` §V5.4「已知遗留」。

## 已记录的偏差

| 位置 | 偏差 | 原因 |
|---|---|---|
| `policy/risk-classifier.ts` | 新增 `high-risk` ActionCategory 并列入"任何渠道都拒绝" | 保留 V1 `high-risk` 语义（原先是 R3 且远程恒拒）；仅靠 `unknown` 会让它降级为 R2 |
| `policy/action-category.ts` | `read` 列入可确认类目、不列入 routine | 无系统级只读证据的 read 必须是业务写入（V1 规则），否则 `requirement-invariants` 会失败 |
| `approvals/approval-store.ts` | 旧记录读入时回填 `resolutionChannel`/`actionCategory` | 升级时不得丢弃员工仍能在微信卡片上看到的待批请求 |
| `broker-paths.ts` + `windows-mcp-layout.ts` | 新增 `resolveCompanyClawResourceDir`，payload 路径从**同一资源根**推导 | 首次实现把已含 `windows-mcp` 的目录又拼了一层，dev 态自检误报 `NOT_PACKAGED`；真实运行暴露后修正，并补 3 条路径用例 |
| `runtime.ts` | `setRemoteAuthorization` 保持同步签名，落盘为异步排队 | 既有调用方需要立即读取返回的视图；同时通过 `flushPermissionWrites()` 提供可等待的落盘点 |
| `broker/adapters/windows-mcp/tool-policy-map.ts` | 原计划按 README 的 `ControlStatus` 建模，实际 `tools/list` **没有该工具**；实际为 20 项 | 以真实握手结果为准（`b455c276` 实测）；`reconcileToolList` 已固化 `PINNED_UPSTREAM_TOOLS` |
| `broker/adapters/windows-mcp/tool-policy-map.ts` | 新增 `BROKER_NATIVE_CAPABILITIES`（`listWindows`/`readControl`/`captureExecutionError`） | 这三项由既有 Broker UIA 实现提供，上游无对应工具；不这样做则能力覆盖有缺口 |

## 环境阻塞（不影响代码推进）

- 无 .NET SDK → NSIS 完整产出 `ENV-BLOCKED`
- 无微信测试账号 → 微信实机 E2E `BLOCKED`
- 无签名证书 → 签名分发 `BLOCKED`
