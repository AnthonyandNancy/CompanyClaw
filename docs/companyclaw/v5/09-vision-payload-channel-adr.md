# 09 — ADR：图像载荷通道（截图如何到达模型）

- 状态：已接受（2026-10-10）
- 关联需求：V2 视觉识别；V5 §4 云端视觉授权；裁决 Q2、Q-C、裁决 a-2、裁决 ③
- 关联实现：`desktop/src/companyclaw/bridge/broker-transport.ts`、`desktop/src/companyclaw/mcp/mcp-bridge.ts`、`desktop/src/companyclaw/runtime.ts`

## 背景

截图在 Broker 内部一路完整保留（内置 Windows-MCP 产出 `Image` 块 → `session.ts` → `execution-adapter.ts` → `server.ts`），但在回到桌面端后有**两处断点**，导致图像从未到达模型：

**断点 1 — 传输层**

```
broker-transport.ts  return { status: "ok", detail: JSON.stringify(result.data).slice(0, 2_000) }
```

固定截断到 2000 字符，且 `BridgeResponse` 只有 `detail: string`，没有承载图像的字段。base64 PNG 必然被截断成无法使用的碎片。

**断点 2 — MCP 组装层**

```
mcp-bridge.ts  content: [{ type: "text", text: result.text }]
```

只组装文本块；`BridgeToolResult` 与 `McpEndpointDependencies.callTool` 均无图像字段。MCP 规范要求图像是 `content[]` 中的独立块，不能放入 `structuredContent`。

同时确认：`runtime.evaluateVision()` **无任何生产调用方**，即视觉授权记录从未被读取过。开关能存盘也不改变任何行为。

## 决策

### 1. 图像走独立旁路，不与文本 `detail` 混用

新增 `ImagePayload { data, mimeType }`，沿 `BridgeResult.executed.images` → `FacadeDispatchResult.images` → `ToolFacadeResult.images` → `runAgentToolCall.images` → `callTool.images` → `BridgeToolResult.images` 逐层透传，最终由 `mcp-bridge` 组装为：

```ts
content: [
  { type: "text", text: result.text },
  ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
]
```

**不从 `detail` 里解析图像**：`detail` 是截断过的字符串，从截断结果反解既不安全也不可靠。

### 2. 提取必须发生在字符串化之前

`extractImages(data)` 从**结构化对象**读取 `type: "image"` 块，调用点在 `JSON.stringify` 之前。先字符串化再解析会拿到已被截断的片段。

### 3. 超限拒绝而非静默截断

`MAX_IMAGE_BYTES = 8 MiB`。超过上限的图像被**丢弃并记录告警**，不转发缩短后的载荷——一张被截断的图会让模型基于错误画面判断点击坐标，比没有图更危险。`MAX_BODY_BYTES`（256 KiB）管的是入站请求，不受影响。

### 4. 闸门拒绝时 `images` 必须为 `undefined`

图像离开本机前的最后一道闸在 `runtime.handleAgentToolCall` 的 `dispatch` 回调中：仅当 `tool === "screenshot"` 且调用产生图像时执行 `evaluateVision`。**拒绝即整体丢弃**，绝不「先转发、后检查」。

不变式：*闸门拒绝 ⇒ 响应中不存在图像块*。实现上通过解构剔除 `images` 字段完成，且拒绝原因写入审计日志。

### 5. 开关语义：任一开启即放行（裁决 a-2）

`selectVisionRecordForRequest()` 优先取本通道记录，本通道未启用或已撤销时回退到另一条。原因：工具调用始终以 `local-ui` 进入（见 `01-mcp-adapter-adr.md` §8.3），按 origin 严格单选会让远程记录成为死码，用户用远程开关授权后毫无效果。

`FULL_DAILY`（完全权限）下额外传入 `allowWithoutRemoteAuthorization: true`，短路 `remote-authorization-missing`（裁决 ③）。

### 6. 授权必须绑定 provider + baseUrl + model

`authorizeVision` 保留三者必填校验：授权要说明**数据发给谁**。`evaluateVisionRequest` 要求三者与当前配置全等，因此授权写入时的 `baseUrl` 必须与配置写入端同一规则归一化（补 `/v1`），否则会出现「开关打开了但用不了」。

`runtime.getConfiguredModel()` 从 OpenClaw 配置读取 provider/baseUrl/model 供界面取值；**不读取、不返回任何凭据字段**。

## 后果

- 视觉授权从「可存盘的摆设」变为真正生效的闸门：开关关闭时截图不出本机，开启后模型收到真实图像块。
- 授权记录中的 provider/model 与当前配置不一致时自动失效（`provider-changed`），换模型需重新授权。
- 图像不进入审计日志（`audit-log.ts` 只记录决策与原因），避免 base64 泄漏到日志文件。
- 若将来需要支持「只看不上传」的本地识别，应新增独立的本地路径，而不是放宽本 ADR 的闸门。
