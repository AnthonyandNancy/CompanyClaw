# Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`（本仓库既有惯例，见 `docs/superpowers/plans/2026-10-09-companyclaw-v3-closure.md`）。执行中若发现影响范围扩大或本 Plan 不准确，必须先输出 **Plan Adjustment** 并停下等待确认。

- 计划文件：`docs/superpowers/plans/2026-10-09-companyclaw-v3-production-startup-implementation-plan.md`
- 代码基线：`feat/companyclaw-foundation` / `9e01612497c7f4e85bf9599a883042d550a38bad`
- 需求来源：本轮"CompanyClaw V3.0 生产启动链路专项核查与修复"（10 条要求 + 1 条验收要求）
- 前置已完成：需求确认 → 代码调查 → Impact Map → Mini Plan（见对话记录，本文件是其正式化落地）
- 责任主体标注沿用 `BLOCKERS.md`：**[构建方]** 由构建机/CI 解决；**[验证方]** 记 `BLOCKED`/`UNVERIFIED`。

---

## 1. Goal

### 1.1 本次修改目标

把"截图里的启动失败"变成**真实原因可见 + 生产路径自包含**：

1. 修掉 `resolveNodePath()` 在无标准安装位时返回裸命令名 `"node"` 的行为（该值与 `fs.existsSync()` 天然冲突，是截图"服务启动失败"的直接上游）。
2. 打包态只允许使用安装包自带的私有运行时（`resources/node.exe` + `resources/openclaw.asar` + `resources/runtime-manifest.json`），缺件时**报出缺失路径与阶段**，不再回退系统 Node / 全局 npm / `%USERPROFILE%\.openclaw-node`。
3. 把"解压 → 校验 → 进程创建 → 鉴权连接 → 健康检查"逐阶段上抛可诊断结果，使"服务启动失败，请重试"背后始终有具体阶段与原因。
4. 构建期 `.NET SDK` 缺失给出显式、可执行的构建机提示（员工侧永不涉及）。
5. 旧手工脚本 `start-gateway.cmd` 的无范围 `taskkill /F /IM node.exe /T` 做安全收口。
6. 如实记录 `BLOCKED/UNVERIFIED`，不以单测/静态检查冒充完成。

### 1.2 不包含（明确排除）

- 不改 `desktop/src/companyclaw/**` 的 Broker / Browser / 微信 / 安全策略 / 任务系统（需求第 10 条：保留、不重复开发）。
- 不改 `CompanyClawRuntime` 的授权判定、票据、R2/R3 策略。
- 不重做 `bundled-runtime.ts` 的 asar 解压策略与 `runtime-manifest.ts` 的校验契约（只在调用点补诊断）。
- 不改 `nsis` 的 `perMachine/allowElevation/oneClick/shortcutName`；不改 `extraResources` 的组成。
- 不删除任何文件（含 legacy `start-gateway.cmd`、`installer/microclaw-setup.nsi`、`deployer/**`、`gateway-manager.ts`）。
- 不升级/降级 OpenClaw 版本（锁定 `2026.9.3`）、不改 `electron-builder` 版本。
- 不修 `%USERPROFILE%\.openclaw-node` 的 dev 布局候选（dev 环境合法布局，仅打包态排除）。
- 不处理工作区既有未提交改动（dev 端口 5173→5174：`desktop/src/main.ts:2737`、`desktop/renderer/index.html`、`desktop/renderer/vite.config.ts`）。

### 1.3 成功标准

| # | 标准 | 判定证据 |
|---|---|---|
| S1 | 打包态 `resolveNodePath()` 永不返回系统 Node / 裸命令名 | 新增单测：`app.isPackaged=true` + `~/.openclaw-node/node.exe` 存在 → 仍只认 `resources/node.exe` |
| S2 | 打包态缺件时报出**缺失路径**，不出现 `.openclaw-node` 字样 | 单测 + 代码检索 `desktop/src/main.ts` 无 `.openclaw-node` 提示文案 |
| S3 | 启动失败日志带阶段标签 | 运行日志含 `[stage=resolve-runtime|extract-runtime|verify-manifest|spawn|auth|health]` |
| S4 | 开发态在本机（PATH 上仅有 nvm node）可正确解析出绝对 `node.exe` 路径 | `resolveNodePath()` 单测 + 实机启动日志 `[stage=resolve-runtime] node=<绝对路径>` |
| S5 | `.NET SDK` 缺失时构建脚本给出明确构建机提示并退出 | 手工运行 `powershell -File build.ps1` 的**首个**失败输出 |
| S6 | `start-gateway.cmd` 不再包含 `taskkill /IM node.exe` | 文件内容检索 |
| S7 | 全量单测/typecheck/lint 不回归 | `npx vitest run`、`npx tsc --noEmit`、`npm run lint` |
| S8 | 未完成项如实标注 | `BLOCKERS.md` / `docs/companyclaw/v3/06-release-evidence.md` 更新，NSIS 生产包与干净机验收记 `BLOCKED` |

**验收要求（需求原文）在本机的可达性**：本机无 `.NET SDK`（`dotnet --list-sdks` 空输出，仅 runtime 8.0.27），无法 `dotnet publish net9.0-windows/net10.0-windows` → `npm run release:win` 会在 `prepare-windows-node-resources.mjs` 处失败 → **无法产出 NSIS 安装包**。因此"员工双击安装包 → 自动启动 Gateway → 进入模型配置与微信扫码页"只能记 `BLOCKED`（解除条件：构建机装 .NET SDK + 提供干净中文 Win11 普通账号机）。本 Plan 的验证上限是 S1–S7 + 开发态启动实测。

---

## 2. Current Understanding

### 2.1 当前实现方式（已核实，含行号）

| 关注点 | 位置 | 现状 |
|---|---|---|
| 私有 Node 解析 | `desktop/src/path-resolver.ts:90-134` | 候选顺序：`resources/node.exe`(打包) → `OPENCLAW_NODE_DIR` → `~/.openclaw-node/node.exe` → `Program Files/nodejs` → `LocalAppData/Programs/nodejs` → **裸 `"node"`**；只有绝对路径才 `existsSync`，裸名直接交回调用方 |
| OpenClaw 入口解析 | `desktop/src/path-resolver.ts:136-190` | 打包态 `resolveBundledOpenClawDir()`；否则 `.openclaw-node`（classic/lib）→ `%APPDATA%/npm` → Program Files/LocalAppData；**无命中时返回 `candidates[0]`（不存在的路径）** |
| asar 物化 | `desktop/src/bundled-runtime.ts:44-52` | 断网安全：解压到 `userData/runtime/openclaw`，靠 `.microclaw-version` 幂等；缺 asar 返回 `null` |
| 清单校验 | `desktop/src/companyclaw/runtime-manifest.ts:56-115` | 逐条 `existsSync` + sha256；问题以字符串数组返回 |
| 清单元数据上报 | `desktop/src/main.ts:1525-1551`（`reportRuntimeIntegrity`） | 仅打包态执行，写 `runtimeManifestProblems/Checked`，只发 `gateway:log` |
| 启动主流程 | `desktop/src/main.ts:3580-3610`（`startGateway`→`startGatewayInner`） | 单函数串行执行全部阶段，失败分支各自 `setGatewayStatus("failed")` |
| 解析+守卫 | `desktop/src/main.ts:3652-3660`、`3873-3898` | `resolveNodePath()` 带 try/catch；`resolveOpenClawEntry()` **无** try/catch；两个守卫用 `fs.existsSync()` 判断并输出 `.openclaw-node` 提示 |
| 进程创建 | `desktop/src/main.ts:4075-4084` | `spawn(nodePath, [entry,"gateway","run","--port",P,"--bind","loopback","--allow-unconfigured"], {stdio:["ignore","pipe","pipe","ipc"]})` |
| 健康检查 | `desktop/src/main.ts:2893-2907`、`4488-4530` | `waitForGatewayReady(port, 300_000)`；失败 → `setGatewayStatus("timeout")`；退出码 78 特殊处理 |
| 失败状态消费 | `desktop/src/main.ts:493-499`（`setGatewayStatus`）→ `gateway:status` IPC → `desktop/renderer/src/App.vue:566` → `GatewayLoading.vue:275`（`gateway.failed` 文案） | 15 处 `setGatewayStatus("failed")` 全部折叠成同一句文案 |
| 错误详情消费 | `stores/gateway.ts:19-23`（`lastError` 取最后一条 `[error]/[warn]/[hint]`）→ `App.vue:11` → `GatewayLoading.vue:93` | 只能显示**最后一行**，因此阶段标签必须与原因同行输出 |
| 健康报告 | `desktop/src/companyclaw/guardian.ts:91-99`、`main.ts:1651-1686`（`collectGuardianProbes`） | `gateway-process` detail 恒为 `Gateway <status>`，无原因 |
| 旧手工脚本 | `start-gateway.cmd:10/17/30` | 硬编码 `%USERPROFILE%\.openclaw-node\node.exe`，启动前 `taskkill /F /IM node.exe /T`；**不在 NSIS payload**（`files:`/`extraResources` 未包含仓库根） |
| 构建入口 | `build.ps1:124-160`（Step1 `dotnet publish`）、`desktop/scripts/prepare-windows-node-resources.mjs:105-128/130-155`（两次 `dotnet publish`） | 3 处硬依赖 `dotnet`；无 SDK 预检，失败信息为 `exit code` 或裸 `exit` |
| 产物命名 | `desktop/electron-builder.yml:25-40`（无 `nsis.artifactName`） | 实际产出 `CompanyClaw Setup 1.0.0.exe`；文档与 `build.ps1:262/496` 均写 `CompanyClaw-Setup-<version>-x64.exe` |

### 2.2 涉及模块

- 主进程装配层：`desktop/src/main.ts`
- 路径解析：`desktop/src/path-resolver.ts`
- 运行资源契约：`desktop/src/bundled-runtime.ts`、`desktop/src/companyclaw/runtime-manifest.ts`（只读调用）
- 健康报告：`desktop/src/companyclaw/guardian.ts`
- 构建：`build.ps1`、`desktop/scripts/prepare-windows-node-resources.mjs`、`desktop/electron-builder.yml`
- 旧脚本：`start-gateway.cmd`
- 测试：`desktop/src/path-resolver.test.ts`、`desktop/src/companyclaw/guardian.test.ts`、`desktop/src/companyclaw/extra-resources-contract.test.ts`（回归）
- 文档：`BLOCKERS.md`、`docs/companyclaw/v3/06-release-evidence.md`

### 2.3 数据流 / 调用链（修复后目标形态）

```
app.whenReady
 └ startApplicationServices()                       main.ts:1688
    ├ ensureCompanyClawFirstRunConfiguration()      写 gateway.auth.token/port（首次运行）
    ├ reportRuntimeIntegrity()                      打包态校验 manifest（stage=verify-manifest 数据源）
    ├ ensureWeixinPluginAvailable()                 需要 node+entry（解析失败只 warn，不阻断）
    └ startGateway()                                 main.ts:3580
       └ startGatewayInner()                         main.ts:3610
          [stage=resolve-runtime]  resolveNodePath() / resolveOpenClawEntry()
          [stage=extract-runtime]  resolveBundledOpenClawDir()（asar → userData/runtime/openclaw）
          [stage=spawn]            spawn(私有 node, openclaw.mjs gateway run …)
          [stage=auth]             gatewayToken 是否配置 → connectGatewayWs()
          [stage=health]           waitForGatewayReady(18789, 300s)
          ├ 成功 → setGatewayStatus("running") → gateway:service-ready
          └ 失败 → reportGatewayFailure(stage, reason) → gateway:log("[error][stage=…] …")
                                            → gateway.status=failed → GatewayLoading 显示真实原因
                                            → collectGuardianProbes().gatewayFailureStage/Reason → Guardian
```

### 2.4 已确认的影响范围

- **直接修改**：`path-resolver.ts`、`main.ts`（启动段）、`guardian.ts`、`build.ps1`、`prepare-windows-node-resources.mjs`、`electron-builder.yml`、`start-gateway.cmd`、上述 2 个测试文件、2 个文档。
- **关联检查（只读）**：`gateway-manager.ts`（仅被自身测试引用的死代码）、`tool-sandbox.ts:89`、`appcontainer/sandbox-state.js:71`、`appcontainer/provision-appcontainer.ps1:80-88`（`.openclaw-node` 只读兼容，`existsSync` 后才授予 → 行为安全）、`bundled-windows-node-host.ts`（按 PID kill，安全）。
- **确认无需修改**：`desktop/src/companyclaw/**` 业务模块、`desktop/renderer/**`（除 i18n 无需改）、`broker/**`、`plugins/**`、`deployer/**`、`installer/microclaw-setup.nsi`、`appcontainer/**` 运行时代码。

### 2.5 需求与代码不一致（只记录，不擅自降级需求）

1. **产物名**：需求/文档/`build.ps1` 期望 `CompanyClaw-Setup-<version>-x64.exe`，实际 builder 默认产出 `CompanyClaw Setup <version>.exe`。→ 见 §3 Step 6，**待裁决项 A**。
2. **`.openclaw-node` 兼容**：需求要求不依赖，代码仍有 6 处引用（见 2.4）。→ 处置策略见 Step 1/Step 7，**待裁决项 B**。
3. **能力与验证条件**：需求第 8 条（真 NSIS 生产包 + 干净中文 Win11 普通账号实测）超出本机条件（无 .NET SDK / 无目标机 / 无签名证书）→ 记 `BLOCKED`。

---

## 3. Implementation Steps

> 通用约束（每一步都适用）：先备份到 `backups/`（`main.ts`、`path-resolver.ts`、`guardian.ts`、`build.ps1`、`electron-builder.yml`、`prepare-windows-node-resources.mjs`、`start-gateway.cmd`）；只改本 Plan 列出的文件；不顺手重构；每步结束跑该步 Verification；每步一次提交，提交信息说明原因、影响文件、测试证据、是否改变公开接口。

### Step 1 — 打包态私有运行时独占解析（`path-resolver.ts`）

#### Target

- 文件：`desktop/src/path-resolver.ts`
- 函数：`resolveNodePath()`（90-134）、`resolveOpenClawEntry()`（136-190）、新增内部助手 `resolveExecutablesOnPath(name)`
- 测试：`desktop/src/path-resolver.test.ts`

#### Current Behavior

- `resolveNodePath()`：`app.isPackaged` 时 `resources/node.exe` 只是**首选**，缺失/版本不符会继续回退 `~/.openclaw-node` → 系统 Node；全部候选不可用时**返回裸字符串 `"node"`**。
- 调用方 `main.ts:3874` 用 `fs.existsSync(nodePath)` 判断 → `existsSync("node")` 恒为 `false` → 报 `node.exe not found at node` + `.openclaw-node` 提示 → 渲染层"服务启动失败，请重试"。
- `resolveOpenClawEntry()`：打包态 `resolveBundledOpenClawDir()` 返回 `null` 时继续走系统候选，最终返回**不存在的** `candidates[0]`。

#### Change

1. `resolveNodePath()` 顶部增加打包态独占分支（放在覆盖/候选逻辑之前）：

```ts
export function resolveNodePath(): string {
  if (app.isPackaged) {
    // The installer ships the only runtime this product validated. A packaged
    // build must never fall back to a system Node, a global npm install or the
    // legacy ~/.openclaw-node layout: those make "works on the build machine"
    // indistinguishable from "works for an employee".
    const bundled = path.join(process.resourcesPath, "node.exe");
    if (!fs.existsSync(bundled)) {
      throw new Error(
        `安装包内置的私有 Node 运行时缺失（${bundled}）。请重新运行 CompanyClaw 安装包执行修复安装；无需手动安装 Node.js 或其他组件。`,
      );
    }
    let version: string;
    try {
      version = execFileSync(bundled, ["--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 5_000,
      }).trim();
    } catch (error) {
      throw new Error(
        `安装包内置的 Node 运行时无法执行（${bundled}）：${
          error instanceof Error ? error.message : String(error)
        }。请重新运行 CompanyClaw 安装包执行修复安装。`,
      );
    }
    if (!isSupportedNodeVersion(version)) {
      throw new Error(
        `安装包内置的 Node ${version} 不在支持范围（>=24.16.0 <25 || >=26.1.0）。安装包已损坏或版本不匹配，请重新运行 CompanyClaw 安装包执行修复安装。`,
      );
    }
    return bundled;
  }
  // …（以下为既有开发态候选逻辑）
```

2. 开发态保留原有候选顺序（`OPENCLAW_NODE_DIR` → `~/.openclaw-node` → Program Files → LocalAppData），把末位裸 `"node"` 换成本机 PATH 上的绝对路径列表，并**删除裸名返回值**：

```ts
  const candidates = [
    path.isAbsolute(override) ? path.join(override, "node.exe") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".openclaw-node", "node.exe") : "",
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe")
      : "",
    // Never return a bare command name: callers check the value with
    // fs.existsSync(), which is always false for "node".
    ...resolveExecutablesOnPath("node"),
  ];
```

3. 新增助手（放在 `resolveNodePath` 之前）：

```ts
/**
 * Every `node` (or `node.exe`) found on PATH, as absolute paths, in PATH order.
 *
 * `execFileSync("node", …)` works but `fs.existsSync("node")` does not, so a
 * bare command name can never be handed to a caller that verifies the file.
 */
function resolveExecutablesOnPath(name: string): string[] {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  const found: string[] = [];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (fs.existsSync(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}
```

4. 收尾错误文案改为"构建/开发机"语义（保留版本范围断言）：

```ts
  throw new Error(
    "本机找不到可用的 Node.js 运行时（开发/构建环境需要 Node >=24.16.0 <25 || >=26.1.0）；" +
      "员工机器不需要安装 Node.js —— 正式版使用安装包内置的私有运行时。",
  );
```

5. `resolveOpenClawEntry()` 顶部增加打包态独占分支：

```ts
export function resolveOpenClawEntry(): string {
  if (app.isPackaged) {
    // materializeRuntimeArchive() throws when the archive is unreadable; a
    // missing archive means the installer payload is incomplete.
    const bundledRoot = resolveBundledOpenClawDir();
    if (!bundledRoot) {
      throw new Error(
        `安装包内置的 OpenClaw 运行资源缺失（${path.join(process.resourcesPath, "openclaw.asar")}）。` +
          "请重新运行 CompanyClaw 安装包执行修复安装；无需手动安装 OpenClaw 或 npm。",
      );
    }
    return path.join(bundledRoot, "node_modules", "openclaw", "openclaw.mjs");
  }
  // …（以下为既有开发态候选逻辑，保持不变）
```

#### Reason

- S1/S2/S4：裸 `"node"` 是截图现象的直接上游（本机 `~/.openclaw-node` 为空、无标准 node 安装位、仅有 nvm PATH node → 必然命中该分支）。
- 需求第 4 条：正式版只使用安装包自带运行时，不依赖系统 Node/全局 npm/`.openclaw-node`。

#### Risk

- 打包态若包内缺件，从"误用系统 Node 后失败"变为"立即明确失败"——这是期望行为，但**必须与 Step 5 的产物完整性同批交付**，否则会把"能跑但用错运行时"变成"必然启动失败"。
- `resolveNodePath()` 的其它调用点（`main.ts:1573/1712/5424/5878/8245`、`gateway-manager.ts:104`）在打包态缺件时会抛错：`1573`（微信插件安装）已有 try/catch；`8245`（CompanyClaw IPC 注册）在既有 try/catch 内会打印 `[companyclaw] Failed to register security-core IPC: …`；`1712`（Copilot 认证）在 IPC 处理器内，抛错表现为该 IPC 拒绝。均为"缺件即失败"的正确表现，不新增处理。
- 开发态 PATH 候选可能命中 `.cmd` 垫片（如 npm 生成的 shim）导致 `execFileSync` 失败：既有循环会 `warn` 后 `continue` 到下一个候选，不会误报为可用。

#### Verification

```bash
cd desktop
npx vitest run src/path-resolver.test.ts
npx vitest run src/path-resolver.test.ts src/bundled-runtime.test.ts
npx tsc --noEmit
```

预期：新增/更新用例全绿（Step 9 的用例清单）；`tsc` 无错误。

---

### Step 2 — 启动阶段化诊断（`main.ts`）

#### Target

- 文件：`desktop/src/main.ts`
- 函数/区域：模块级状态（`495-510` 一带）、`startGatewayInner()`（`3610`）、解析段（`3652-3660`）、锁清理与守卫段（`3861-3898`）、spawn 段（`4075-4135`）、健康检查段（`4488-4535`）
- 测试：新增 `desktop/src/gateway-startup-diagnostics.test.ts`

#### Current Behavior

- 失败原因只以散落的 `[error]/[hint]` 行发送，渲染层只显示**最后一行**。
- 节点缺失提示写死 `.openclaw-node`；入口缺失提示同族。
- `resolveOpenClawEntry()` 无 try/catch；asar 解压抛错会冒到 `startApplicationServices().catch`（`main.ts:8399`），窗口只看到统一"服务启动失败"。
- spawn 阶段的真实 stderr 在健康检查分支里只以 `[warn] Gateway health check timed out` 呈现。

#### Change

1. 模块级新增（紧邻 `runtimeManifestProblems` 变量，`main.ts:503` 附近）：

```ts
/** Startup stage that failed last, e.g. "resolve-runtime"; null once healthy. */
let gatewayFailureStage: string | null = null;
/** Human-readable cause for that stage, in the same order the user sees it. */
let gatewayFailureReason: string | null = null;

/**
 * Reports one failed startup stage, cause first.
 *
 * The loading screen shows only the last log line, so the stage tag and the
 * reason travel on the same line instead of being split across a hint.
 */
function reportGatewayFailure(stage: string, reason: string, hint?: string): void {
  gatewayFailureStage = stage;
  gatewayFailureReason = reason;
  const line = `[error][stage=${stage}] ${reason}`;
  console.error(line);
  mainWindow?.webContents.send("gateway:log", line);
  if (hint) mainWindow?.webContents.send("gateway:log", `[hint] ${hint}`);
  setGatewayStatus("failed");
}
```

2. 解析段（`3652-3660`）改为阶段包裹：

```ts
  let nodePath: string;
  try {
    nodePath = resolveNodePath();
  } catch (error) {
    reportGatewayFailure(
      "resolve-runtime",
      error instanceof Error ? error.message : String(error),
      "正式版使用安装包内置的私有运行时；请重新运行 CompanyClaw 安装包执行修复安装，无需手动安装任何组件。",
    );
    rollbackStartupAgentSkills();
    throw error;
  }
  mainWindow?.webContents.send("gateway:log", `[info][stage=resolve-runtime] node=${nodePath}`);
  let entryPath: string;
  try {
    entryPath = resolveOpenClawEntry();
  } catch (error) {
    reportGatewayFailure(
      "extract-runtime",
      error instanceof Error ? error.message : String(error),
      "内置 OpenClaw 资源（openclaw.asar）解压或校验失败；请重新运行 CompanyClaw 安装包执行修复安装。",
    );
    rollbackStartupAgentSkills();
    throw error;
  }
  mainWindow?.webContents.send("gateway:log", `[info][stage=resolve-runtime] entry=${entryPath}`);
```

3. 两个 `fs.existsSync` 守卫改为"缺件即报真实路径"（删除 `.openclaw-node` 字样）：

```ts
    if (!fs.existsSync(nodePath)) {
      reportGatewayFailure(
        "resolve-runtime",
        `安装包内置的私有 Node 运行时不可用：${nodePath}`,
        "请重新运行 CompanyClaw 安装包执行修复安装；无需手动安装 Node.js。",
      );
      rollbackStartupAgentSkills();
      return;
    }
    if (!fs.existsSync(entryPath)) {
      reportGatewayFailure(
        "extract-runtime",
        `内置 OpenClaw 入口文件不可用：${entryPath}`,
        "请重新运行 CompanyClaw 安装包执行修复安装；无需手动安装 OpenClaw 或 npm。",
      );
      rollbackStartupAgentSkills();
      return;
    }
    if (app.isPackaged) {
      if (runtimeManifestProblems.length > 0) {
        mainWindow?.webContents.send(
          "gateway:log",
          `[warn][stage=verify-manifest] 运行资源校验未通过：${runtimeManifestProblems.join("; ")}`,
        );
      } else if (runtimeManifestChecked !== null) {
        mainWindow?.webContents.send(
          "gateway:log",
          `[info][stage=verify-manifest] 运行资源完整（已校验 ${runtimeManifestChecked} 项）`,
        );
      }
    }
```

4. spawn 前打印完整阶段信息，并在 `error`/退出分支带上原因（`4110-4135`、`4488-4535`）：

```ts
    mainWindow?.webContents.send(
      "gateway:log",
      `[info][stage=spawn] node=${nodePath} entry=${entryPath} port=${configuredPort} stateDir=${stateDir} auth=${
        gatewayToken ? "configured" : "missing"
      }`,
    );
```

`child.on("error")` 分支内把 `safeSendLog` 换成阶段上报（保留原日志）：

```ts
      reportGatewayFailure(
        "spawn",
        `Gateway 进程创建失败：${err.message}（node=${nodePath}）`,
        "若为“文件不存在/拒绝访问”，请重新运行 CompanyClaw 安装包执行修复安装。",
      );
```

健康检查失败分支（`4506-4530` 一带）在保留既有 retry 逻辑的前提下补原因：

```ts
      const stderrTail = startupStderr.trim().split(/\r?\n/).slice(-10).join("\n");
      const cause =
        child.exitCode !== null
          ? `Gateway 进程在启动阶段退出（exit=${child.exitCode}）`
          : `Gateway 健康检查超时（port=${configuredPort}，等待 ${GATEWAY_READY_TIMEOUT_MS}ms）`;
      reportGatewayFailure(
        "health",
        `${cause}；node=${nodePath} entry=${entryPath}${stderrTail ? `；最近日志：\n${stderrTail}` : ""}`,
        "可在“设置 → 日志”导出完整启动日志用于排查。",
      );
```

（该分支原有的 `setGatewayStatus("timeout")` 改为不调用；`reportGatewayFailure` 已置 `failed`，`GatewayLoading.vue:177` 对 `failed` 与 `timeout` 一视同仁，重试按钮行为不变。）

5. 成功路径清除阶段标记（`4494-4500` 的 `if (ready)` 内）：

```ts
        gatewayFailureStage = null;
        gatewayFailureReason = null;
```

6. `setGatewayStatus("starting")` 之前补一条 `[info][stage=auth] auth=…`，并在 `connectGatewayWs()` 的 `onAuthError`（`4756-4770`）内追加：

```ts
      gatewayFailureStage = "auth";
      gatewayFailureReason = `网关鉴权失败（token 不匹配）：${message}`;
```

#### Reason

- 需求第 5 条：逐阶段记录可诊断结果，不能把全部异常统一显示为"服务启动失败"。
- 需求第 2 条追踪结论：截图文案来自 `main.ts:3880` 与 `i18n/zh-CN.ts:514`，必须消除前者对 `.openclaw-node` 的误导，同时让后者背后有真实原因。

#### Risk

- `reportGatewayFailure` 内含 `setGatewayStatus("failed")`，若误加在"非致命"分支会造成假失败：只在解析/解压/缺件/spawn/健康检查/auth 六类终态调用。
- `GatewayLoading.vue:177` 的 `isFailed` 同时接受 `timeout`；本步把健康超时从 `timeout` 改为 `failed` 属同类展示，但 `desktop/renderer/src/components/GatewayLoading.test.ts` 若断言 `timeout` 文案需回归（Step 9 检查）。
- 改动集中在 `startGatewayInner`，MXC 分支（`requestedState`/`locked`）不改，避免触碰安全模式语义。

#### Verification

```bash
cd desktop
npx vitest run src/gateway-startup-diagnostics.test.ts src/startup-order.test.ts
npx tsc --noEmit
npm run lint
```

预期：新增用例证明 `reportGatewayFailure` 输出含 `[stage=`；`startup-order.test.ts`（断言 `verifySkillIntegrity` → `startApplicationServices` → `loadFile` 顺序的**子串**存在性）仍绿。

---

### Step 3 — 健康报告带上失败阶段与原因（`guardian.ts` + `collectGuardianProbes`）

#### Target

- 文件：`desktop/src/companyclaw/guardian.ts`（`GuardianProbes` 57-70、`gateway-process` 项 91-99）
- 文件：`desktop/src/main.ts`（`collectGuardianProbes()` 1651-1686）
- 测试：`desktop/src/companyclaw/guardian.test.ts`

#### Current Behavior

- `GatewayProbes` 无失败原因字段；`gateway-process` detail 恒为 `Gateway <status>`。
- 首启向导（`desktop/renderer/src/views/SetupWizard.vue:26-40`）与 `companyclaw:health:report` 因此无法区分"缺 node / 缺 entry / 端口占用 / 鉴权失败 / 健康超时"。

#### Change

1. `GuardianProbes` 增加两个可选字段：

```ts
  /** Startup stage that failed, when one did (e.g. "spawn"). */
  gatewayFailureStage?: string | null;
  /** Cause reported for that stage, in plain Chinese. */
  gatewayFailureReason?: string | null;
```

2. `gateway-process` 项 detail 追加原因（state 判定**不变**，避免影响 `overall`/`guardianIsReady` 语义）：

```ts
    detail:
      gatewayStatus === "running"
        ? `Gateway ${gatewayStatus}`
        : probes.gatewayFailureStage && probes.gatewayFailureReason
          ? `Gateway ${gatewayStatus}（失败阶段 ${probes.gatewayFailureStage}）：${probes.gatewayFailureReason}`
          : `Gateway ${gatewayStatus}`,
```

3. `collectGuardianProbes()` 返回值增加：

```ts
    gatewayFailureStage,
    gatewayFailureReason,
```

#### Reason

- 需求第 5 条要求"真实错误原因"可见；健康报告是员工/支持人员不打开日志就能看到原因的既有出口（`ipc-contract.test.ts` 约束通道数量，因此只扩字段不加通道）。
- 复用既有 `GuardianProbes`/`buildGuardianReport`，不新增抽象。

#### Risk

- 若把原因纳入 `state` 计算会改变 `overall`，可能在"未配置模型/未扫码"的首启场景产生假失败：因此 `state` 保持原映射。
- 字段为可选，既有调用方（`guardian.test.ts` 的 `healthy` 常量、`ipc.ts:141` 默认 `healthReport: () => buildGuardianReport({})`）无需改动即可编译。

#### Verification

```bash
cd desktop
npx vitest run src/companyclaw/guardian.test.ts src/companyclaw/ipc-contract.test.ts
npx tsc --noEmit
```

预期：`guardian.test.ts` 原有 9 个用例全绿；新增用例断言 detail 含 `失败阶段 spawn`。

---

### Step 4 — 构建脚本 `.NET SDK` 显式预检（`build.ps1`）

#### Target

- 文件：`build.ps1`
- 位置：第 `78` 行（Node 检测结束）与第 `80` 行（子模块初始化）之间
- 测试：构建脚本无自动化测试 → 本步验证为**手工执行**（见 Verification）

#### Current Behavior

- 无任何 `dotnet` 预检。Node 检测通过后直接进入子模块初始化，随后 Step 1 `dotnet publish appcontainer`（`build.ps1:136`）在无 SDK 时失败，输出仅为 `dotnet publish failed with exit code` 或命令不存在。

#### Change

```powershell
# -- Build-machine prerequisite: .NET SDK -------------------------------------
# AppContainerLauncher (net9.0-windows), the bundled Windows Node host and the
# MXC host-prep patch (net10.0-windows) are compiled here. Employees never need
# .NET: these artifacts ship prebuilt inside the installer. A missing SDK is a
# build-machine/CI gap and must say so instead of failing later inside dotnet.
$dotnetCmd = Get-Command dotnet -ErrorAction SilentlyContinue
$installedSdks = @()
if ($dotnetCmd) {
    $sdkOutput = & $dotnetCmd.Source --list-sdks 2>$null
    if ($LASTEXITCODE -eq 0 -and $sdkOutput) {
        $installedSdks = @($sdkOutput | Where-Object { $_ -match '^\d+\.\d+\.' })
    }
}
if ($installedSdks.Count -eq 0) {
    Write-Host "  ERROR: .NET SDK not found on this build machine." -ForegroundColor Red
    Write-Host "  Required workloads: net9.0-windows (appcontainer), net10.0-windows (windows-node-host, mxc-host-prep-patch)." -ForegroundColor Red
    Write-Host "  Install the SDK on the build machine or in CI (https://dotnet.microsoft.com/download), then re-run build.ps1." -ForegroundColor Red
    Write-Host "  Note: employee machines never install .NET — these binaries are shipped prebuilt." -ForegroundColor Yellow
    exit 1
}
Write-Host "  .NET SDKs: $($installedSdks -join ', ')"
```

#### Reason

- 需求第 6 条：`.NET SDK` 缺失属构建依赖，必须给出明确构建机提示；本机 `dotnet --list-sdks` 为空（仅有 runtime 8.0.27）正是当前真实阻塞（`BLOCKERS.md` B4）。

#### Risk

- 预检仅在"完全无 SDK"时阻断：已装 SDK 但缺 `net10.0-windows` 目标包的环境仍会在 `dotnet publish` 处失败（此处不扩大范围去解析 workload）。
- `build.ps1` 有 `StrictMode`（文件头 `Set-StrictMode`）：`$sdkOutput` 需先判空，避免 `Where-Object` 作用于 `$null`。
- 不改动任何既有 Step 的编号、产物路径与 `exit` 语义。

#### Verification

```powershell
# 本机预期：Step 1 之前即给出 .NET SDK 缺失的明确提示并 exit 1
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

预期输出包含：`ERROR: .NET SDK not found on this build machine.` 与 `employee machines never install .NET`，且**不再**出现裸 `dotnet publish failed with exit code`。

---

### Step 5 — 资源装配脚本 `.NET SDK` 缺失与缺件诊断（`prepare-windows-node-resources.mjs`）

#### Target

- 文件：`desktop/scripts/prepare-windows-node-resources.mjs`
- 位置：第 `44-50` 行（平台校验之后）新增 `dotnet` 预检；第 `105-128`、`130-155` 两处 `spawnSync("dotnet", …)` 的错误分支

#### Current Behavior

- 两次 `dotnet publish` 未捕获"命令不存在"：`publish.error` 直接 `throw publish.error`（ENOENT），信息不含"缺 SDK"；`publish.status !== 0` 时 `process.exit(status)`，上层只看到非零退出。

#### Change

1. 平台校验之后新增预检：

```js
// .NET SDK is a build-machine prerequisite: the bundled Windows Node host and
// the MXC host-prep patch target net10.0-windows (see build.ps1 for the same
// check). Nothing here may turn into an "install .NET" instruction for an
// employee — the binaries ship prebuilt inside the installer.
const dotnetProbe = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" });
if (dotnetProbe.error || dotnetProbe.status !== 0 || !/\d+\.\d+\./.test(dotnetProbe.stdout || "")) {
  throw new Error(
    "dotnet SDK not found on this build machine; install the .NET SDK (net9.0-windows / net10.0-windows workloads) " +
      "or run this pipeline in CI. Employee machines never install .NET.",
  );
}
```

2. 两处 `spawnSync` 错误分支补齐原因：

```js
if (publish.error) {
  throw new Error(
    `Failed to run "dotnet publish" for the Windows Node host: ${publish.error.message}. ` +
      "The .NET SDK is a build-machine prerequisite.",
  );
}
if (publish.status !== 0) {
  throw new Error(
    `dotnet publish failed for the Windows Node host (exit ${publish.status}). ` +
      "Check the build machine's .NET SDK version against the net10.0-windows target.",
  );
}
```

（`hostPrepPublish` 分支同构改写，文案写 `MXC host-prep patch`。）

#### Reason

- 需求第 6 条与 S5：`npm run release:win` 的失败必须直指构建前置条件，而不是 `exit code 1`。
- 该脚本是 `build.ps1` Step 3 与 `desktop/package.json` 的 `release:win`/`dist`/`dist:msix` 共同入口，改一处覆盖三条命令。

#### Risk

- 预检增加一次 `dotnet --list-sdks` 进程调用（毫秒级），不影响既有哈希校验与 staging 语义。
- 错误分支从 `process.exit(status)` 改为 `throw`：脚本顶层已有 `uncaughtException/unhandledRejection` 处理器（第 78-90 行）清理 staging 后 `exit(1)`，语义更干净但不改变"失败即中止"。

#### Verification

```bash
cd desktop
node scripts/prepare-windows-node-resources.mjs --arch=x64
```

预期（本机无 SDK）：抛出 `dotnet SDK not found on this build machine; install the .NET SDK …`，且 `resources/.staging-*` 被清理、既有 `resources/windows-node/` 不被破坏。

---

### Step 6 — NSIS 产物命名与文档/脚本一致（`electron-builder.yml`）【待裁决项 A】

#### Target

- 文件：`desktop/electron-builder.yml`（`nsis:` 段，第 25-40 行）
- 关联：`build.ps1:262/496` 的提示路径、`docs/companyclaw/v3/03-packaging-guide.md:60`、`04-employee-guide.md:9`、`05-it-admin-guide.md:9`

#### Current Behavior

- 未配置 `nsis.artifactName` → electron-builder 使用 `${productName} Setup ${version}.${ext}` → 实际产出 `CompanyClaw Setup 1.0.0.exe`。
- 文档与 `build.ps1` 均按 `CompanyClaw-Setup-<version>-x64.exe` 指引，验证脚本会找不到文件。

#### Change（按推荐方案，待确认后执行）

```yaml
nsis:
  artifactName: CompanyClaw-Setup-${version}-${arch}.exe
  oneClick: false
  # …（其余字段保持不变）
```

#### Reason

- 需求第 8 条的交付物必须与文档/脚本指引同名，否则"构建 + 验证"无法闭环。
- `${arch}` 对 x64 展开为 `x64`，与文档 `-x64` 一致；arm64 构建自动得到 `-arm64`。

#### Risk

- 若公司分发流程已按默认名 `CompanyClaw Setup <version>.exe` 约定（未在本仓库中体现），改名会造成分发脚本失配 → **因此列为待裁决项 A**。
- `desktop/src/companyclaw/product-identity.test.ts` 断言 `electron-builder.yml` 的若干片段（`appId`/`productName`/`extraResources`）：本步不触碰这些行，测试应保持通过。

#### Verification

```bash
cd desktop
npx vitest run src/companyclaw/product-identity.test.ts src/companyclaw/installer-scope.test.ts src/companyclaw/extra-resources-contract.test.ts
node -e "const y=require('js-yaml').loadAll(require('fs').readFileSync('electron-builder.yml','utf8'));console.log(y[0].nsis.artifactName)"
```

预期：三个测试全绿；打印 `CompanyClaw-Setup-${version}-${arch}.exe`。

---

### Step 7 — 旧启动脚本安全收口（`start-gateway.cmd`）

#### Target

- 文件：`start-gateway.cmd`（仓库根，`launch.bat` 的兄弟脚本；**不在** NSIS payload 内）
- 关联只读核查：`scripts/windows/launch.bat`（→ `deploy.py`）、`installer/microclaw-setup.nsi`（legacy 通道）

#### Current Behavior

- 硬编码 `%USERPROFILE%\.openclaw-node\node.exe` 与 `…\node_modules\openclaw\openclaw.mjs`。
- 启动前执行无范围约束的 `taskkill /F /IM node.exe /T`，会误杀同机其他 Node 进程（含员工机器上的其他应用）。

#### Change

1. 删除无范围 `taskkill`，改为按端口定向清理（与 `main.ts:2927-2960` 的 `netstat -ano` + 按 PID `taskkill` 同构）：

```bat
REM Kill only the process listening on the gateway port. A bare
REM "taskkill /IM node.exe" would also kill unrelated Node applications.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr ":18789"') do (
    echo Stopping stale gateway process PID %%a on port 18789
    taskkill /PID %%a /T /F >nul 2>&1
)
```

2. 文件头加注释明确它是**开发者手工脚本**、不参与员工发行链路、运行时优先使用安装包私有 Node：

```bat
REM Developer convenience script only. The employee distribution is the NSIS
REM installer (desktop\release\CompanyClaw-Setup-<version>-<arch>.exe), which
REM always runs its own bundled resources\node.exe — never a system Node or the
REM legacy %USERPROFILE%\.openclaw-node layout.
```

3. 保留 dev 布局回退（`.openclaw-node` 作为本机开发路径不变），但把错误提示改为"开发机未安装 OpenClaw"语义，并注明员工机器无需该目录。

#### Reason

- 需求第 7 条：不得在正式员工版使用无范围约束的全局 `taskkill /IM node.exe`。本文件不在安装包内，但仍属可被误用的旧启动机制，必须收口。

#### Risk

- 本文件无自动化测试，改动需人工判读；`for /f` 在无监听进程时不进入循环（`netstat` 无输出），行为安全。
- 不删除文件（宪法 A2），仅改内容并加注释。

#### Verification

```bash
grep -n "taskkill" start-gateway.cmd
grep -rn "IM node.exe" . --include=*.cmd --include=*.bat 2>/dev/null | grep -v node_modules
```

预期：仅剩 `taskkill /PID …`；无 `/IM node.exe` 命中（除 `deployer/windows_setup.py:4735` 的 legacy 通道，Step 7 只在文档中标注评估结论，不改 Python）。

---

### Step 8 — 状态与证据如实记录（`BLOCKERS.md`、发布证据）

#### Target

- 文件：`BLOCKERS.md`（B4 段与更新日期）
- 文件：`docs/companyclaw/v3/06-release-evidence.md`（PKG-04 行、本机已实测表）

#### Current Behavior

- B4 已记录无 .NET SDK，但未记录本轮"启动链修复"的范围与复现证据（`desktop/dev-launch.log` 的 `node.exe not found at node`）。
- `06-release-evidence.md` 的 PKG-04 为 `UNVERIFIED`，其说明未包含"裸 `node` 回退"这一具体根因。

#### Change

1. `BLOCKERS.md`：B4 增补"本轮复核"一行 —— 复现命令、根因（`resolveNodePath` 裸名回退 + `fs.existsSync("node")`）、修复落点、未解除结论。
2. `06-release-evidence.md`：更新 PKG-04/PKG-03 说明为修复后的真实状态（代码修复 + 单测 + 开发态实测；打包态与干净机仍 `BLOCKED`），并在"本机已实测通过的部分"表中加入本轮实际命令与结果。

#### Reason

- 需求第 9 条：未完成项标 `BLOCKED/UNVERIFIED`，不得只靠单测或静态检查宣布完成。

#### Risk

- 文档夸大风险最高：只允许写"已执行的命令 + 实际输出"，不得把 dev 态实测写成"员工可安装"。

#### Verification

```bash
grep -n "resolveNodePath" BLOCKERS.md
grep -n "PKG-04" docs/companyclaw/v3/06-release-evidence.md
```

预期：两处均能检索到本轮更新的说明与证据路径。

---

### Step 9 — 测试更新与新增（TDD：先红后绿）

#### Target

- 文件：`desktop/src/path-resolver.test.ts`（改 4 个、增 3 个用例）
- 文件：`desktop/src/companyclaw/guardian.test.ts`（增 2 个用例）
- 新增：`desktop/src/gateway-startup-diagnostics.test.ts`

#### Current Behavior

- `path-resolver.test.ts`：
  - `:166` "falls back to a supported Node on PATH…" 断言 `resolveNodePath()).toBe("node")`（固定了裸名行为）。
  - `:222` "does not execute a relative OPENCLAW_NODE_DIR override" 断言回到 `"node"`。
  - `:229` "skips an unsupported bundled runtime" 在 `app.isPackaged=true` 下断言回退 `"node"`。
  - `:250` 断言错误文案含 `"Run the MicroClaw installer or install Node.js 26"`。
- `guardian.test.ts`：无失败原因用例。

#### Change

1. `path-resolver.test.ts` 改 4 处：

```ts
  it("returns the absolute PATH runtime instead of a bare command name", () => {
    process.env.USERPROFILE = "C:\\Users\\testuser";
    process.env.PATH = "D:\\nvm\\nodejs;C:\\Windows\\System32";
    const onPath = path.join("D:\\nvm\\nodejs", "node.exe");
    mockExistsSync.mockImplementation((p) => String(p) === onPath);
    expect(resolveNodePath()).toBe(onPath);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      onPath,
      ["--version"],
      expect.objectContaining({ windowsHide: true, timeout: 5_000 }),
    );
  });
```

```ts
  it("does not execute a relative OPENCLAW_NODE_DIR override", () => {
    process.env.OPENCLAW_NODE_DIR = "relative-node";
    process.env.PATH = "D:\\nvm\\nodejs";
    const onPath = path.join("D:\\nvm\\nodejs", "node.exe");
    mockExistsSync.mockImplementation((p) => String(p) === onPath);
    expect(resolveNodePath()).toBe(onPath);
  });
```

```ts
  it("refuses to fall back to a system Node in a packaged build", () => {
    mockApp.isPackaged = true;
    vi.stubGlobal("process", { ...process, resourcesPath: "C:\\CompanyClaw\\resources" });
    try {
      const legacy = "C:\\Users\\testuser\\.openclaw-node\\node.exe";
      mockExistsSync.mockImplementation((p) => String(p) === legacy);
      expect(() => resolveNodePath()).toThrow("安装包内置的私有 Node 运行时缺失");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an unsupported bundled runtime instead of using another Node", () => {
    mockApp.isPackaged = true;
    vi.stubGlobal("process", { ...process, resourcesPath: "C:\\CompanyClaw\\resources" });
    try {
      const bundled = path.join(process.resourcesPath, "node.exe");
      mockExistsSync.mockImplementation((p) => String(p) === bundled);
      mockExecFileSync.mockImplementation(() => "v22.22.3");
      expect(() => resolveNodePath()).toThrow("不在支持范围");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the bundled runtime when it is present and supported", () => {
    mockApp.isPackaged = true;
    vi.stubGlobal("process", { ...process, resourcesPath: "C:\\CompanyClaw\\resources" });
    try {
      const bundled = path.join(process.resourcesPath, "node.exe");
      const legacy = "C:\\Users\\testuser\\.openclaw-node\\node.exe";
      mockExistsSync.mockImplementation((p) => [bundled, legacy].includes(String(p)));
      mockExecFileSync.mockImplementation(() => "v26.1.0");
      expect(resolveNodePath()).toBe(bundled);
    } finally {
      vi.unstubAllGlobals();
    }
  });
```

`:250` 用例改断言：

```ts
  it("reports the development-machine requirement when no executable runs", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => resolveNodePath()).toThrow("员工机器不需要安装 Node.js");
  });
```

2. `guardian.test.ts` 增 2 处：

```ts
  it("names the failed startup stage instead of a bare status", () => {
    const report = buildGuardianReport({
      ...healthy,
      gatewayStatus: "failed",
      gatewayFailureStage: "spawn",
      gatewayFailureReason: "Gateway 进程创建失败：spawn ENOENT",
    });
    expect(item(report, "gateway-process").state).toBe("failed");
    expect(item(report, "gateway-process").detail).toContain("失败阶段 spawn");
  });

  it("keeps the status-only detail when no stage was recorded", () => {
    const report = buildGuardianReport({ ...healthy, gatewayStatus: "stopped" });
    expect(item(report, "gateway-process").detail).toBe("Gateway stopped");
  });
```

3. 新增 `desktop/src/gateway-startup-diagnostics.test.ts`（源码级契约，与同目录 `startup-order.test.ts`、`ipc-contract.test.ts` 同风格）：

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The loading screen shows only the last gateway log line, so every startup
 * failure has to carry its stage on that same line. This pins the contract that
 * used to be a single "node.exe not found" hint pointing at .openclaw-node.
 */
const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");

describe("gateway startup diagnostics", () => {
  it("reports failures with a stage tag on one line", () => {
    expect(source).toContain("function reportGatewayFailure(");
    expect(source).toContain("`[error][stage=${stage}] ${reason}`");
  });

  it("never sends an employee to the legacy .openclaw-node layout", () => {
    expect(source).not.toContain("手动检查 .openclaw-node 目录");
    expect(source).not.toContain("请确认 openclaw 已正确安装到 .openclaw-node");
  });

  it("covers every startup stage the requirement names", () => {
    for (const stage of [
      "resolve-runtime",
      "extract-runtime",
      "verify-manifest",
      "spawn",
      "auth",
      "health",
    ]) {
      expect(source).toContain(`"${stage}"`);
    }
  });
});
```

#### Reason

- 原测试**固定了缺陷行为**（裸 `node` 回退），必须随语义一起演进，否则修复无法落地（S1/S4）。
- 新增源码级契约用例防止"文案回退到 `.openclaw-node"`（S2）与阶段遗漏（S3、S6）。

#### Risk

- `vi.stubGlobal("process", …)` 会替换整个 `process`：既有用例已用该模式，新增用例沿用同一 `try/finally` + `vi.unstubAllGlobals()`。
- 源码级断言对格式敏感：断言取最小必要片段（函数名 + 模板字符串 + 阶段字面量），避免绑定行号。

#### Verification

```bash
cd desktop
npx vitest run src/path-resolver.test.ts src/companyclaw/guardian.test.ts src/gateway-startup-diagnostics.test.ts
```

预期：3 个文件全绿；随后 Step 10 全量回归。

---

### Step 10 — 全量回归 + 开发态实机启动观测

#### Target

- 仓库测试与静态检查；`desktop/` 开发态运行

#### Current Behavior

- 全量基线（V3 收口记录）：desktop 85 files/1562 passed、renderer 28/326、broker 10/68、plugin 15。

#### Change

- 无代码改动（只执行验证）。

#### Reason

- 需求第 9 条：不得以静态检查代替运行；开发态实机是本机唯一可得的"真实运行"证据。

#### Risk

- 本机 Path 上为 nvm node v26.7.0，且 `%APPDATA%\npm\node_modules\openclaw` 与 `~/.openclaw-node/node_modules` 均**不存在** → 开发态只能验证到 `[stage=resolve-runtime]` 成功 + `[stage=extract-runtime]` 报出真实缺失路径，无法验证 Gateway 真正起进程。
- 若要验证"进程创建 → 鉴权 → 健康检查"，需在**构建机**执行 `npm i -g openclaw@2026.9.3`（写入 `%APPDATA%\npm`，属既有 dev 候选布局，需联网，且是构建机行为而非员工要求）。**默认不执行**，待你确认后再作为可选子步骤。

#### Verification

```bash
cd desktop && npx vitest run
cd renderer && npx vitest run
cd ../broker && npx vitest run
cd .. && npx vitest run --root ../plugins/openclaw-weixin
cd desktop && npx tsc --noEmit && npm run lint
cd ../broker && npx tsc --noEmit
```

开发态实机观测：

```bash
cd desktop && npm run dev > ../docs/companyclaw/evidence/dev-startup-<date>.log 2>&1
```

预期日志（无 OpenClaw 运行时的本机）：

```
[companyclaw] Security-core IPC registered …
[info][stage=resolve-runtime] node=D:\Develop\nvm\nodejs\node.exe
[error][stage=extract-runtime] 内置 OpenClaw 入口文件不可用：…
[hint] 请重新运行 CompanyClaw 安装包执行修复安装；无需手动安装 OpenClaw 或 npm。
```

并**不再出现** `node.exe not found at node` 与 `.openclaw-node` 提示；窗口显示的具体原因随 `lastError` 变化为上述真实原因。

---

## 4. Changed Files Tracking

> 本节为**最终实际结果**记录（依据 `git status` / `git diff`，非计划推演）。

| File | Action | Change |
| ---- | ------ | ------ |
| `desktop/src/path-resolver.ts` | Modify | 新增 `resolveExecutablesOnPath()`；`resolveNodePath()` 增加打包态独占分支（仅认 `resources/node.exe`，缺失/不可执行/版本不符分别抛明确错误），开发态候选删除裸 `"node"` 改为 PATH 绝对路径，末尾错误文案改为"员工机器不需要安装 Node.js"；`resolveOpenClawEntry()` 增加打包态缺 `openclaw.asar` 即抛错分支；catch 补 `{ cause: error }` 以满足 `preserve-caught-error` |
| `desktop/src/main.ts` | Modify | 新增 `gatewayFailureStage`/`gatewayFailureReason` 模块变量与 `reportGatewayFailure(stage, reason, hint?)`；解析段 node/entry 各自 try/catch 并打 `[stage=resolve-runtime]`/`[stage=extract-runtime]` 信息行；两处 `fs.existsSync` 守卫改为报真实绝对路径并删除 `.openclaw-node` 提示；打包态追加 `[stage=verify-manifest]` 结果行；spawn 前打 `[stage=spawn]` 上下文；`child.on("error")` 改用 `reportGatewayFailure("spawn", …)`；健康检查失败分支合并 stderr 尾部与 exit code 后调用 `reportGatewayFailure("health", …)`（不再单独 `setGatewayStatus("timeout")`）；成功路径清空失败标记；`onAuthError` 记录 `auth` 阶段原因；`collectGuardianProbes()` 增加两个新字段 |
| `desktop/src/companyclaw/guardian.ts` | Modify | `GuardianProbes` 增加 `gatewayFailureStage`/`gatewayFailureReason`；`gateway-process` 项 detail 非 running 且存在原因时输出"（失败阶段 X）：原因"（`state` 判定未改动） |
| `build.ps1` | Modify | Node 检测与子模块初始化之间新增 `.NET SDK` 预检（`dotnet --list-sdks`），缺失时输出构建机提示并 `exit 1`；提示文本使用 ASCII 连字符以避免非 UTF-8 控制台乱码 |
| `desktop/scripts/prepare-windows-node-resources.mjs` | Modify | 平台校验后新增 `dotnet --list-sdks` 预检；两处 `dotnet publish` 的 `error`/`status !== 0` 分支由 `throw publish.error` / `process.exit()` 改为带诊断信息的 `throw new Error(...)` |
| `desktop/electron-builder.yml` | Modify | `nsis` 段新增 `artifactName: CompanyClaw-Setup-${version}-${arch}.exe`（含说明注释） |
| `start-gateway.cmd` | Modify | 删除无范围 `taskkill /F /IM node.exe /T`，改为按端口 18789 经 `netstat` 定位 PID 后 `taskkill /PID`；文件头与错误分支加注"仅开发者手工脚本、正式版用包内私有运行时、员工无需 Node/npm/.openclaw-node" |
| `desktop/src/path-resolver.test.ts` | Modify | 重写 4 个固定缺陷行为的用例（PATH 绝对路径、相对 override、打包态拒绝回退、打包态不支持版本改抛错），新增"打包态使用可用内置运行时"用例，末尾错误文案断言改为新文案 |
| `desktop/src/companyclaw/guardian.test.ts` | Modify | 新增 2 个用例：失败阶段写入 detail、无阶段时保持 `Gateway <status>` |
| `desktop/src/gateway-startup-diagnostics.test.ts` | Add | 源码级契约：`reportGatewayFailure` 与 `[error][stage=…]` 同行、禁止 `.openclaw-node` 员工提示、六个阶段均可检索（断言用 `includes`，避免正则字符类缺陷） |
| `BLOCKERS.md` | Modify | B4 增补本轮复核：复现证据、根因、修复落点、构建侧诊断，并明确"未解除" |
| `docs/companyclaw/v3/06-release-evidence.md` | Modify | PKG-04 说明更新为修复后的真实状态；"本机已实测"表新增本轮 4 行命令与结果（含 lint 既有错误与 B4 未解除） |
| `docs/companyclaw/evidence/dev-startup-20261009.log` | Add | 开发态启动观测日志（含环境导致的 Electron 启动失败证据） |
| `backups/*.20261009-145358.startupfix.bak` | Add | 9 个待改文件的改动前备份（需人工转回收站） |

**Plan 中列出但实际未改动的文件**：无（Step 6 按推荐方案 A 执行；`PLAN` §2.2 只读核查项均未改动）。

**Plan 未列出但实际改动的文件**：`docs/companyclaw/evidence/dev-startup-20261009.log`（观测产物，非源码）。

---

## Plan Adjustment

### 调整 6：状态目录隔离（用户裁决 AA A，超出原 Plan 范围）

- **原计划**：未涉及状态目录归属；`getOpenClawStateDir()` 沿用 `~/.openclaw`（若含 `openclaw.json`）或 `%APPDATA%/openclaw`。
- **新发现（实测）**：该函数与用户自装的官方 OpenClaw **共用同一状态目录**，导致四项真实风险：
  1. CompanyClaw **覆写**官方 `openclaw.json`（7 处 `writeConfigTextAtomically`）；
  2. `stopGatewayProcess()` 按**端口** `netstat` 找出监听进程后 `taskkill /PID /T /F`，会**杀掉官方 Gateway**；
  3. `checkExistingGateway()` 命中健康端口时**采纳并连接**外部 Gateway；
  4. 继承官方 workspace 的旧格式 `workspace-state.json` → OpenClaw 抛 `StartupMaintenanceRequiredError` → **exit 78**（本机 `~/.openclaw/workspace/.openclaw/workspace-state.json`，2026-04-29 创建，即本次卡在 70% 的直接原因）；
  另有 `seedWorkspaceFiles()` 写 `workspace/*.md`、`~/.openclaw/skills`、`tool-sandbox.ts` 沙箱授权、升级事务 `expectedStateDir` 共 8 处耦合。
- **为什么需要调整**：需求要求"内置/自包含"，但此前只隔离了**运行时代码**，未隔离**运行状态**；不隔离则上述四项无法根治，且会干扰同机官方 OpenClaw。
- **新增修改范围（用户裁决：私有目录 + 不迁移 + 端口仅杀自己的进程）**：
  - `desktop/src/path-resolver.ts` — `getOpenClawStateDir()` 改为 `<userData>/openclaw-state`（保留 `OPENCLAW_STATE_DIR` 覆盖；创建失败仅告警，不阻断解析）。
  - `desktop/src/main.ts` — 新增 `managedGatewayEntryPath` 状态、`readProcessCommandLine()`／`isOwnedGatewayProcess()`／`findListeningPids()`；`stopGatewayProcess()` 仅杀命令行含本安装 entry 的监听进程，其余打印"留给它"；`alreadyRunning` 且端口被非本安装进程占用时以 `[stage=spawn]` 明确报错并返回（不采纳、不杀）；解析到 entry 后记录 `managedGatewayEntryPath`；`~/.openclaw/skills` 改用 `getOpenClawStateDir()`；`expectedStateDir` 改用 `getOpenClawStateDir()`；`ToolSandbox` 构造传入 `stateDir`。
  - `desktop/src/tool-sandbox.ts` — 构造器新增可选 `stateDir`，沙箱读写目录随之（不再硬编码 `~/.openclaw`）。
  - `desktop/src/path-resolver.test.ts` — 2 个状态目录用例改为断言隔离行为（新增"不读官方 `~/.openclaw`"负向断言）；`app.getPath` mock 增加 `userData`。
- **实测验证（本机，2026-10-09）**：
  - `Launching gateway: stateDir=C:\Users\guojl\AppData\Roaming\microclaw\openclaw-state`（不再指向 `~/.openclaw`）；
  - 端口由继承官方配置的 **18790** → 本产品默认 **18789**；
  - Gateway 监听进程命令行确认为**本安装 entry**（`.openclaw-node\node_modules\openclaw\openclaw.mjs gateway run --port 18789`）；
  - `curl http://127.0.0.1:18789/health` → **200**；日志出现 `[startup-timing] gateway-ready`；
  - **`~/.openclaw` 零改动**：`openclaw.json` 哈希 `cfa65839…`、`workspace-state.json` 哈希 `9cd28341…`、文件总数 `3936` 三项与启动前**完全一致**；
  - 私有目录已按预期建立（`openclaw.json`、`device-identity.json`、`compile-cache`、`sandbox` 等）。


### 调整 1：解析段不再调用 `rollbackStartupAgentSkills()`

- **原计划**：Step 2 的解析 try/catch 片段中包含 `rollbackStartupAgentSkills();`。
- **新发现**：该符号是 `startGatewayInner` 内第 3790 行的 `const` 箭头函数，而调用点在 3679/3692，属 TDZ；`tsc` 报 `TS2448`/`TS2454` 共 4 处错误，代码不可编译。
- **为什么需要调整**：此处技能事务尚未开始，原代码在该 catch 中只做 `log + setGatewayStatus("failed") + throw`；照抄计划片段会引入真实缺陷。
- **调整后范围**：删除该 2 处调用（净减 2 行），其余 Step 2 内容不变。

### 调整 2：新增诊断测试的阶段断言改用 `includes`

- **原计划**：`expect(source).toContain(\`"${stage}"\`)`。
- **新发现**：`verify-manifest` 在源码中只以 `[stage=verify-manifest]` 模板标签形式存在，不存在 `"verify-manifest"` 引号字面量，原断言必然失败；改用正则的初版又因字符类未转义报 `Range out of order in character class`。
- **为什么需要调整**：断言必须匹配真实代码形态，否则测试恒红。
- **调整后范围**：仅该测试文件的 1 个断言改为 `source.includes(\`"${stage}"\`) || source.includes(\`[stage=${stage}]\`)`。

### 调整 3：Step 10 开发态实机观测的执行环境限制

- **原计划**：`npm run dev` 后观察 `[stage=…]` 日志与界面文案。
- **新发现**：本执行环境注入了 `ELECTRON_RUN_AS_NODE=1`，Electron 以纯 Node 模式启动，`require("electron").app` 为 `undefined`，在 `bundled-windows-node-host.ts:746` 的 `app.isPackaged` 处崩溃（`main.js` 模块初始化期的 eager 实例化），GUI 无法启动。
- **为什么需要调整**：这是环境限制而非代码缺陷；开发态实机启动观测在本会话不可达。
- **调整后范围**：不改代码；如实记录为 `UNVERIFIED`，日志留证于 `docs/companyclaw/evidence/dev-startup-20261009.log`。

### 调整 4：`build.ps1` 提示文本使用 ASCII 连字符

- **原计划**：提示文本含长破折号 `—`。
- **新发现**：在非 UTF-8 控制台（`chcp` 未设 65001）下实测输出为 `鈥?`，构建日志乱码。
- **调整后范围**：该行改为 `-`，语义不变。

### 调整 5：C 项候选验证方案撤回（用户澄清）

- **原计划**：Step 10 末尾把 `npm i -g openclaw@2026.9.3` 列为可选活体验证。
- **新发现**：该命令安装到全局 npm prefix，正是需求第 4 条禁止的员工侧依赖形态，且会让"验证通过"与"产品路径可用"混淆。
- **调整后范围**：撤回该候选；构建机装配（`prepare-production-resources.mjs`）属既有工艺，非员工侧依赖。本轮未执行任何 npm 全局安装。

---

## 5. Verification Checklist

### 主流程

- [ ] `resolveNodePath()` 打包态仅返回 `resources/node.exe`（S1，单测）
- [ ] 打包态缺件时报缺失**绝对路径**且无 `.openclaw-node` 字样（S2，单测 + 源码契约）
- [ ] 启动失败日志含 `[stage=…]` 且与原因同行（S3，源码契约 + dev 实测）
- [ ] dev 实测：`[info][stage=resolve-runtime] node=<绝对路径>`（S4）
- [ ] 窗口加载页显示的是**具体阶段与原因**，而非只有"服务启动失败，请重试"

### 关联流程

- [ ] `companyclaw:health:report` 的 `gateway-process` detail 含失败阶段（Step 3 单测）
- [ ] 微信插件安装（`ensureWeixinPluginAvailable`）在解析失败时只 warn、不阻断启动（现有行为回归）
- [ ] `verify-manifest` 阶段在打包态打印已校验条目数或问题清单（Step 2 代码 + 打包后实测）
- [ ] `Gateways` 重试按钮行为不变（`GatewayLoading.vue:102`，`failed`/`timeout` 同路径）
- [ ] MXC 分支（`securityMode=windows-node-mxc`）语义与默认值未被触碰（Step 2 Risk 复核）

### 边界情况

- [ ] 缺 `resources/node.exe`（打包态）
- [ ] 内置 node 版本不在 `>=24.16.0 <25 || >=26.1.0` 内
- [ ] 缺 `resources/openclaw.asar` / asar 解压失败
- [ ] `runtime-manifest.json` 缺件或哈希不符（`verify-manifest` 阶段上报）
- [ ] `~/.openclaw-node` 存在但**无** `node.exe`（本机真实场景）
- [ ] 相对路径 `OPENCLAW_NODE_DIR=relative-node`（不得被执行，也不得回退裸名）
- [ ] 端口 18789 被占用（`stopGatewayProcess` 按 PID/端口清理后仍失败）
- [ ] 中文/带空格安装路径（`path-resolver` 既有用例 + 打包后实测）
- [ ] 非管理员普通账号安装与启动（**BLOCKED**：无目标机）
- [ ] 网关配置被拒（exit 78）时原因可见（既有 `signalPostInstallFailure` + 新阶段日志）

### Test

- [ ] `cd desktop && npx vitest run` 全绿（含新增/更新用例）
- [ ] `cd desktop/renderer && npx vitest run` 全绿
- [ ] `cd broker && npx vitest run` 全绿
- [ ] `cd desktop && npx vitest run --root ../plugins/openclaw-weixin` 全绿

### Build

- [ ] `powershell -File build.ps1` 在本机于 Step 1 前给出 `.NET SDK` 缺失提示并 `exit 1`（S5）
- [ ] `node desktop/scripts/prepare-windows-node-resources.mjs --arch=x64` 给出 SDK 缺失提示且不破坏 `desktop/resources/`
- [ ] `cd desktop && npm run release:win` → **BLOCKED（无 .NET SDK）**，以真实输出记录
- [ ] NSIS 安装包与干净中文 Win11 普通账号实测 → **BLOCKED**，按需求第 9 条标注

### Lint / Typecheck

- [ ] `cd desktop && npx tsc --noEmit` clean
- [ ] `cd desktop/renderer && npx vue-tsc --noEmit` clean（若脚本可用）
- [ ] `cd broker && npx tsc --noEmit` clean
- [ ] `cd desktop && npm run lint` clean（含 `npm run lint:weixin`）

---

## 待裁决项（进入 Coding 前必须确认）

- **A. 安装包命名**：Step 6 按"配置对齐文档"（`CompanyClaw-Setup-<version>-<arch>.exe`）执行，还是改为"文档对齐 builder 默认名"，或本轮不动（则 S8 仍记录该不一致）？
- **B. `.openclaw-node` 兼容范围**：Step 1 采用"打包态完全排除、开发态保留候选、沙箱授权仅在该目录存在时授予"（推荐，最小改动且不破坏 dev 与既有 `sandbox-logic.test.ts` 断言），还是要求连开发态候选一并移除（会牵动 `tool-sandbox.ts`、`sandbox-state.js`、`provision-appcontainer.ps1` 与若干测试）？
- **C. 可选活体验证**：是否允许在本构建机执行 `npm i -g openclaw@2026.9.3`（联网、写入 `%APPDATA%\npm`），以便 Step 10 实测"进程创建 → 鉴权 → 健康检查"成功路径？默认**不执行**，则 Step 10 只能验证到阶段诊断层。
