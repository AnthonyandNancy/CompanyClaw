# 03 — 数据与安全

## 数据位置

全部位于 `app.getPath("userData")`（与上游 `windows-node/durable-approvals.json` 同根）：

```text
userData/companyclaw/
  tasks.json                 任务索引与详情
  approvals.json             审批记录
  identity-binding.json      微信身份 → 设备 → Windows SID 映射
  companyclaw-ticket-secret  票据签名密钥（0600，仅主进程可读）
  jobs/<taskId>/artifacts/   每任务产物目录（0700）
```

## 数据契约

| 文件 | contract | schemaVersion | 失效行为 |
|---|---|---|---|
| `tasks.json` | `companyclaw.tasks.v1` | 1 | 不可读/格式非法/版本不符 → **返回空列表**（不授权任何任务） |
| `approvals.json` | `companyclaw.approvals.v1` | 1 | 同上 → **无待审批项** |
| `identity-binding.json` | `companyclaw.identity-binding.v1` | 1 | 同上 → **视为未绑定** |
| 票据 | `companyclaw.approval-ticket.v1` | — | 签名错误/过期/重放/跨绑定 → 拒绝 |
| Broker 线协议 | `companyclaw.broker.v1` | — | 契约不符 → `unsupported-contract` |

## 写入方式

- 原子写：`mkdir(0700)` → 临时文件 → `rename`
- 权限：文件 `0600`、目录 `0700`
- 串行化：每个 store 单写队列，避免并发覆盖

## 任务状态机

```text
CREATED → AUTHENTICATED → PLANNING → RUNNING ⇄ AWAITING_APPROVAL
RUNNING → VERIFYING → COMPLETED / PARTIAL / FAILED
RUNNING / AWAITING_APPROVAL / PLANNING → PAUSE_REQUESTED → PAUSED → RESUMING → RUNNING|AWAITING_APPROVAL
任意活动态 → CANCELLED / EXPIRED
```

- **禁止** `PAUSED → RUNNING` 直连（必须经 `RESUMING` 复核）
- 终态不可再转换；终态不接受任何控制
- 转换唯一入口：`CompanyClawTaskStore.advance` / `CompanyClawRuntime.controlTask`

## 风险分级

| 级别 | 判定 | 远程默认策略 |
|---|---|---|
| R0 | `kind=read` **且有**系统级只读证据（只读账号 / 只读 ACL / 已证动作集） | 可自动（需远程授权处于 enabled） |
| R1 | `kind=local-work`（授权目录内非写入型本地处理） | 可自动 |
| R2 | `kind=write`、`unknown`、以及任何**没有只读证据**的 read | 必须微信授权 |
| R3 | delete / payment / publish / system-config / registry / arbitrary-command / unknown-program / bypass-security / high-risk | **恒拒绝，无开关** |

**硬性约束（有测试）**
- 只读判定不看工具名，只看是否提供 `readOnlyProof`
- 未知动作名 → 按 R2 处理
- `commitInterceptable === false` 的 R2 → **拒绝而非批准**
- R3 由动作类别决定，与工具名无关

## 审批与票据

**审批绑定字段**：`ownerSid, deviceId, taskId, stepId, actionType, targetSystem, recordId, field, oldValue, newValue, canonicalPayloadHash`

**票据**：HMAC-SHA256，默认 TTL 120s，单次消费（**派发前**消费 nonce，避免崩溃后可重放）

**审批生命周期**：`pending → approved | denied | expired`
- 只有 `ownerSid` 匹配者可决定
- 终态不可再决定；过期在**读取时**即投影为 `expired`（不依赖定时清理）

**微信回复**（`remote/approval-message.ts`）
- 仅接受显式形式：`Y`/`N`/`Y1`/`N2`/`批准`/`拒绝`/`同意`/`驳回`/`全部批准`/`批准第2项`
- 其它文本 → `not-a-reply`，放行给 AI（**不吞普通聊天**）
- 回复只作用于该 owner 的待审批项

## 身份与授权分离

| 概念 | 含义 | 存储 |
|---|---|---|
| 身份绑定 | **是谁**（微信 userId ↔ 设备 ↔ SID） | `identity-binding.json` |
| 远程授权 | **能否操作**（开关 + 有效期 + 撤销） | 内存 + 可写回 |

`isRemoteCallerAuthorized` 要求**两者同时成立**。已绑定但远程授权关闭 → 仍拒绝。

## 文件与产物

- 每任务目录：`jobs/<taskId>/artifacts/`
- `taskId` 非法（含分隔符、`..`、控制字符、超长）→ 返回 `null`，**不静默改写**
- 产物文件名：剥离目录成分、去除 Windows 非法字符、拒绝保留设备名（CON/LPT1…）
- 包含性检查使用**尾随分隔符**比较，`artifacts-evil` 不会被视为 `artifacts` 内部
- 校验：存在性、大小、**魔数**、容器结构（`.xlsx/.docx/.pptx` 必须是真实 ZIP；`.pdf` 必须有 PDF 签名）

## 送达状态

```text
SEND_REQUESTED → SENT → DELIVERED
                ↘ FAILED / UNKNOWN
```

- `SENT` = 平台已受理；`DELIVERED` 仅在**有可靠终端回执证据**时写入
- 无回执 → `UNKNOWN`（**不得**自动升级为 `DELIVERED`）

## 浏览器

- 默认**拒绝所有域名**；需显式配置白名单
- 域名匹配使用点边界（`evil-oa.example.com` 不是 `oa.example.com` 子域）
- 仅允许 `http`/`https`（`file://`、`javascript:` 拒绝）
- 通用 `click` 归类为**写**，未知动作也归类为写
- 下载/上传是独立开关，默认关闭

## Broker

- 传输：**仅 127.0.0.1 环回**（不监听 0.0.0.0 / 局域网）
- 鉴权：每次连接需执行令牌（32 字节熵，经**环境变量**传递，不入 argv）
- 服务端强制：ownerSid、deviceId、时效、应用白名单、窗口标题限制、写入需票据
- 写入操作 = `invoke-pattern` / `set-value` / `send-keys`；只读操作无需票据
- 白名单为空 → **拒绝一切**
- 进程生命周期：stdin 关闭即退出（不留孤立监听）

## 不记录的内容

- 不存明文口令/令牌/整页敏感内容
- 证据只存引用与哈希
- Broker 请求不记录 API Key（密钥仅经请求头传递，不落盘）
