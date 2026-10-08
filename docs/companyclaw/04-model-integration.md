# 04 — 模型接入（BYO Model）

## 现状

- **上游既有**（不改动）：`desktop/src/model-setup.ts`、`model-connection.ts`、`model-provider-plugins.ts`，以及 `model:test-connection` IPC；`SettingsView` 的模型分节可配置提供商 / Base URL / Model ID / API Key 并测试连接。
- **本项目新增**：能力探针 `desktop/src/companyclaw/model/capability-probe.ts`。

## 能力探针

`companyclaw:model:probe-capabilities` 会向所选端点发送**要求调用具体工具**的请求，以此证明工具调用确实可用，而不是仅证明端点能应答。

**三态结果**：`supported` / `unsupported` / `unknown`

| 情形 | 结果 |
|---|---|
| 返回了 tool call | `toolCalls = supported` |
| 只返回文本 | `toolCalls = unsupported` |
| 请求失败（401/402/403/429/5xx/网络） | `toolCalls = unknown`，并给出 `error` |
| 响应结构不符合预期 | `unknown` |

**关键规则**：`unknown` **不等于** `unsupported`，也**不得**被展示为可用。摘要中固定渲染为「未验证（不可假定可用）」。请求失败只能说明请求失败，不能推断模型能力。

## 错误映射

| 状态 | error |
|---|---|
| 401 | `unauthorized` |
| 402 | `insufficient-quota` |
| 403 | `forbidden` |
| 429 | `rate-limited` |
| 5xx | `server-error` |
| 其它 4xx | `request-rejected` |
| 网络异常 | `network-error` |

## 凭据处理

- API Key 仅经请求头传递，**不进请求体、不落盘、不回显**
- 上游既有机制负责持久化（`openclaw.json` + `.env`，受敏感文件保护）
- 探针每次调用由渲染端传入 key，主进程用后即弃

## 与需求对照

| 需求 | 状态 |
|---|---|
| 配置提供商 / Base URL / Model ID / API Key | 上游既有，可用 |
| 连接测试 | 上游既有，可用 |
| 错误提示（401/402/429/超时） | 上游既有 + 探针映射 |
| **能力探针（tools / vision / reasoning / structured-output）** | 工具调用已实测；其余三项当前返回 `unknown` 而非猜测 |
| 密钥不明文入 JSON/日志 | 上游既有保护 + 探针不落盘 |

## 未完成

- `vision` / `reasoning` / `structuredOutput` 三项尚未实现真实探测，当前**恒为 `unknown`**（有意如此：不以猜测填充）。
- 探针结果尚未持久化到配置（每次调用重新探测）。
- 尚未在真实 DeepSeek 端点上验证（`BLOCKERS.md`：需网络与可用 Key）。
