# 05 — 微信集成

## 现状（上游既有，不改动）

| 能力 | 位置 |
|---|---|
| 扫码登录全流程（含过期、已扫、待确认、需验证码） | `plugins/openclaw-weixin/src/auth/login-qr.ts` |
| 账号存储 | `accounts.json` + `accounts/<id>.json` |
| 授权用户白名单 | `credentials/openclaw-weixin-<accountId>-allowFrom.json` |
| 消息处理 | `src/messaging/process-message.ts`（含 slash 命令拦截先例） |
| 媒体收发 | `src/messaging/send.ts`、`send-media.ts`、`src/media/media-download.ts` |
| 桌面端管理 | `plugin:weixin:get-status` / `login` / `disconnect` 等 IPC |

## 本项目新增（桌面侧）

### 身份绑定 `remote/identity-binding.ts`

固定映射：**微信身份 → 设备 → Windows SID**

- 只保存**一条**绑定，重新绑定时原子替换，旧绑定不留存
- 匹配同时校验 `channelType` 与 `channelUserId`（换渠道或换用户均不继承）
- 存储不可读/格式非法/版本不符 → **视为未绑定**
- 绑定只回答"是谁"；能否操作由远程授权单独决定

### 审批消息 `remote/approval-message.ts`

- 出站卡片：系统 / 记录 / 字段 / 原值 → 新值 / 有效期 / 风险等级
- 多待审项自动编号，并给出 `Y` / `N` / `Y1` / `N2` 的回复说明
- 入站解析**只接受显式形式**；其它文本返回 `null` 并放行给 AI
- 回复只作用于该 owner 的待审批项；越界序号被拒绝

## 群消息

上游 `process-message.ts` 硬编码 `isGroup: false`，插件**仅支持单聊**。因此"群消息不执行电脑操作"当前天然成立；若未来上游支持群聊，需在此处补一条显式拒绝。

## 送达状态

`results/delivery-status.ts` 实现 `SEND_REQUESTED → SENT → DELIVERED`（+`FAILED`/`UNKNOWN`）。

**重要事实**：`plugins/openclaw-weixin/src/messaging/send.ts` 返回的 `messageId` 是**本地生成的 clientId**，不是服务端送达回执。因此 `DELIVERED` 无法自动达成，默认只能标到 `SENT`，无证据时为 `UNKNOWN`。

## 未完成

| 项 | 说明 |
|---|---|
| 插件侧审批拦截分支 | 桌面侧逻辑已完备；插件接入待做（见 ADR 0002 的最小 patch 计划） |
| `session-source` 生产者 | **全库缺失**：`main.ts` 有消费者但无生产者，`cachedRemoteSource` 恒为 `undefined` |
| 出站实际发送 | 需把 `buildApprovalMessage` 的输出交给插件发送 |
| 真实验证 | 需微信测试账号（`BLOCKERS.md` B1） |

## 渠道合规

- 只使用腾讯官方 `openclaw-weixin`（vendored 2.4.6）
- **不引入** wxauto / wcferry 等非官方个人微信 Hook
- 不允许两个微信插件同时注册同一 channel
