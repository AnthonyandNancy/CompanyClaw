# 通用测试夹具

需求 V5 §10.1 要求：**不能因为没有 QQ 账号或公司内网系统就停止通用能力开发**，因此
所有通用能力必须能在一个自建夹具上被反复验证。

## 桌面夹具

`CompanyClawTestApp.ps1` 是一个刻意做得「普通」的 WinForms 程序，覆盖需求点名的场景：

| 场景 | 控件（AutomationId） |
|---|---|
| 应用身份 | `FIXTURE_APP_NAME` |
| 标准 UIA 输入 | `FIXTURE_NAME_INPUT`（支持中文输入） |
| 语义按钮 | `FIXTURE_FIND_BUTTON` |
| 列表 | `FIXTURE_RESULT_LIST`（模拟联系人） |
| 草稿输入（无副作用） | `FIXTURE_MESSAGE_INPUT` |
| **最终提交点** | `FIXTURE_SEND_BUTTON`，只有点击这里才会产生副作用 |
| 副作用证据 | `FIXTURE_SEND_LOG` / `FIXTURE_SENT_RECIPIENT` / `FIXTURE_SENT_BODY` |
| 长列表滚动 | `FIXTURE_SCROLL_AREA`（200 行） |
| 自绘按钮（无原生 Invoke 模式） | `FIXTURE_CUSTOM_BUTTON` |
| 延迟出现的窗口（3 秒） | `FIXTURE_DELAYED_DIALOG` |
| 错误弹窗 | `FIXTURE_ERROR_DIALOG` |
| **拖拽接收区** | `FIXTURE_DROP_TARGET` / `FIXTURE_DROPPED_FILES` |

### 为什么使用 WinForms

它暴露**真实的 UI Automation 提供程序**（画布类程序不会），且**不需要任何 SDK**——
Windows 自带的 .NET Framework 即可运行，因此员工机器上也能复现这份证据。

### 副作用可观测

夹具里只有 `FIXTURE_SEND_BUTTON` 会产生副作用，并且必然留下 `FIXTURE_SEND_LOG` 文本。
于是「拒绝的动作没有真正执行」变成可断言的事实：日志为空，就是没有发送。

## 运行

```powershell
# 脚本版（无需编译）
powershell -ExecutionPolicy Bypass -File tools/testapp/CompanyClawTestApp.ps1

# 编译版（需要语义控件树时使用；csc.exe 来自 Windows 自带的 .NET Framework）
powershell -ExecutionPolicy Bypass -File tools/testapp/build-fixture.ps1
./tools/testapp/CompanyClawTestApp.exe

# 启动夹具 → 用真实 UIA 枚举并写值回读 → 输出 JSON → 关闭
powershell -ExecutionPolicy Bypass -File tools/testapp/run-fixture-and-check.ps1
```

## 实测结论（本机，2026-10-10）

```text
启动夹具 → Broker 自带的 find-elements.ps1 读取
WINDOW=CompanyClaw Test App
COUNT=220
```

窗口被发现、元素树被枚举出来，**但本会话中 WinForms 经 MSAA 桥接暴露**：控件类型为
`ControlType.Pane`、`automationId` 是句柄数字而不是控件 `Name`，因此按 AutomationId 定位不到
`FIXTURE_*` 控件。

这不是夹具缺陷，而正是需求要求如实处理的场景：

- **UIA 语义树不可用时必须走截图/视觉兜底**，不能宣布「该应用不支持」；
- 因此定位顺序（语义元素 → 控件层级 → 截图视觉 → 受控坐标）必须真实分层，本机复现的正是
  第二层与第三层之间的落差；
- 在语义树可用的会话（员工真实桌面 / 交互式登录会话）上，同一份夹具即可按 AutomationId
  精确寻址，**无需改动夹具**。

结论按需求记 `UNVERIFIED`：夹具本身可运行、可被发现、会被 Broker 探针读到；语义控件级的
点击/输入/回读需要交互式桌面会话实测，本机不宣称通过。

## Web 夹具

Web 侧使用仓库既有的浏览器与会话能力（`browser-adapter` + 已配置的 Edge），
需要的页面形态为：SPA 导航、表单提交、iframe、异步列表。
这些页面在开发环境按需搭建即可，**不属于本次交付的安装包内容**。
