# 06 — 浏览器自动化

## 现状

上游 OpenClaw 具备 Browser 能力（`config-write-policy.ts` 的合法顶层键含 `browser`），但**本仓库无 browser 技能、无 CDP/Playwright 依赖、无工作 Profile 管理**。

## 本项目新增：策略层

`desktop/src/companyclaw/policy/browser-policy.ts`

### 域名白名单

- **默认拒绝所有域名**；需显式配置
- 仅允许 `http` / `https`（`file://` 可达本地磁盘、`javascript:` 可在页面上下文执行，二者均拒绝）
- 匹配使用**点边界**：`evil-oa.example.com` 不是 `oa.example.com` 的子域，`oa.example.com.evil.net` 也不匹配
- 内网访问必须逐域名显式允许；**裸 IP 不是绕过手段**（未列白名单即拒绝）

### 动作分级

| 归类 | 动作 |
|---|---|
| read | `navigate` / `read` / `search` / `snapshot` / `screenshot` |
| write | `click-submit` / `fill-form` / `edit-field`，以及 `click`、`upload`、`download` 和**任何未识别动作** |
| high-risk | `delete` / `publish` / `pay` |

**关键规则**：通用 `click` 归类为**写**（点击可能提交表单）；未知动作同样归类为写。仅凭动作名不足以证明安全。

### 能力开关

下载与上传是**独立开关**，默认关闭。

### 运行时裁决

`CompanyClawRuntime.authorizeBrowserAction` 要求两道闸门同时通过，且失败原因保持区分：

- `remote-not-authorized`（远程操作未开启）
- 策略拒绝（`domain-not-allowed` / `unsupported-scheme` / `downloads-disabled` / `uploads-disabled`）

返回的 `risk` 供调用方判断：`write` / `high-risk` 仍需取得审批后才可执行。

## 未完成

| 项 | 说明 |
|---|---|
| **实际浏览器驱动** | 尚未实现：策略层完备，但没有受控的 OpenClaw Browser 调用器 |
| 工作 Profile 管理 | 未实现（独立持久 Profile 是既定方向，"复用现有 Chrome 会话"不作为无人值守默认） |
| 操作后回读验证 | 未实现（IX 需求要求"保存后重新查询并验证字段值"） |
| 真实验证 | 需内网测试系统（`BLOCKERS.md` B2） |

## 已知约束

- 若模型不支持图片理解，**不得**把截图当作模型可理解输入（能力探针会把 `vision` 报为 `unknown`，调用方不得假定可用）。
