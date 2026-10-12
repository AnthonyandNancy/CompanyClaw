# CompanyClaw V5.0 — 阻塞项

| 编号 | 阻塞 | 影响 | 解除条件 | 责任方 |
|---|---|---|---|---|
| V5-B1 | 无微信测试账号 | 微信私聊任务、审批回复、文件回传的实机验证 | 提供可扫码绑定的微信账号 | 产品负责人 |
| V5-B2 | 无内网业务系统与脱敏数据 | 真实业务页面写入验证 | 提供内网访问与脱敏账号 | 产品负责人 |
| V5-B3 | 构建机无 .NET SDK | AppContainer 与 NSIS 完整产出 | 安装 .NET 9/10 SDK | 开发环境 |
| V5-B4 | 无代码签名证书 | 安装包签名与分发 | 提供企业签名证书 | IT |
| V5-B5 | 无清洁 Win11 非管理员目标机 | 安装态（L4）验证 | 提供目标机或虚拟机 | 开发环境 |

**不受阻塞**：通用 Computer Use 代码、策略与权限实现、单元/集成测试、Broker 与适配层的实机 UIA 与 MCP 握手验证。

## V5.1 修复轮（2026-10-10）

未新增外部阻塞项。V5.1 的修复全部在源码与 Broker 自有目录内完成，**vendored Python 保持零改动**，因此不产生「上游升级需重新套用本地补丁」的维护负担。

### 已知遗留（非阻塞，但需后续注意）

| 编号 | 事项 | 影响 | 处置建议 |
|---|---|---|---|
| V5-B6 | `launch-app` 单次调用约 22 秒 | 上游在启动后最多等 20 秒（两次 10 秒窗口探测）才返回；期间占用执行锁，因此不与其它 mutation 并发 | 属上游行为，非缺陷。若体验不可接受，可在适配层缩短等待、改用 `verify-state` 异步确认 |
| V5-B7 | `eslint` 既存错误 5 项（desktop）+ 1 项（renderer） | 与本次修复无关，均为未被触及的既有文件：`chat-attachments.ts:105`、`mcp-endpoint.ts:5-6`、`main.ts:69`、`openclaw-upgrade-recovery.ts:235`、`PermissionSettings.vue:18` | 独立清理任务 |
| V5-B8 | 完全权限档位的措辞与需求书 §225 冲突 | 需求书要求不得以「无条件完全控制」误导；裁决采用「完全权限」作为显示名 | 已在 `02-permission-preset-adr.md` §7 记录为产品负责人显式覆盖，界面保留「与 Windows 管理员权限无关」说明 |

## V5.2 修复轮（2026-10-10）

未新增外部阻塞项。修复全部在源码与 Broker 自有目录内完成，**vendored Python 保持零改动**。

### 产品负责人显式接受的安全取舍

| 编号 | 事项 | 影响 | 记录 |
|---|---|---|---|
| V5-B9 | 完全权限下 broker 不再有进程级兜底 | `unrestricted` 为真时跳过 `allowedProcesses` 与 `allowedWindowTitles`；模型可驱动任意进程（任务管理器、注册表编辑器、安全软件界面）。身份/时效/目标/票据四类校验仍生效 | `02-permission-preset-adr.md` §8.1 |
| V5-B10 | `browser.ssrfPolicy` 放宽至可访问本机与内网 | 写入 `dangerouslyAllowPrivateNetwork: true` + `allowRfc2544BenchmarkRange: true` 后，浏览器可访问 `127.0.0.1` 上的任意本地服务（含本应用 MCP 端点与 Gateway）、企业内网 `10.x`/`192.168.x`、路由器管理页；页面内容或模型被诱导时可形成 SSRF | `02-permission-preset-adr.md` §8.2 |

**V5-B10 的技术前提**：本机 Clash/Mihomo TUN fake-IP 使**所有**公网域名解析到 `198.18.0.0/15`（实测 baidu / github / google / example.com 一致），因此该配置不是单站点豁免，而是该代理环境下的必需项；`schema-C9vBoeg0.mjs` 亦将 `allowRfc2544BenchmarkRange` 描述为 *"for trusted fake-IP proxy environments"*。

## V5.3 修复轮（2026-10-12）

未新增外部阻塞项。修复全部在源码与 Broker 自有目录内完成，**vendored Python 保持零改动**。

### 本轮修复的缺陷（均已实测确认）

| 编号 | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| V5-D1 | 只给 `processName` 的调用必然失败（13ms） | `tool-facade.ts` 的 `describeTarget` 键列表不含 `processName` ⇒ `targetSystem` 空 ⇒ `completeBinding` 抛错 | 键列表加入 `processName`（置于 `windowTitle` 之后，保持标题优先） |
| V5-D2 | 按窗口的读操作恒失败 | 适配器向上游 `Snapshot` 传了**我们自己发明的** `window_name`，上游 pydantic 直接拒绝 | 改为官方用法：`App{mode:"switch"}` 先置前台 → `Snapshot` 读取；prelude 走同一套 `authorizeToolCall` |
| V5-D3 | 超时层级倒挂 + 卡死传染 | Gateway 60s < broker-client 120s；session 超时后既不重启也不释放子进程 | broker-client → 50s、session/adapter → 40s；失败后 `stop()` 自愈；握手失败释放子进程 |
| **V5-D4** | **上游 windows-mcp 的每一次调用都收不到合法帧** | **`encodeFrame()` 从不追加行终止符，而 MCP stdio 按行读取；上游因此永不回复** | `encodeFrame` 返回 `` `${line}\n` ``；修正固化了错误语义的断言 |
| **V5-D5** | **`type-text` / `hotkey` / `read-control` 对模型可见却无法执行** | 这三个工具在 `TOOL_TO_OPERATION`、`V2_OPERATIONS`（broker 与 desktop 两份）与适配器 `MAPPINGS` 里**全部缺失**；`buildArguments` 的三个 capability 分支早已写好却从未被选中 | 三张清单同步补齐；`read-control` 由 broker 原生承接（解析进程名后复用 `readValue`） |
| **V5-D6** | `type-text` 只给文本必然失败；`hotkey` 报 `targetSystem … required` | 上游 `desktop.type` 内部先 `uia.Click(x,y)` 且要求 `loc`/`label` 之一；`describeTarget` 对 `{keys}` 返回空串 | `type-text` 的模型 schema 补 `x`/`y` 并列为必填，适配器缺坐标即 `coordinate-required`；`describeTarget` 识别 `keys` 返回 `快捷键 <组合>` |

**V5-D4 的证据**：A/B 实测同一 spawn、同参数，仅差换行 —— 无换行 **15 秒零响应**（stdout bytes=0），有换行 **2057ms 正常返回**。补换行后 `ensureStarted` 从恒超时变为 `READY（4.1.0，可控工具 11 项）`，`Snapshot` 从恒 `upstream-call-failed` 变为 **1966ms / 34786 字节正常返回**。

**V5-D4 为何重要**：它使此前所有"上游很慢/卡死"的观察都需要重新解读 —— `snapshot-ui-tree` 的 ">90s 未返回" 与 `focus-window` 的 120s 超时**都是帧未送达**，不是慢。修复后 `snapshot-ui-tree` 实测 **5.8s**，`focus-window {processName}` 在 4 个真实应用上实测 **1.0–1.2s 成功**。

**V5-D4 为何长期未被发现**：`tool-registry.test.ts` 原断言为 `expect(line).not.toContain("\n")`，把"不含换行"当成了要求，而协议要求的是"**以换行结束**且内部不含换行"；测试固化了错误语义 ⇒ 缺陷通过全部单测。断言已修正为 `expect(line.endsWith("\n")).toBe(true)`。

### 产品负责人显式接受的取舍

| 编号 | 事项 | 影响 | 记录 |
|---|---|---|---|
| V5-B11 | 带窗口的读操作会隐含移动焦点 | `snapshot-ui-tree`/`find-control`/`verify-state` 携带窗口寻址时，先执行 `App{mode:"switch"}` 置前台（**官方用法**，且上游自带 1 秒前台校验）。该读操作本身不是 mutating、不需要票据，因此 agent 获得一个"无需票据即可切窗"的间接手段；焦点变化可被输入法、录屏等外部程序观察。缓解：prelude 只把焦点移向**本次被授权读取的那个窗口**，不移向别处 | `2026-10-12-companyclaw-v5-3-window-scoped-reads-and-tool-call-binding-implementation-plan.md` §6.1 |

### 已知遗留（非阻塞）

| 编号 | 事项 | 影响 | 处置建议 |
|---|---|---|---|
| V5-B12 | 原生 `find-elements` 路径未接入 | 该路径支持 `processName`+`title` 双寻址、不移动焦点（实测 `chrome` 窗口 870ms / 26 元素），但**输出不含坐标**，无法支撑"找到控件→点击" | 保留为备选：将来若只需元素清单、不需坐标，这是更省焦点副作用的路径 |
| V5-B13 | `region` 方案未采用 | `region` 能限定树遍历范围，但 `get_controls_handles`/`get_windows` 在 `region` 生效**之前**已执行，实测未能证明可规避枚举阶段的卡顿 | 若将来枚举阶段成为瓶颈，再评估 |

## V5.4 修复轮（2026-10-12）

需求原文（用户）：

> 【1.对于需要复杂的场景，做不到细化，比如 qq 不在前台，让 bot"打开 qq，找到 qq 群聊的"我与赌毒不共戴天①"这个群，然后发消息说"大家晚上好，我是 ikun bot""，这时候 bot 不会去搜索 qq 群聊再去找，而且当前聊天窗就输入了，也没有发送。对于这个场景查看官方 mcp 的细化场景是如何做的，我们的 bot 需要怎么配合；】

### 本轮修复的两个缺陷（均已实测确认）

| 缺陷 | 根因 | 修复 |
|---|---|---|
| `click` / `scroll` / `type-text` 把动作落到错误窗口（"当前聊天窗就输入了"） | 三个写操作分支只读坐标，**完全不引用** `target.windowTitle`；而 `snapshot-ui-tree` / `find-control` / `verify-state` 三个读操作早已有 `focusPrelude()`。读写前置不一致 ⇒ 模型读到的是 QQ 的坐标，输入却落在当前前台窗口 | 三个分支在参数校验**之后**补上与读操作相同的 `focusPrelude()`；切不到前台即 `window-focus-failed`，不发出主调用 |
| 模型的编排契约从未生效（"不会去搜索群聊再去找"），且"也没有发送" | 编排说明写在 `initialize.instructions` 里，但 **OpenClaw 不消费该字段**；它只转发 `tool.description` 与 `inputSchema`（`daemon-BJYIjnke.mjs:2892`，上限 1024 字符）。另外 `pressEnter` 的映射一直正确（`mcp-bridge.ts:142` → `service.py:757` `uia.SendKeys("{Enter}")`），但描述中无"提交/发送"语义，模型不会主动使用 | 编排契约改写进 `tool.description` 与字段级 `description`：`snapshot-ui-tree` 声明"任何桌面操作的第一步"、`click` 声明"窗口变化后必须重读"、`type-text` 声明"pressEnter 为 true 时回车提交（发送消息）"、`wait-for-condition` 声明"代替反复读取" |

**编排契约为何长期未生效且未被发现**：`initialize.instructions` 是 MCP 协议里的合法字段，写在 `buildInitializeResult()` 里看起来"已经告诉模型了"；而 OpenClaw 的 MCP 客户端只取 `tools/list`。要观察到这点必须去读 node_modules 里的 dist 产物，单测覆盖不到——现有测试只断言了该字段存在（`mcp-bridge.test.ts` 的 "announces itself as the CompanyClaw computer-use server"），没有断言它会被消费。官方的做法可作为反证：其服务器级 `instructions`（`__main__.py:66`）只有一句泛泛介绍，真正的操作顺序全部写在工具描述里。

### 产品负责人显式接受的取舍

| 编号 | 事项 | 影响 | 记录 |
|---|---|---|---|
| V5-B14 | 窗口范围的写操作会隐含移动焦点，且每次多一次上游调用 | `click` / `scroll` / `type-text` 携带窗口寻址时先执行 `App{mode:"switch"}` 置前台（官方用法，上游自带 1 秒前台校验），换取"不会点到别的窗口"。代价是每次写操作从 1 次上游调用变为 2 次（`switch_app` 自带 50ms 轮询、上限 1.0s）。**关键约束**：`hotkey` 不加前置——快捷键语义是"送给当前拥有焦点的控件"，切窗会改变焦点目标本身，`alt+tab` 尤其会自我破坏。另一条：`launch-app` 也不加前置，依赖上游 `app(mode="launch")` 内部 10s 的 UIA 等待，避免重复且语义更弱的等待 | `2026-10-12-companyclaw-v5-4-gui-orchestration-and-window-bound-writes-implementation-plan.md` §6.1 |

### 已知遗留（非阻塞）

| 编号 | 事项 | 影响 | 处置建议 |
|---|---|---|---|
| V5-D7 | `window-focus-failed` 成为 `click` / `scroll` / `type-text` 的新可见失败码 | 这是有意的（胜过点到错误窗口），但用户侧会看到新的拒绝文案：`已拒绝：window-focus-failed` | 若需更友好的提示，在 `main.ts` 的结果映射里为该 reason 增加中文说明，属文案改动 |
| V5-D8 | 描述声明"窗口变化后坐标失效，必须重读"，但没有机械校验窗口内容是否变化 | `computer-use-tools.ts` 与 `mcp-bridge-server.ts` 的 `click` 描述、以及 `tool-policy-map.ts:144-148` 的 `reason` 历史上都写过"执行前复核窗口未变化"，而适配器**没有**任何指纹对比。本版把**模型可见**的文案改为可实现的一致表述（属模型自律）；`tool-policy-map.ts` 的 `reason` 不进模型上下文，本次未改，缺口在此登记 | 若要机械校验，需引入窗口标题 + 元素树指纹对比，属独立能力 |
| V5-D9 | 官方 `Click` / `Type` / `Scroll` 支持整数 `label` 寻址，本产品只暴露坐标 | `desktop/service.py:660 get_coordinates_from_label` 依赖进程内 `interactive_nodes[label]`（由 `service.py:1308` 的 `draw_annotation` 生成），而本产品 `snapshot-ui-tree` 强制 `use_vision:false`，标注图与 label 索引不生成。坐标路径可用（实测 `snapshot-ui-tree` 返回 34786 字节，含 `(x,y)` 坐标） | 若将来引入视觉快照，可一并开放 label 寻址 |
| V5-D10 | 上游 `switch_app` / `_find_window_by_name` 用 `fuzzywuzzy.extractOne(..., score_cutoff=70)` 模糊匹配窗口标题 | `desktop/service.py:435`。QQ 实测有 7 个 `QQ.exe` 进程，模糊匹配可能选中非目标窗口 | 若出现"切到了错误的 QQ 窗口"，再评估是否改为精确/前缀匹配并加窗口类名过滤 |
| V5-D11 | `initialize.instructions` 是死通道，字段保留但不生效 | `mcp-bridge.ts:210` 与 `mcp-bridge-server.ts:175` 仍写着该字段。本次不删（删除属无关改动），但它会给后续读者造成"已经告知模型了"的错觉——正是本轮缺陷的成因 | 若未来 OpenClaw 开始消费该字段，内容仍是正当的；否则应在某次整理中删除并在此注明 |

### 本轮实测证据

- `execution-adapter.test.ts` 新增 6 个用例：实现前 3 个失败（正是断言新行为的 3 个），实现后 40 passed。
- `broker` 全量：15 文件 / **187 passed**（基线 181 + 6）。
- `desktop` 全量：104 文件 / **1827 passed / 2 skipped**（基线 1821 + 6）。
- `click` / `scroll` / `type-text` 带 `windowTitle` 的调用序列实测为 `["App","Click"|"Type"|"Scroll"]`，`App` 参数为 `{mode:"switch", name:<标题>}`；不带窗口时仍为单次调用。
- 官方 Windows-MCP 的"细化"做法逐条核对：`tools/snapshot.py:26` `Always call this first to understand the current desktop state before taking actions.`；`tools/input.py:271` `Set press_enter=True to submit after typing.`；`tools/input.py:451` `avoid repeated Snapshot calls`；`tools/input.py:238` `Provide either loc or label.`。**全部写在工具描述里，没有任何应用专属脚本**。
