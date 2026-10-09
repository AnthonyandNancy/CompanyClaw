# BLOCKERS

> **责任主体说明（V2，基线 `929a995`）**
>
> 本文件区分两类阻塞，处理方式完全不同：
>
> - **[构建方]**：开发/CI 构建环境缺件。由构建流程或 CI 解决，**绝不转化为员工安装前置要求**。
> - **[验证方]**：缺少外部账号、内网系统、目标机或签名证书。属于验收条件，保留 `BLOCKED`/`UNVERIFIED`。
>
> 员工侧的唯一要求是：安装一个 EXE → 配置个人大模型 → 微信扫码。任何"请员工先装 Node/Python/.NET SDK/Git/OpenClaw"的结论都判为不合格。

上游基线：`6f080a07f43bd65b8b27ec6f859438fc038bb912`
分支：`feat/companyclaw-foundation`
最后更新：2026-10-09（V3 收口后复核；所有解除条件未变化）

本文件记录**当前无法自行解决**的阻塞。每条包含：阻塞内容、复现/证据、影响范围、解除条件。
未被本文件记录的项不得以"环境限制"为由跳过。

---

## B1｜无微信测试账号（阻塞核心验收）

- **阻塞**：微信扫码绑定、消息收发、审批卡片、文件回传的**真实**验证。
- **证据**：本机未绑定任何微信账号；`plugins/openclaw-weixin` 为 vendored 官方包，需真实扫码。
- **影响**：E03、E04、E11、E14；裁决专项 S1、S6（微信侧）、S7；P3 实机部分；P7 微信审批闭环；"微信 → Gateway → Broker → UIA"整链路（P0-C V1）。
- **解除条件**：提供可用于测试的微信账号（可扫码），或公司提供测试用微信身份。
- **不得替代**：Mock 或模拟消息不得标记为 PASS；相关项只能记 `BLOCKED` 或 `UNVERIFIED`。

## B2｜无内网业务系统与脱敏测试数据（阻塞核心验收）

- **阻塞**：R2 业务写入路径、浏览器自主操作、回读验证的真实验证。
- **证据**：无可访问的内网测试站点与脱敏数据。
- **影响**：E05、E06、E07、E10；S2；P4 全部；R2 端到端。
- **解除条件**：提供测试环境地址、测试账号、脱敏数据与可用于写入的测试记录。
- **不得替代**：不得对生产系统做修改型测试。

## B3｜无 GitHub 登录权限（阻塞 §10-1）

- **阻塞**：公司专用 Fork 的建立与推送。
- **证据**：`gh` 命令不存在（`gh: command not found`）；`git remote -v` 仍指向上游 `microsofthackathons/MicroClaw`。
- **影响**：§10 第 1 项；上游同步与 PR 流程。
- **解除条件**：提供 GitHub 凭据与建仓权限，或指明公司内部 Git 托管地址。
- **当前处理**：按裁决 Q3 第 6 条，以本地克隆 + 分支 `feat/companyclaw-foundation` 继续，不中断本地工作。

## B4｜无 .NET SDK（阻塞 MXC 构建与 .NET 方案 Broker）

- **阻塞**：`appcontainer`（net9.0-windows）与 `windows-node-host`（net10.0-windows）的编译。
- **证据**：`dotnet --list-sdks` 无输出；仅存在 runtime `8.0.27`；`dotnet --version` 报 "The application '--version' does not exist"。
- **影响**：`windows-node-host` 无法构建 → MXC 路径无法回归验证（基线 A 相关项）；若 Broker 选 .NET 亦受阻。
- **责任主体**：**[构建方]** —— 构建机/CI 需要 .NET SDK 才能 `dotnet publish`。
- **解除条件**：构建机安装 .NET SDK（工作负载见 `windows-node-host`/`appcontainer` 目标框架）。
- **规避**：Broker 采用 Node.js 实现可绕过此阻塞（Node v26.7.0 已具备），且 .NET 产物以 `--self-contained -p:PublishSingleFile=true` 发布，**员工机器永不需要 .NET 运行时或 SDK**。
- **对员工的影响**：无。MXC 组件预编译进包，员工不需要任何 .NET 组件。

## B5｜上游子模块未初始化

- **阻塞**：`windows-node-host` 编译（依赖 `third_party/openclaw-windows-node/source`）。
- **证据**：`git submodule status` → `-fc9add75eda78daf548d80a55ffb64e63b159961`（前缀 `-` 表示未 checkout）。
- **影响**：MXC 路径构建与回归（基线 A）。
- **责任主体**：**[构建方]** —— 构建流程须自动初始化子模块（`build.ps1` 已含该步骤）。
- **解除条件**：`git submodule update --init --recursive`（需网络访问 github.com/openclaw/openclaw-windows-node）。
- **状态**：已解除。开发机验证可初始化（`fc9add75eda78daf548d80a55ffb64e63b159961`），V3 基线与本轮执行时 `git submodule status` 均显示已 checkout。
- **对员工的影响**：无。发行包内不含仓库或子模块，员工不需要 Git。

## B6｜无代码签名证书（阻塞安装包交付）

- **阻塞**：§10-2 要求的签名状态可核验。
- **影响**：§10 第 2 项；P11 发布。
- **责任主体**：**[发布方]** —— 不阻塞内部试用包产出。
- **解除条件**：提供公司代码签名证书，或明确接受"未签名 + SHA-256 + 构建配方"的交付形式（产物上必须明示未签名）。
- **对员工的影响**：安装时可能出现 SmartScreen 提示；不影响功能。

## B7｜非管理员会话（限制实测范围，不改设计）

- **责任主体**：**[验证方]** —— Per-User 正是目标设计，本机非管理员并不阻塞它。

- **阻塞**：安装器 Per-User 化后的真实安装/卸载验证；Defender 相关验证。
- **证据**：当前进程 `IsAdmin=False`；系统为中文 Windows 11 专业版（`10.0.26100`）。
- **影响**：E01、E19；S4、S8；P10 验收。
- **解除条件**：提供普通员工账号的目标机（本机管理员权限可作对照）。
- **注**：非管理员身份本身符合"最终验收必须使用普通用户账号"的要求，但安装器改写与卸载验证需要可控的测试环境。

## B8｜本机无 OpenClaw 运行时（阻塞 dev 客户端完整运行）

- **阻塞**：dev 模式下 Gateway 的启动与联调。
- **证据**：`resolveOpenClawEntry()` 的全部候选路径均 missing（`~/.openclaw-node/...`、`%APPDATA%/npm/...`、`%ProgramFiles%/nodejs/...`、`%LOCALAPPDATA%/Programs/nodejs/...`）；PATH 中无 `openclaw`；`npm ls -g` 仅含 pi-coding-agent / npm / pnpm。
- **影响**：dev 客户端可启动 UI，但无法连接 Gateway；所有依赖 Gateway 的功能不可用。
- **解除条件**：`npm install openclaw@2026.9.3` 到 `~/.openclaw-node`（镜像可用，已确认该版本存在）。

## B9｜无微信/内网环境下的 E01–E20 与 S1–S9

- **阻塞**：实施书 §6 的 E01–E20 矩阵与裁决新增的 S1–S9 专项。
- **影响**：§10 第 13 项；内部试点版门槛；正式交付版门槛。
- **当前处理**：全部记 `BLOCKED` / `UNVERIFIED`，**不得**以逻辑层测试代替；`docs/companyclaw/evidence/` 在获得真实证据前保持为空。

---

## 阻塞汇总对交付的影响

| §10 项 | 受影响阻塞 |
|---|---|
| 1 公司 Fork | B3 |
| 2 安装包签名 | B6 |
| 3 无依赖首次运行 | B4/B5（**[构建方]**，须在构建阶段解决）、B7（实测范围） |
| 5 微信真实可用 | B1 |
| 6 Browser 自主操作 | B2 |
| 7 Windows UIA | B4/B5（**[构建方]**） |
| 8 混合任务 | B1、B2 |
| 10 异常提示 | B1、B2 |
| 13 E01–E20 | B1、B2、B6、B7、B9 |
| 14 手册 | 无（可离线完成） |

**可离线完成、不受阻塞的项**：统一资源流水线、Broker 生产启动、首次运行初始化、任务中心与向导、微信桥接、文档体系（§8）、安全内核接线、Broker 主体、UIA 执行器。

**本轮（V2 自包含安装）已解决的构建方阻塞**：B5（子模块已可自动初始化）。**仍未解决的构建方阻塞**：B4（需构建机 .NET SDK）——它只影响 `dotnet publish`，不影响员工侧任何步骤。

---

## V3 收口后的复核（2026-10-09）

V3 收口（计划见 `docs/superpowers/plans/2026-10-09-companyclaw-v3-closure.md`）把此前"策略层完备但无生产调用方"的缺口
接成了真实通路，但**没有解除任何一条外部阻塞**。逐条复核：

| 阻塞 | V3 后状态 | 说明 |
|---|---|---|
| B1 无微信测试账号 | 未解除 | 插件安装、可信来源、审批回复、文件回传均已实现并有单测；真实扫码/收发/收件仍未验证 |
| B2 无内网系统与脱敏数据 | 未解除 | 受控 Browser 适配器与 Broker 执行通路已实现；真实站点导航、业务写入与回读仍未验证 |
| B3 无 GitHub 登录权限 | 未解除 | 与 V3 无关 |
| B4 无 .NET SDK | 未解除 | 仍在 `dotnet publish` 处中止流水线；**注意**：这不是员工侧要求，构建机装 SDK 即可 |
| B5 子模块未初始化 | **已解除** | V3 基线与执行时均已 checkout |
| B6 无代码签名证书 | 未解除 | 正式推广前必须解决；当前产物应标注"未签名技术预览" |
| B7 非管理员会话（缺目标机） | 未解除 | 需普通员工账号的清洁机做安装/卸载实测 |
| B8 本机无 OpenClaw 运行时 | 未解除 | 仅影响 dev 模式联调，不影响打包态设计（打包态用包内 `openclaw.asar`） |
| B9 无微信/内网环境下的 E 矩阵 | 未解除 | PKG-01–10 与 E01–20 状态见 `docs/companyclaw/v3/06-release-evidence.md`；本机可通过的仅开发构建级证据 |

**V3 新增的一项构建方待办**：完整 payload 的 hash 校验（PKG-02）从未在端到端构建上实跑过——因为流水线在 B4 处中止。
构建机具备 .NET SDK 后应首先验证：完整装配产出 → 安装 → 启动时 manifest 校验通过。
