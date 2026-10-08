# 07 — Windows 自动化（Broker）

## 架构选择

采用**方案 B：独立受限 Windows Execution Broker**。理由：方案 A 需修改上游有意设计的 MXC ingress 隔离，安全回归面过大；方案 C 无法满足核心需求。

Broker 是**收窄权限的代理**，不是任意转发器。它运行在当前授权员工的**交互式会话**中，**不以管理员或 SYSTEM 运行**。

## 进程与传输

| 项 | 实现 |
|---|---|
| 入口 | `broker/main.ts` |
| 传输 | **仅 127.0.0.1 环回** TCP（不监听 0.0.0.0 / 局域网） |
| 帧格式 | 单行 JSON，超过 256 KiB 的连接被丢弃（不缓冲） |
| 鉴权 | 每次连接需执行令牌；32 字节熵；经**环境变量**传递（不入 argv，避免进程列表泄露） |
| 配置 | 全部经环境变量：`COMPANYCLAW_BROKER_TOKEN` / `_OWNER_SID` / `_DEVICE_ID` / `_SCRIPT_DIR` / `_ALLOWED_PROCESSES` / `_ALLOWED_WINDOW_TITLES` |
| 生命周期 | 启动时经 stdout 公告端口；**stdin 关闭即退出**，不留孤立监听 |
| 拉起方 | `desktop/src/companyclaw/broker-client.ts`；`main.ts` 在 `before-quit` 停止它 |

## 服务端强制（`broker/policy.ts`）

每次请求都重新校验，任一不满足即拒绝：

| 检查 | 拒绝原因 |
|---|---|
| 归属用户 SID | `owner-mismatch` |
| 设备标识 | `device-mismatch` |
| 请求时效 | `not-yet-valid` / `expired` |
| 目标进程在白名单内 | `process-not-allowed` |
| 窗口标题（若配置了限制） | `window-title-not-allowed` |
| 需要目标的操作未提供目标 | `target-required` |
| 写入操作缺票据 | `approval-required` |
| 票据校验失败 | `invalid-approval-ticket` |

**白名单为空 → 拒绝一切。**

## 操作集（封闭）

| 操作 | 类型 | 实现 |
|---|---|---|
| `list-windows` | 只读 | 枚举顶层窗口（名称、PID、**进程基名**） |
| `find-elements` | 只读 | 读取目标窗口控件树（深度/数量受限） |
| `read-value` | 只读 | 读取元素当前值 |
| `set-value` | **写入** | 设置值并**回读校验** |
| `invoke-pattern` | **写入** | 语义激活（Invoke / SelectionItem） |
| `send-keys` | **写入** | 元素寻址的文本输入，替换/追加，**回读校验** |
| `describe-element` | — | `not-implemented`（**不伪造成功**） |
| `wait-for-window` | — | `not-implemented` |

## 关键设计决定

### 1. 进程绑定而非标题绑定

`list-windows` 返回**进程基名**（不含 `.exe`、不含路径），策略据此与白名单比对。早期版本按窗口标题子串过滤——那是错的：标题文本无法证明进程身份。

### 2. 为什么 `send-keys` 不用 SendKeys / SendInput

全局键盘流会送给**当时拥有焦点的控件**。若窗口在检查与按键之间抢走焦点，文本就会进入别的应用。需求明确禁止把通用 Click/Type 面交给 Agent，因此 `send-keys` 通过 UI Automation 聚焦元素并用 `ValuePattern` 提交文本——**可按元素寻址且可验证**。

### 3. 写入必须回读

`set-value` / `send-keys` 在写入后**重新定位元素**（新句柄）并读取，只有观测值等于期望值才报告 `verified`。服务端对未通过校验的写入返回 `failed/verification-failed`，**绝不报成功**。

### 4. 空选择器被拒绝

空选择器等于"定位到任意第一个后代"，正是需求禁止的"点看起来对的那个"。服务端在探针运行前即拒绝。

### 5. 语义优先

`invoke-pattern` 优先 Invoke / SelectionItem 模式，不依赖屏幕坐标或焦点。

## 实机验证证据（本机，跳过非 Windows 时自动 skip）

| 测试 | 内容 |
|---|---|
| `uia.live.test.ts` | 真实枚举顶层窗口，返回有效 PID |
| `uia-binding.live.test.ts` | 进程基名无路径成分；读取真实控件树；缺失进程返回结构化错误 |
| `uia-write.live.test.ts` | 启动记事本 → 写入标记 → 回读确认；send-keys 替换与追加两种模式 |
| `server.live.test.ts` | 测试客户端 → 环回 IPC → BrokerPolicy → 真实 UIA → 真实数据 |
| `main.live.test.ts` | 以真实子进程启动 Broker：错误令牌被拒、正确令牌抵达真实 UIA、stdin 关闭后退出 |

另有非实机测试覆盖策略、协议、解析与失败路径。

## 未完成

| 项 | 说明 |
|---|---|
| 应用白名单接线 | BrokerClient 当前以**空白名单**创建：意味着所有进程操作都会被拒绝，直到用户配置允许的应用。这是有意的失败关闭默认值，但**尚未提供配置 UI / IPC** |
| `describe-element` / `wait-for-window` | 未实现 |
| 多显示器 / DPI / 多桌面 | 未验证（`BLOCKERS.md`） |
| 锁屏 / UAC 安全桌面 | 未验证；按设计应安全失败 |
| 任务级编排 | Broker 单次操作已可用；"一条任务跨多步并排队"尚未接入 |
