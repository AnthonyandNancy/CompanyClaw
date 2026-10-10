# 05 — 安全负向测试

需求要求：**旁路不能绕过策略、来源不能伪造、敏感写入不能在没有可核验授权的情况下执行**。
本文逐条列出负向用例及其真实出处，全部为可执行代码。

## 1. 身份与来源伪造

| 攻击 | 期望 | 用例 |
|---|---|---|
| 模型在工具参数里声明 `origin: "local-ui"` 冒充本地 | 拒绝（`model-supplied-identity`） | `tools/tool-facade.test.ts`「rejects a call that names its own origin, owner or device」 |
| 模型在参数里带 `ownerSid` / `deviceId` / `taskId` | 拒绝 | 同上 |
| 模型自己填 `approvalTicket` / `approved` / `approvalId` | 拒绝（`model-supplied-approval`） | 「rejects a call that presents its own approval」 |
| 聊天文本自称本地管理员 | 不改变可信上下文（来源只由本地绑定铸造） | `remote/trusted-context.ts` + `remote-authorization.ts:bindSessionSource` 既有用例 |
| 未绑定微信用户发指令 | 不创建任务 | 既有 `unbound-sender` 用例 |

## 2. 票据与审批

| 攻击 | 期望 | 用例 |
|---|---|---|
| 用别的密钥伪造票据签名 | `invalid-approval-ticket` | `broker/ticket-verify.test.ts` |
| 同一张票据换一个 `payloadHash` 复用 | 拒绝 | 同上 |
| 同一张票据换 `operation`（如把 `set-value` 改成 `send-keys`） | 拒绝 | 同上 |
| 同一张票据换 `taskId` | 拒绝 | 同上 |
| 使用已过期票据 | 拒绝 | 同上 |
| broker 未配置密钥就接收变更 | **全部拒绝**（fail-closed） | 「a broker without a key refuses everything mutating」 |
| 审批被拒绝后仍尝试执行 | 不放行、执行器未收到调用 | `runtime-tool-chain.test.ts`「refuses to run after a rejection」 |
| 审批超 600s 后批准 | 拒绝（`expired`） | `approvals/approval-wait-window.test.ts` |
| 恢复安全默认值后复用未消费审批 | 全部作废 | `recovery/reset-to-defaults.test.ts` |

## 3. 高危能力不可达

| 攻击 | 期望 | 用例 |
|---|---|---|
| 请求上游 `PowerShell` 工具 | DENY，且不可为任何能力放行 | `tool-policy-map.test.ts` |
| 请求 `FileSystem` / `Registry` / `Process` / `Clipboard` / `Scrape` | DENY | 同上 |
| 使用未在 allow-map 中的新工具名 | 拒绝，并报 `unclassified` | 「reports an unclassified tool so an upgrade cannot pass unnoticed」 |
| 通过参数注入 `command` / `script` / `exec` / `shell` | 拒绝 | `tool-registry.test.ts`「refuses an argument that would smuggle in a command」 |
| 用一个工具的名做另一个能力的事（如 `Click` 做 `typeText`） | 拒绝 | 「refuses a capability the tool was not mapped to」 |
| 用路径启动应用（`launch` 退化为 `exec`） | 拒绝 | `execution-adapter.test.ts`「refuses to launch by path」 |
| 未列举的快捷键（如 `win+r`） | 拒绝 | 「allows only enumerated shortcuts」 |
| 无坐标点击 / 负坐标 / NaN | 拒绝，不猜位置 | 「refuses a click without coordinates」 |
| 缺少端点或窗口的拖拽 | 拒绝 | 「refuses a drag without both endpoints」 |
| 无上限或非法超时的等待 | 拒绝 | 「refuses an unbounded or invalid wait」 |

## 4. 渠道差异化（不得互相放宽）

| 场景 | 期望 | 用例 |
|---|---|---|
| 微信远程请求永久删除 | 恒拒绝 | `v5-channel-policy.test.ts` |
| 本地请求同一动作 | 需确认（**远程拒绝不得使本地失效**） | 同上 |
| 微信远程请求付款 / 提权 / 任意命令 / 未知高危 | 两渠道均拒绝 | 「refuses payment, privilege and uncharacterised high risk everywhere」 |
| 微信远程请求群发 / 批量外发 | 拒绝 | 「refuses group and bulk sending from WeChat」 |
| 声明为单收件人但列出多个收件人 | 重新归类为批量并拒绝 | 「re-classifies a multi-recipient message as bulk」 |
| 远程未开启时微信发指令 | 拒绝（含只读） | `runtime-tool-chain.test.ts` |
| 本地任务范围授权覆盖 R3 | 仍然拒绝 | 「never lets a task grant widen an R3 category」 |

## 5. 视觉与数据外发

| 攻击 | 期望 | 用例 |
|---|---|---|
| 未授权就上传截图给云端模型 | 阻断 | `vision/vision-gate.test.ts` |
| 撤销后仍在原有效期内上传 | 阻断 | 同上 |
| 更换模型/服务商后沿用旧授权 | 失效 | 「voids the grant when the … changes」 |
| 把授权范围从单窗口扩大到整桌面 | 阻断 | 「refuses a capture scope wider than the one granted」 |
| 远程视觉授权超出远程操作授权期限 | 截断至较短者 | 「never lets a remote grant outlive the remote operation authorization」 |
| 开启「全面日常操作」顺带打开云端视觉 | 不发生 | `PermissionSettings.test.ts` + 策略解耦 |
| 声称可撤回已上传内容 | 界面文案明确不可撤回 | `PermissionSettings.vue` |

## 6. 恢复与持久化

| 场景 | 期望 | 用例 |
|---|---|---|
| 用过期预览令牌执行恢复 | 拒绝（`stale-preview`），授权保持不变 | `reset-to-defaults.test.ts` |
| 恢复后重启应用 | 旧授权不复活 | 「does not resurrect any grant after a restart」 |
| 撤销远程授权后重启 | 不复活 | `runtime-permissions.test.ts` |
| 旧 `allow-always` 迁移 | 仅本地、原范围，`preset=BASIC` | 「never lets a migrated legacy entry authorize a remote run」 |
| 权限文件损坏 | 回退安全默认并保留原文件 | `permission-store.test.ts` |

## 7. 未覆盖（诚实记录）

以下项需要交互式桌面会话或真实外部账号，本机无法执行，记 `UNVERIFIED` / `ENV-BLOCKED`：

- 锁屏 / 注销 / UAC 安全桌面下的实际行为（需实机）。
- 高 DPI、多屏、中文输入法的真机截图与点击一致性。
- 真实 QQ 客户端与公司内网系统上的 UAT（产品负责人自测）。
- 安装态（NSIS）下的破坏性测试：缺少 .NET SDK 与清洁目标机。
- 微信真实平台边界的收发与审批回复链路：缺少可绑定账号。
