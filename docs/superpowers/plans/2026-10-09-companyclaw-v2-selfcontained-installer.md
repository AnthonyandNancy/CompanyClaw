# CompanyClaw V2 自包含安装与运行时闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通员工只做三件事——安装一个 CompanyClaw EXE、填自己的模型 API Key、微信扫码——即可使用 CompanyClaw 全部已授权功能；所有运行时依赖在构建阶段装配进包内。

**Architecture:** 复用仓库已有的自包含能力（私有 `resources/node.exe`、`openclaw.asar` + 运行时解包、self-contained 的 Windows Node Host、已随包分发的 AppContainer、`resolveNodePath()` 的"打包资源优先 + 版本白名单"），只修复**接线**：统一资源流水线 → electron-builder 契约对齐 → Broker 用私有 Node 启动 → 首次运行自动生成 Gateway/浏览器配置 → NSIS Per-User 成为唯一正式发行入口。不新建运行时框架，不改动 `appcontainer/`、`windows-node-host/`、`skills/`、MXC 与安全策略内核。

**Tech Stack:** Electron 33 + TypeScript (CommonJS, strict) + Vue 3/Pinia + Vitest；electron-builder 26 (NSIS)；Node 26 私有运行时；OpenClaw 2026.9.3；PowerShell UIA Broker（无 runtime 依赖）。

## Global Constraints

- 基线：分支 `feat/companyclaw-foundation`，仓库 HEAD `f1ab74e7f489909dc1307436dacf12ef3f1ac4c4`，工作树 clean。所有引用以 **Commit SHA + 文件路径 + 符号名** 定位，行号仅作辅助（V2 实施书中的 `main.ts:543/4106` 已失效，实际符号为 `cachedRemoteSource` / `startGatewayInner`）。
- 目标版本锁定：OpenClaw `OPENCLAW_TARGET_VERSION = "2026.9.3"`（`deployer/openclaw_version.py`）；Node 引擎区间 `>=24.16.0 <25 || >=26.1.0`；MXC `@microsoft/mxc-sdk` `0.7.0`。
- **禁止修改**：`appcontainer/**`、`windows-node-host/**`、`desktop/src/windows-node-mxc*.ts`、`skills/**`。
- **员工侧依赖为零**：不得出现要求用户安装 Node/Python/.NET SDK/Git/npm/pnpm/npx/OpenClaw/Windows-MCP、配置 MCP JSON、执行 PowerShell、配置环境变量、初始化 Git 子模块的代码路径。
- **不得新增 Defender 排除项**；安装默认 Per-User、不请求管理员常驻；Broker 不得以管理员/System 运行。
- **不得伪造验证**：缺环境、缺账号、缺签名一律记 `BLOCKED`/`UNVERIFIED`，不得写成 `PASS`。
- 提交粒度：每一步一次或多次小提交，提交信息描述实际改造点；同步更新 `docs/companyclaw/IMPLEMENTATION_STATUS.md`。
- 测试基线（改动前，用于回归判定）：desktop `70 files / 1405 passed`；broker `10 files / 63 passed`（含 11 项实机）；renderer `27 files / 318 passed`；Python `298 passed` + 2 项既有 error（不得为改绿而改该文件）。
- 重要既有约束（改动时必须同步更新，否则会红）：`desktop/src/companyclaw/ipc-contract.test.ts` 断言 `ipcMain.handle(` 数量 **等于** `REQUIRED_CHANNELS.length`；`desktop/src/companyclaw/product-identity.test.ts` 当前断言 `to: openclaw/`。

---

## 1. Goal

### 本次修改目标

1. **运行时依赖审计落地为代码**：把"哪些资源必须进包"写成可校验的 `runtime-manifest.json` 契约。
2. **构建时自动装配全部资源**：一条统一流水线产出 `node.exe`、`openclaw.asar`、`windows-node/`、`companyclaw-broker/`、`runtime-manifest.json`。
3. **electron-builder 契约对齐**：`extraResources` 的每个 `from` 必须真实可产出；Broker 进入安装资源清单。
4. **安装后生产启动可用**：Broker 用私有 Node 启动；首次运行自动生成 `gateway.auth.token` / `gateway.port` / `browser.*`，并做运行时完整性诊断。
5. **首次使用向导闭环**：模型配置后展示真实能力探针结果；微信扫码复用既有通道页。
6. **正式发行入口收敛**：NSIS Per-User 成为唯一验收口径，旧 PyInstaller/MicroClaw NSIS 壳降级为兼容渠道。
7. **文档与源码一致性修正**：更新实施状态，登记 SHA + 符号级定位与功能完成度。

### 不包含的内容（本计划明确不做）

- **不实现浏览器执行器**（`skills/` 无 playwright/chromium；上游设计是复用系统 Edge，`README.md` 记为 `Optional: Microsoft Edge`）。本次只保证 `browser.*` 配置在首次运行时被正确写入，真实 Web 自动化仍记 `UNVERIFIED`。
- **不捆绑 Chromium/Playwright**（+150MB、新增供应链与 CVE 审计面），除非产品负责人另行裁定。
- **不新增代码签名证书**；可产出内部未签名包，并在产物与文档上明示。
- **不重写** `TaskOrchestrator` 状态机、`ExecutionBridge` 失败关闭逻辑、Broker `policy.ts/uia.ts`、`appcontainer`、MXC、任务/审批/身份内核。
- **不改** `desktop/renderer/src/stores/tasks.ts` 的 cron 任务中心（只做 UI 文案区分，不迁移、不合并）。
- **不引入** 任何新的第三方运行时依赖（R1 §4.1 要求逐项证明必要性）。

### 成功标准

- **构建机（离线可判定）**：
  - `desktop/resources/` 从零重建后，`runtime-manifest.json` 每项 SHA-256 与磁盘一致；篡改任一文件后校验必须失败。
  - `extraResources` 契约测试通过：无死引用、Broker 在清单内。
  - `BrokerClient` 启动命令为 `resolveNodePath()` 结果，argv 中不含令牌。
  - 首次运行初始化幂等：已有 `gateway.auth.token` 时二次运行不覆盖。
  - desktop `tsc` / `vitest` / `eslint`、broker `tsc` / `vitest`、renderer `vitest` 全绿，且不低于上表基线。
- **目标机（本机 BLOCKED，需外部环境）**：干净中文 Windows 11 标准账号、断网安装成功、首次启动零命令行完成模型 + 微信配置、Gateway 与 Broker 自动启动、重启恢复、升级保配置、卸载可选保留。
- **状态诚实性**：未在目标机真实执行的一律 `UNVERIFIED`，不得计为 `PASS`。

---

## 2. Current Understanding

### 当前实现方式（源码事实）

| 关注点 | 现状 | 定位（SHA `f1ab74e7`） |
|---|---|---|
| 私有 Node 捆绑 | 构建时 `copyFileSync(process.execPath, resources/node.exe)` | `desktop/scripts/prepare-resources.mjs` `prepare-resources` 顶部 |
| Node 解析 | 打包资源 → `OPENCLAW_NODE_DIR` → 旧部署器 → PATH，含版本白名单校验 | `desktop/src/path-resolver.ts` `resolveNodePath()` |
| OpenClaw 打包 | asar，运行时 `extractAll` 到 `userData/runtime/openclaw`，带 `.microclaw-version` 幂等标记 | `desktop/src/bundled-runtime.ts` `resolveBundledOpenClawDir()` |
| OpenClaw 入口 | 打包时优先 `resources/openclaw.asar` → `node_modules/openclaw/openclaw.mjs` | `desktop/src/path-resolver.ts` `resolveOpenClawEntry()` |
| .NET 免装（员工侧） | `dotnet publish --self-contained true -p:PublishSingleFile=true` | `desktop/scripts/prepare-windows-node-resources.mjs` |
| Gateway 唯一活路径 | `app.whenReady` → `startApplicationServices()` → `startGateway()` → `startGatewayInner()`，`spawn(nodePath, gwArgs, { stdio: ["ignore","pipe","pipe","ipc"] })` | `desktop/src/main.ts` `startGatewayInner()` |
| Gateway 令牌 | **只读不写**：`gatewayToken = config?.gateway?.auth?.token \|\| ""`；唯一写入者是旧 Python 安装器 | `desktop/src/main.ts` `startGatewayInner()`；`deployer/windows_setup.py` `auth["token"] = secrets.token_hex(24)` |
| Broker 启动 | `spawn(process.execPath, [entry], { env: {...} })` | `desktop/src/companyclaw/broker-client.ts` `startInternal()` |
| Broker 路径 | 打包时期望 `<resources>/companyclaw-broker` | `desktop/src/companyclaw/broker-paths.ts` `resolveBrokerDir()` |
| 打包资源清单 | 缺 `companyclaw-broker`；含必然不存在的 `resources/openclaw/`（该目录总被 `rmSync` 删除） | `desktop/electron-builder.yml` `extraResources` |
| 发行入口 | `dist` 只跑 windows-node 资源；`build.ps1` Step3 用 `--dir`、Step5 PyInstaller、Step7 MicroClaw 品牌 NSIS 壳（注释明说内层自提权装 Node MSI） | `desktop/package.json`、`build.ps1`、`installer/microclaw-setup.nsi` |
| 首次配置门闸 | `config:needs-setup` IPC + `/setup` 路由 + `App.vue` 门控 | `desktop/src/main.ts` `needsSetup()`；`desktop/renderer/src/router.ts`；`App.vue` |
| 模型能力探针 | 后端与 preload 已通，**renderer 无消费者** | `desktop/src/companyclaw/model/capability-probe.ts`；`desktop/src/preload.ts` `companyClaw.model.probeCapabilities` |
| 微信扫码 | 既有完整 QR 流程 | `desktop/renderer/src/views/ChannelsView.vue`；`plugin:weixin:login-qr-start` |
| 运行时解包消费者 | 只认 `openclaw.asar`；`resources/openclaw/` **无人读取** | `desktop/src/bundled-runtime.ts` |
| 首次运行初始化 | **完全不存在** | — |

### 数据流 / 调用链

```
app.whenReady
  └─ registerIpcHandlers()                       (main.ts)
  └─ createMainWindow()
  └─ startApplicationServices()                  ← 唯一启动漏斗（含 MXC 分支）
        └─ startGateway()  → startGatewayInner()
              ├─ config = readConfig()                       ← 此处需要 gateway.auth.token
              ├─ gatewayToken = config?.gateway?.auth?.token  ← 目前恒为 ""
              ├─ nodePath = resolveNodePath()                 ← 已正确
              ├─ entryPath = resolveOpenClawEntry()           ← 已正确
              └─ spawn(nodePath, gwArgs, {stdio:[...,"ipc"]})

registerIpcHandlers()
  └─ createCompanyClawRuntime({ broker: { brokerDir } })   (companyclaw/ipc.ts)
        └─ new BrokerClient({ brokerDir, scriptDir, ... })  ← 未传 nodePath
              └─ startInternal(): spawn(process.execPath, [entry])  ← 缺陷
```

### 已确认的影响范围

- **直接**：`desktop/package.json`、`desktop/electron-builder.yml`、`desktop/scripts/*`、`desktop/src/companyclaw/{broker-client,broker-paths,ipc,runtime-manifest*,first-run-init*}.ts`、`desktop/src/main.ts`、`desktop/renderer/src/views/SetupWizard.vue`、`desktop/renderer/src/stores/companyclaw.ts`、`build.ps1`、`docs/companyclaw/*`。
- **关联**：`path-resolver.ts`、`bundled-runtime.ts`、`gateway-manager.ts`（仅测试引用，非活路径）、`config-write-policy.ts`、`ipc-contract.test.ts`、`product-identity.test.ts`、`installer-scope.test.ts`、`bundled-windows-node-host.test.ts`（读取 `prepare-windows-node-resources.mjs` 源码）。
- **不需修改**：`appcontainer/**`、`windows-node-host/**`、`skills/**`、`broker/{policy,server,uia}.ts`、`desktop/src/companyclaw/{policy,approvals,results,remote,bridge,tasks}/*`、`permissions-manager/**`、`TeamsBot/**`。

---

## 3. Implementation Steps

### Step 1: 运行时清单契约与完整性校验

#### Target

- 新建：`desktop/src/companyclaw/runtime-manifest.ts`
- 新建：`desktop/src/companyclaw/runtime-manifest.test.ts`

#### Current Behavior

没有任何"包内资源清单"概念。`desktop/scripts/prepare-windows-node-resources.mjs` 会写 `desktop/resources/windows-node/RUNTIME.json`（仅覆盖 MXC/Windows Node 子集），其余资源（`node.exe`、`openclaw.asar`、broker）无任何校验记录；运行时也无法判断包内资源是否缺损。

#### Change

新增纯函数模块，定义清单契约、SHA-256 计算与校验；校验失败必须**失败关闭**（返回问题列表，绝不返回 ok）。

```ts
// desktop/src/companyclaw/runtime-manifest.ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Integrity contract for the resources that ship inside the installer.
 *
 * The unified resource pipeline writes this manifest at build time and the app
 * reads it back at startup: if a shipped component is missing or was altered,
 * the app must say so in plain Chinese instead of failing later inside the
 * Gateway or the broker.
 */
export const RUNTIME_MANIFEST_CONTRACT = "companyclaw.runtime-manifest.v1";
export const RUNTIME_MANIFEST_FILE = "runtime-manifest.json";

export type RuntimeResourceKind =
  | "node"
  | "openclaw"
  | "broker"
  | "windows-node"
  | "appcontainer"
  | "plugin"
  | "skill";

export interface RuntimeManifestEntry {
  /** POSIX-style path relative to the resources root. */
  path: string;
  kind: RuntimeResourceKind;
  version: string;
  arch: "x64" | "arm64";
  sha256: string;
  license: string;
}

export interface RuntimeManifest {
  contract: typeof RUNTIME_MANIFEST_CONTRACT;
  arch: "x64" | "arm64";
  buildSha: string;
  entries: RuntimeManifestEntry[];
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export type RuntimeManifestVerification =
  | { ok: true; checked: number }
  | { ok: false; problems: string[] };

/**
 * Verifies every manifest entry against the files actually on disk.
 *
 * A missing file, a changed hash, a duplicate or a path that escapes the
 * resources root are all failures: a partially installed runtime must never be
 * treated as usable.
 */
export function verifyRuntimeManifest(
  manifest: unknown,
  resourcesRoot: string,
): RuntimeManifestVerification {
  const problems: string[] = [];
  if (typeof manifest !== "object" || manifest === null) {
    return { ok: false, problems: ["manifest-invalid"] };
  }
  const candidate = manifest as Partial<RuntimeManifest>;
  if (candidate.contract !== RUNTIME_MANIFEST_CONTRACT) {
    problems.push(`contract-mismatch: ${String(candidate.contract)}`);
  }
  const entries = Array.isArray(candidate.entries) ? candidate.entries : [];
  if (entries.length === 0) problems.push("entries-empty");

  const seen = new Set<string>();
  for (const entry of entries) {
    const relativePath = entry?.path;
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      problems.push("entry-path-invalid");
      continue;
    }
    if (relativePath.includes("..") || path.isAbsolute(relativePath)) {
      problems.push(`entry-path-escapes-root: ${relativePath}`);
      continue;
    }
    if (seen.has(relativePath)) {
      problems.push(`entry-duplicated: ${relativePath}`);
      continue;
    }
    seen.add(relativePath);
    const absolutePath = path.join(resourcesRoot, relativePath);
    if (!existsSync(absolutePath)) {
      problems.push(`missing: ${relativePath}`);
      continue;
    }
    let actual: string;
    try {
      actual = sha256File(absolutePath);
    } catch (error) {
      problems.push(
        `unreadable: ${relativePath} (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (actual !== entry.sha256) problems.push(`hash-mismatch: ${relativePath}`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, checked: entries.length };
}
```

#### Reason

R1-C 要求"清单与哈希和实际解包内容一致，缺文件或哈希错误构建失败"；V2 §6.2 要求"首次运行校验资源完整性；缺损时给出中文提示，而不是弹 npm 命令"。这是全部后续步骤的判定基础。

#### Risk

- 校验入口若接入启动路径，异常必须被捕获，**不得阻塞应用启动**（否则比"提示"更糟）。
- `..` 与绝对路径必须拒绝，避免清单被用来读取包外文件。

#### Verification

```powershell
cd desktop
npx vitest run src/companyclaw/runtime-manifest.test.ts
npx tsc --noEmit
```

测试至少覆盖：全部匹配 → `ok:true` 且 `checked` 正确；篡改内容 → `hash-mismatch`；删文件 → `missing`；空 entries → `entries-empty`；契约不符 → `contract-mismatch`；`../` 路径 → `entry-path-escapes-root`；重复路径 → `entry-duplicated`；非对象输入 → `manifest-invalid`。

- [ ] **Step 1.1: 写失败测试**（新建 `runtime-manifest.test.ts`，用 `os.tmpdir()` + `mkdtempSync` 建真实文件，覆盖上述 8 个用例）
- [ ] **Step 1.2: 运行测试确认失败**

```powershell
cd desktop
npx vitest run src/companyclaw/runtime-manifest.test.ts
```
预期：FAIL，`Cannot find module './runtime-manifest'`。

- [ ] **Step 1.3: 实现 `runtime-manifest.ts`**（上方完整代码）
- [ ] **Step 1.4: 运行测试确认通过 + 类型检查**

```powershell
cd desktop
npx vitest run src/companyclaw/runtime-manifest.test.ts
npx tsc --noEmit
```
预期：全部 PASS，`tsc` clean。

- [ ] **Step 1.5: 提交**

```powershell
git add desktop/src/companyclaw/runtime-manifest.ts desktop/src/companyclaw/runtime-manifest.test.ts
git commit -m "feat(companyclaw): pin the installer runtime manifest contract"
```

---

### Step 2: 统一生产资源流水线

#### Target

- 新建：`desktop/scripts/prepare-production-resources.mjs`
- 修改：`desktop/package.json`（`scripts`）
- 新建：`desktop/src/companyclaw/production-resources.test.ts`

#### Current Behavior

`desktop/package.json`:

```json
"pack": "npm run prepare-windows-node-resources && npm run pack:prepared",
"pack:prepared": "npm run build && electron-builder --win --x64 --dir",
"dist": "npm run prepare-windows-node-resources && npm run build && electron-builder --win",
"dist:msix": "npm run prepare-resources && npm run build && node scripts/build-msix.mjs"
```

- `dist`（NSIS 正式包）**不装配** `node.exe` / `openclaw.asar`；依赖开发机上"碰巧存在"的 `desktop/resources/`（该目录被 `.gitignore:67` 忽略，当前**不存在**）。
- `prepare-resources.mjs` 是 MSIX 专用：先 `rmSync(resourcesDir, {recursive:true, force:true})` **整目录删除**，装配完再 `rmSync(openClawDir)` 删掉 `resources/openclaw/`，同时留下 `openclaw.asar`；无 staging、无 manifest。

#### Change

新增单一流水线，所有阶段失败即中止，最后原子切换：

1. 校验执行环境为真实 `node.exe`（沿用既有断言语义）；
2. 从 `deployer/openclaw_version.py` 读 `OPENCLAW_TARGET_VERSION`（**复用现有读法，不新增版本真源**）；
3. staging 目录 `desktop/.staging-resources/`：复制 `process.execPath` → `node.exe`；
4. `npm install --prefix <staging>/openclaw --omit=dev --no-save --registry <registry> openclaw@<version>`；
5. 校验 `<staging>/openclaw/node_modules/openclaw/openclaw.mjs` 存在；
6. `createPackage(<staging>/openclaw → <staging>/openclaw.asar)` 并断言 archive 内含该入口（保留 asar 形态：`bundled-runtime.ts` 运行时解包后才加载）；
7. 调用既有 `prepare-windows-node-resources.mjs --arch=x64`（**直接复用其 MXC 哈希与子模块 revision 校验**）；
8. `npm run build`（broker tsc）→ 复制 `broker/dist` + `broker/scripts` → `<staging>/companyclaw-broker/`；断言 `dist/main.js` 存在；
9. 写 `<staging>/runtime-manifest.json`（契约 `companyclaw.runtime-manifest.v1`，逐项 `sha256`/`kind`/`version`/`arch`/`license`；`buildSha` 取 `git rev-parse HEAD`）；
10. 用 Step 1 的校验算法语义复核 staging（缺项/哈希不符即失败）；
11. 原子切换：把 staging 内容移到 `desktop/resources/`（先写 `.new-<pid>` 再 `renameSync`），**不触碰** `userData` 与任何旧发行目录。

`package.json` 变更：

```json
"release:win": "npm run prepare-production-resources && npm run build && electron-builder --win",
"prepare-production-resources": "node scripts/prepare-production-resources.mjs --arch=x64",
"dist": "npm run release:win",
"pack": "npm run prepare-production-resources && npm run pack:prepared"
```

#### Reason

GAP-01（NSIS 资源准备不统一）、GAP-02（Broker 未进包）、R1-A/B/C/D。`dist` 是员工产物的唯一来源，必须自己装配全部资源。

#### Risk

- 流水线依赖构建机网络（`npm install openclaw`），属**构建机**依赖，不违反员工零依赖。
- `desktop/resources/` 被 git 忽略，管道必须能在"目录不存在"时自我创建。
- **不得**直接 `rmSync` 生产目录：中断时必须保留上一份可用资源。

#### Verification

```powershell
cd desktop
npx vitest run src/companyclaw/production-resources.test.ts
```

`production-resources.test.ts` 断言（读源码，防止契约漂移）：

```ts
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const desktopDir = path.resolve(__dirname, "../..");

function read(relative: string): string {
  return readFileSync(path.join(desktopDir, relative), "utf-8");
}

describe("unified production resource pipeline", () => {
  const script = read("scripts/prepare-production-resources.mjs");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("is the entry point used by the official release command", () => {
    expect(pkg.scripts["prepare-production-resources"]).toContain(
      "scripts/prepare-production-resources.mjs",
    );
    expect(pkg.scripts.dist).toBe("npm run release:win");
    expect(pkg.scripts["release:win"]).toContain("prepare-production-resources");
    expect(pkg.scripts["release:win"]).toContain("electron-builder --win");
  });

  it("stages every runtime component the installer must carry", () => {
    for (const produced of [
      "node.exe",
      "openclaw.asar",
      "companyclaw-broker",
      "runtime-manifest.json",
    ]) {
      expect(script).toContain(produced);
    }
    expect(script).toContain("prepare-windows-node-resources.mjs");
  });

  it("never deletes the live resources directory outright", () => {
    // Interrupting the pipeline must not leave a half-empty resources folder.
    expect(script).not.toMatch(/rmSync\(\s*resourcesDir/);
    expect(script).toContain("staging");
  });

  it("keeps the version true source in the deployer", () => {
    expect(script).toContain("openclaw_version.py");
    expect(script).toContain("OPENCLAW_TARGET_VERSION");
  });
});
```

手动流水线验证（构建机、需网络）：

```powershell
cd desktop
npm run prepare-production-resources
Test-Path resources\node.exe
Test-Path resources\openclaw.asar
Test-Path resources\companyclaw-broker\dist\main.js
Get-Content resources\runtime-manifest.json | Select-Object -First 20
```

哈希篡改负向验证：

```powershell
# 篡改任意一个已登记文件后重跑，必须失败并报 hash-mismatch
Add-Content desktop\resources\companyclaw-broker\dist\main.js "// tampered"
cd desktop; npm run prepare-production-resources
```
预期：非零退出并明确报 `hash-mismatch`（或重建后哈希恢复），**不得静默通过**。

- [ ] **Step 2.1: 写失败测试**（`production-resources.test.ts` 上方代码）
- [ ] **Step 2.2: 运行确认失败**

```powershell
cd desktop
npx vitest run src/companyclaw/production-resources.test.ts
```
预期：FAIL（`prepare-production-resources` 未定义 / 文件不存在）。

- [ ] **Step 2.3: 实现流水线脚本 + `package.json` scripts**
- [ ] **Step 2.4: 运行测试确认通过**

```powershell
cd desktop
npx vitest run src/companyclaw/production-resources.test.ts
```
预期：PASS。

- [ ] **Step 2.5: 构建机实跑流水线并记录输出**

```powershell
cd desktop
npm run prepare-production-resources
```
预期：退出码 0；`resources/` 含 4 类产物 + manifest。**若缺网络/子模块则记 `BLOCKED`**（解除条件：构建机可访问 npm registry 且 `third_party/openclaw-windows-node/source` 已初始化）。

- [ ] **Step 2.6: 提交**

```powershell
git add desktop/scripts/prepare-production-resources.mjs desktop/package.json desktop/src/companyclaw/production-resources.test.ts
git commit -m "feat(companyclaw): assemble every runtime resource through one pipeline"
```

---

### Step 3: electron-builder 契约对齐

#### Target

- 修改：`desktop/electron-builder.yml`（`extraResources`）
- 修改：`desktop/src/companyclaw/product-identity.test.ts`
- 新建：`desktop/src/companyclaw/extra-resources-contract.test.ts`

#### Current Behavior

```yaml
extraResources:
  - from: resources/node.exe
    to: node.exe
  - from: resources/openclaw/
    to: openclaw/
  - from: resources/openclaw.asar
    to: openclaw.asar
  - from: resources/windows-node/
    to: windows-node/
  # …appcontainer、skills 条目…
```

`from: resources/openclaw/` 永远不存在（`prepare-resources.mjs` 装配后即删除该目录，且 `bundled-runtime.ts` 只读 `openclaw.asar`）；**没有任何 `companyclaw-broker` 条目**，而 `broker-paths.ts` 打包后期望 `<resources>/companyclaw-broker`。

`product-identity.test.ts` 用 `expect(config).toContain("to: openclaw/")` **把这条死引用钉住了**，删除时必须同步修正，否则会红。

#### Change

1. 删除 `from: resources/openclaw/` / `to: openclaw/` 一对；
2. 新增：

```yaml
  - from: resources/companyclaw-broker/dist/
    to: companyclaw-broker/dist/
  - from: resources/companyclaw-broker/scripts/
    to: companyclaw-broker/scripts/
  - from: resources/runtime-manifest.json
    to: runtime-manifest.json
```

3. `product-identity.test.ts` 的 `keeps resolving bundled resources from their upstream paths` 用例改为：

```ts
  it("keeps resolving bundled resources from their upstream paths", () => {
    const config = readBuilderConfig();
    // bundled-runtime.ts reads openclaw.asar from process.resourcesPath; the
    // unpacked `resources/openclaw/` directory is never materialised by the
    // unified pipeline, so shipping it would add a dead extraResources entry.
    expect(config).toContain("to: openclaw.asar");
    expect(config).not.toContain("from: resources/openclaw/");
    // broker-paths.ts resolves resources/companyclaw-broker in a packaged build.
    expect(config).toContain("to: companyclaw-broker/dist/");
    expect(config).toContain("to: companyclaw-broker/scripts/");
    expect(config).toContain("to: AppContainerLauncher.exe");
    expect(config).toContain("to: sandbox-preload.js");
  });
```

4. 新增契约测试，防止死引用复发。来源必须显式分成三类，因为只有第三类可以在源码检出中直接断言存在（已实测：`appcontainer/bin/Release/net9.0-windows/win-x64/AppContainerLauncher.exe` **当前不存在**，需先 `dotnet publish`；`../appcontainer/sandbox-preload.js` 与 `../skills/rednote-publisher/` 在干净检出中存在；`desktop/resources/` **当前不存在**，由统一流水线产生）：

```ts
// desktop/src/companyclaw/extra-resources-contract.test.ts
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const desktopDir = path.resolve(__dirname, "../..");

/**
 * extraResources sources fall into three groups, and only the last one can be
 * asserted against the filesystem in a source checkout:
 *
 *  1. produced by the unified runtime pipeline (`npm run release:win`),
 *  2. produced by build steps that run before electron-builder
 *     (`dotnet publish` emits the AppContainer launcher into bin/),
 *  3. present in a plain source checkout.
 */
const PRODUCED_BY_PIPELINE = [
  "resources/node.exe",
  "resources/openclaw.asar",
  "resources/companyclaw-broker/",
  "resources/windows-node/",
  "resources/runtime-manifest.json",
];

const PRODUCED_BY_BUILD = [
  "../appcontainer/bin/Release/net9.0-windows/win-x64/AppContainerLauncher.exe",
];

const REQUIRED_IN_SOURCE = [
  "../appcontainer/sandbox-preload.js",
  "../appcontainer/sandbox-state.js",
  "../appcontainer/sandbox-permission.js",
  "../appcontainer/sandbox-fs-hooks.js",
  "../appcontainer/sandbox-cp-hooks.js",
  "../appcontainer/sandbox-sensitive.js",
  "../appcontainer/path-extraction.js",
  "../skills/rednote-publisher/",
];

function extraResourceSources(): string[] {
  const config = readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf-8");
  return config
    .split("\n")
    .map((line) => line.match(/^\s*-\s*from:\s*(.+?)\s*$/)?.[1])
    .filter((value): value is string => typeof value === "string");
}

describe("installer extraResources contract", () => {
  it("declares every source the unified pipeline produces", () => {
    const sources = extraResourceSources();
    for (const produced of PRODUCED_BY_PIPELINE) {
      expect(sources, `pipeline output not shipped: ${produced}`).toContain(produced);
    }
  });

  it("keeps the sources that must exist in a source checkout", () => {
    const sources = extraResourceSources();
    for (const required of REQUIRED_IN_SOURCE) {
      expect(sources, `source not shipped: ${required}`).toContain(required);
      expect(
        existsSync(path.resolve(desktopDir, required)),
        `declared source is missing from the checkout: ${required}`,
      ).toBe(true);
    }
  });

  it("ships the AppContainer launcher that the build publishes", () => {
    const sources = extraResourceSources();
    for (const built of PRODUCED_BY_BUILD) {
      expect(sources, `build output not shipped: ${built}`).toContain(built);
    }
  });

  it("never points at a directory the pipeline deletes", () => {
    const sources = extraResourceSources();
    // The unpacked OpenClaw tree is created and then removed by the pipeline;
    // bundled-runtime.ts reads openclaw.asar instead, so shipping both would add
    // an entry that can never be found.
    expect(sources).not.toContain("resources/openclaw/");
  });

  it("ships the broker so a packaged app can start it", () => {
    const sources = extraResourceSources();
    expect(sources.some((source) => source.startsWith("resources/companyclaw-broker"))).toBe(true);
  });

  it("accounts for every declared source in one of the three groups", () => {
    const known = new Set([...PRODUCED_BY_PIPELINE, ...PRODUCED_BY_BUILD, ...REQUIRED_IN_SOURCE]);
    const unknown = extraResourceSources().filter((source) => !known.has(source));
    // An unrecognised source is not automatically wrong, but it must be added to
    // one of the lists above so its existence story is explicit.
    expect(unknown, `unclassified extraResources sources: ${unknown.join(", ")}`).toEqual([]);
  });
});
```

#### Reason

GAP-02；`broker-paths.ts` 与构建产物必须共享同一目录契约，否则打包版 Broker 永远找不到入口。

#### Risk

- 契约测试分类是**实测结论**，不是猜测：`desktop/resources/` 当前不存在（`.gitignore:67` 忽略），`appcontainer/bin/Release/net9.0-windows/win-x64/AppContainerLauncher.exe` 当前不存在（需 `dotnet publish`）。因此第三类（`REQUIRED_IN_SOURCE`）才做文件系统断言，第二类只断言声明存在。
- `resources/openclaw/` 一旦被重新加回就会红——这是有意为之（`bundled-runtime.ts` 只读 asar）。
- 不得因为测试需要而放宽 `installer-scope.test.ts` 的 Per-User / 无提权断言。

#### Verification

```powershell
cd desktop
npx vitest run src/companyclaw/extra-resources-contract.test.ts src/companyclaw/product-identity.test.ts src/companyclaw/installer-scope.test.ts
```
预期：全部 PASS；`installer-scope.test.ts` 的 `perMachine:false` / `allowElevation:false` / `shortcutName: CompanyClaw` 断言不受影响。

- [ ] **Step 3.1: 写失败测试**（新建 `extra-resources-contract.test.ts`）
- [ ] **Step 3.2: 运行确认失败**

```powershell
cd desktop
npx vitest run src/companyclaw/extra-resources-contract.test.ts
```
预期：FAIL（缺 `resources/companyclaw-broker/`）。

- [ ] **Step 3.3: 修改 `electron-builder.yml` 与 `product-identity.test.ts`**
- [ ] **Step 3.4: 运行测试确认通过**

```powershell
cd desktop
npx vitest run src/companyclaw/extra-resources-contract.test.ts src/companyclaw/product-identity.test.ts
```
预期：PASS。

- [ ] **Step 3.5: 提交**

```powershell
git add desktop/electron-builder.yml desktop/src/companyclaw/extra-resources-contract.test.ts desktop/src/companyclaw/product-identity.test.ts
git commit -m "fix(companyclaw): ship the broker and drop the dead openclaw resource entry"
```

---

### Step 4: 首次运行自动初始化 + 资源完整性诊断

#### Target

- 新建：`desktop/src/companyclaw/first-run-init.ts`
- 新建：`desktop/src/companyclaw/first-run-init.test.ts`
- 修改：`desktop/src/main.ts`（`startApplicationServices()` 内新增调用；新增 `ensureCompanyClawFirstRunConfiguration()` 与 `reportRuntimeIntegrity()`）

#### Current Behavior

`desktop/src/main.ts` 的 `startGatewayInner()` 只读取 `config?.gateway?.auth?.token` 与 `config?.gateway?.port`，**从不写入**；唯一写入者是旧 Python 安装器（`deployer/windows_setup.py` 的 `auth["token"] = secrets.token_hex(24)`）与旧 `browser` 配置块。因此 NSIS 包首次启动时 `gatewayToken` 恒为 `""`，日志会打印 `auth=missing`。

#### Change

纯函数模块（可离线单测）：

```ts
// desktop/src/companyclaw/first-run-init.ts
import { DEFAULT_PORT } from "../constants";

/**
 * First-run configuration for a machine that never ran the legacy Python
 * installer.
 *
 * The NSIS package is the only supported employee distribution, and it ships
 * no pre-generated `openclaw.json`. Without this step the Gateway starts with
 * an empty auth token and browser automation has no executable configured —
 * both of which used to be written by `deployer/windows_setup.py`.
 *
 * Planning is pure: the caller decides where and how to persist the result.
 */

export const GATEWAY_AUTH_MODE = "token";

export interface FirstRunConfigInput {
  existing: Record<string, unknown> | null;
  createToken: () => string;
  port?: number;
}

export interface FirstRunConfigResult {
  config: Record<string, unknown>;
  changed: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function planFirstRunConfig(input: FirstRunConfigInput): FirstRunConfigResult {
  const config: Record<string, unknown> = { ...(input.existing ?? {}) };
  const changed: string[] = [];

  const gateway = isPlainObject(config.gateway) ? { ...config.gateway } : {};
  const auth = isPlainObject(gateway.auth) ? { ...gateway.auth } : {};

  const hasToken = typeof auth.token === "string" && auth.token.trim().length > 0;
  if (!hasToken) {
    auth.token = input.createToken();
    changed.push("gateway.auth.token");
  }
  if (auth.mode !== GATEWAY_AUTH_MODE) {
    auth.mode = GATEWAY_AUTH_MODE;
    changed.push("gateway.auth.mode");
  }
  gateway.auth = auth;

  const port = gateway.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    gateway.port = input.port ?? DEFAULT_PORT;
    changed.push("gateway.port");
  }
  config.gateway = gateway;

  return { config, changed };
}

export interface BrowserConfigResult {
  config: Record<string, unknown>;
  changed: string[];
}

/**
 * Fills in the browser section only when the user has not configured it.
 *
 * OpenClaw ships browser automation as an optional capability that drives an
 * already-installed Chromium-family browser; Windows 11 always provides Edge,
 * so nothing has to be downloaded. An existing user value is never replaced.
 */
export function planBrowserConfig(
  config: Record<string, unknown>,
  edgePath: string | null,
): BrowserConfigResult {
  const next: Record<string, unknown> = { ...config };
  const changed: string[] = [];
  const browser = isPlainObject(next.browser) ? { ...next.browser } : {};

  if (typeof browser.enabled !== "boolean") {
    browser.enabled = true;
    changed.push("browser.enabled");
  }
  if (
    edgePath &&
    (typeof browser.executablePath !== "string" || browser.executablePath.trim().length === 0)
  ) {
    browser.executablePath = edgePath;
    changed.push("browser.executablePath");
  }
  next.browser = browser;
  return { config: next, changed };
}

/** Candidate Edge locations, mirroring the legacy installer's probe order. */
export function edgeExecutableCandidates(
  env: Record<string, string | undefined>,
): string[] {
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  if (localAppData) {
    candidates.push(`${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`);
  }
  candidates.push(`${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`);
  candidates.push(`${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`);
  return candidates;
}

/** Returns the first Edge that actually exists, or null when there is none. */
export function findEdgeExecutable(
  env: Record<string, string | undefined>,
  exists: (candidate: string) => boolean,
): string | null {
  for (const candidate of edgeExecutableCandidates(env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
```

`main.ts` 接线（新增两个函数，并在 `startApplicationServices()` 开头调用）：

```ts
/**
 * Writes the configuration the packaged app needs before the Gateway starts.
 *
 * Only the default (non-MXC) security mode is handled here: the Windows Node +
 * MXC path pins and validates `openclaw.json` itself, and rewriting the file
 * underneath it would fight that policy.
 */
function ensureCompanyClawFirstRunConfiguration(): void {
  if (isWindowsNodeMxcDesired()) return;
  const configPath = getConfigPath();
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  } catch (error) {
    console.error("[companyclaw] Cannot create the state directory:", error);
    return;
  }
  const existing = readConfig();
  const planned = planFirstRunConfig({
    existing,
    // Two UUIDs give a 64-hex-character token without a new dependency; the
    // legacy installer used secrets.token_hex(24) for the same purpose.
    createToken: () => `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
  });
  const withBrowser = planBrowserConfig(
    planned.config,
    findEdgeExecutable(process.env, (candidate) => fs.existsSync(candidate)),
  );
  const changed = [...planned.changed, ...withBrowser.changed];
  if (changed.length === 0) return;
  try {
    assertConfigWriteAllowed(withBrowser.config, existing);
    writeConfigTextAtomically(JSON.stringify(withBrowser.config, null, 2));
    console.log(`[companyclaw] First-run configuration written: ${changed.join(", ")}`);
  } catch (error) {
    // A failure here must not take the app down; the Gateway will report the
    // missing token on its own and the UI shows that log.
    console.error("[companyclaw] First-run configuration failed:", error);
  }
}

/**
 * Reports missing or altered bundled resources in plain Chinese.
 *
 * Runs only in a packaged build: a source checkout has no manifest and is not
 * an employee installation.
 */
function reportRuntimeIntegrity(): void {
  if (!app.isPackaged) return;
  const manifestPath = path.join(process.resourcesPath, RUNTIME_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    mainWindow?.webContents.send(
      "gateway:log",
      `[warn] 安装资源清单缺失（${RUNTIME_MANIFEST_FILE}）。请重新运行 CompanyClaw 安装包修复安装。`,
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    mainWindow?.webContents.send(
      "gateway:log",
      `[warn] 安装资源清单无法读取：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const verification = verifyRuntimeManifest(parsed, process.resourcesPath);
  if (verification.ok) {
    console.log(`[companyclaw] Runtime manifest verified (${verification.checked} entries)`);
    return;
  }
  mainWindow?.webContents.send(
    "gateway:log",
    `[warn] 运行资源校验未通过：${verification.problems.join("; ")}。请重新运行 CompanyClaw 安装包修复安装（无需手动安装任何组件）。`,
  );
}
```

在 `startApplicationServices()` 中的插入点（现有实现开头）：

```ts
async function startApplicationServices(): Promise<void> {
  ensureCompanyClawFirstRunConfiguration();
  reportRuntimeIntegrity();
  if (!isWindowsNodeMxcDesired()) {
    await startGateway();
    return;
  }
  // …既有 MXC 分支保持不变…
}
```

新增 import：

```ts
import { planBrowserConfig, planFirstRunConfig, findEdgeExecutable } from "./companyclaw/first-run-init";
import { RUNTIME_MANIFEST_FILE, verifyRuntimeManifest } from "./companyclaw/runtime-manifest";
```

#### Reason

这是"首次启动自动生成 Gateway 配置并完成本地初始化"（V2 §4.3)与"支持启动失败自动诊断及中文提示"（本次纠偏第三节）的直接实现，也是员工零命令行的前提：没有 token 的 Gateway 无法建立鉴权连接。

#### Risk

- **写入位置**：`getOpenClawStateDir()` 解析到 `%APPDATA%\openclaw`（或 `~/.openclaw`），符合"不在安装目录保存用户配置"。
- **不覆盖用户配置**：只在缺失时写入；`browser.executablePath` 已有值时不动。
- **MXC 模式**：明确跳过，避免与 `applyWindowsNodeMxcGatewayPolicy()` 的 config pinning 冲突。
- **失败不阻塞启动**：写入失败只记录日志 + 走既有 `gateway:log` 通道，应用仍可启动。
- **用户数据不回滚**：初始化只做增量合并，绝不重写整份配置为默认值。

#### Verification

```powershell
cd desktop
npx vitest run src/companyclaw/first-run-init.test.ts
npx tsc --noEmit
```

单测至少覆盖：

| 用例 | 期望 |
|---|---|
| 空配置 | 写入 `gateway.auth.token` + `gateway.auth.mode="token"` + `gateway.port=DEFAULT_PORT`，`changed` 含三项 |
| **已有 token** | `token` 保持原值，`changed` 不含 `gateway.auth.token`（幂等） |
| 已有有效 port | 不覆盖 |
| 非对象 `auth`（如字符串） | 被替换为对象，不抛错 |
| 用户已设 `browser.executablePath` | 保持原值 |
| 找不到 Edge | 只写 `browser.enabled`，不写 `executablePath` |
| 非 Windows 环境变量集合 | 候选列表退化为默认 `C:\Program Files\…`，不抛错 |
| 不修改入参对象 | `existing` 保持原样（无副作用） |

- [ ] **Step 4.1: 写失败测试**（`first-run-init.test.ts`，覆盖上表）
- [ ] **Step 4.2: 运行确认失败**

```powershell
cd desktop
npx vitest run src/companyclaw/first-run-init.test.ts
```
预期：FAIL（`Cannot find module './first-run-init'`）。

- [ ] **Step 4.3: 实现 `first-run-init.ts`**
- [ ] **Step 4.4: 运行测试确认通过**
- [ ] **Step 4.5: 接线到 `main.ts`（`startApplicationServices()` + 两个新函数 + imports）**
- [ ] **Step 4.6: 全量类型检查 + 回归**

```powershell
cd desktop
npx tsc --noEmit
npx vitest run
```
预期：`tsc` clean；desktop 全量不低于 `1405 passed`。

- [ ] **Step 4.7: 提交**

```powershell
git add desktop/src/companyclaw/first-run-init.ts desktop/src/companyclaw/first-run-init.test.ts desktop/src/main.ts
git commit -m "feat(companyclaw): initialise the gateway and browser config on first run"
```

---

### Step 5: Broker 生产启动修复

#### Target

- 修改：`desktop/src/companyclaw/broker-client.ts`（`BrokerClientOptions`、`startInternal()`）
- 修改：`desktop/src/companyclaw/ipc.ts`（`CompanyClawIpcOptions`、`createCompanyClawRuntime()`）
- 修改：`desktop/src/main.ts`（`registerIpcHandlers()` 内的 `companyClawOptions`）
- 新建：`desktop/src/companyclaw/broker-client-spawn.test.ts`

#### Current Behavior

```ts
// desktop/src/companyclaw/broker-client.ts  startInternal()
const spawnProcess = this.options.spawnProcess ?? spawn;
const entry = path.join(this.options.brokerDir, "dist", "main.js");
const child = spawnProcess(process.execPath, [entry], { /* … */ });
```

打包后 `process.execPath` 是 `CompanyClaw.exe`，用它执行 `main.js` 会启动一个 Electron 实例而不是 Node，Broker 永远起不来。`desktop/src/path-resolver.ts` 早已提供 `resolveNodePath()`（打包资源优先 + 版本白名单），但 Broker 是唯一没用它的执行器。

#### Change

```ts
// broker-client.ts —— options 增加一项
export interface BrokerClientOptions {
  /** Directory containing the compiled broker (dist/). */
  brokerDir: string;
  scriptDir: string | null;
  /**
   * Node runtime that runs the broker. Must be a real node.exe: in a packaged
   * build `process.execPath` is CompanyClaw.exe, which cannot execute the
   * broker's JavaScript entry point.
   */
  nodePath?: string;
  ownerSid: string;
  deviceId: string;
  allowedProcesses: string[];
  allowedWindowTitles: string[];
  /** Overridable for tests. */
  spawnProcess?: typeof spawn;
  now?: () => Date;
}
```

```ts
// startInternal()
const spawnProcess = this.options.spawnProcess ?? spawn;
const entry = path.join(this.options.brokerDir, "dist", "main.js");
// The broker always runs on the bundled private Node runtime; falling back to
// process.execPath only keeps source checkouts and unit tests working.
const command = this.options.nodePath ?? process.execPath;
const child = spawnProcess(command, [entry], { /* 既有参数不变 */ });
```

```ts
// ipc.ts —— CompanyClawIpcOptions 增加
  /** Private Node runtime used to launch the broker in a packaged build. */
  nodePath?: string;
// createCompanyClawRuntime 内
    ? new BrokerClient({
        brokerDir: options.broker.brokerDir,
        scriptDir: resolveBrokerScriptDir(options.broker.brokerDir),
        ...(options.nodePath ? { nodePath: options.nodePath } : {}),
        ownerSid: options.ownerSid,
        deviceId: options.deviceId,
        allowedProcesses: [],
        allowedWindowTitles: [],
      })
```

```ts
// main.ts —— registerIpcHandlers() 内的 companyClawOptions
    const companyClawOptions = {
      userDataDir: companyClawUserDataDir,
      ticketSecret,
      ownerSid: resolveOwnerSid(),
      deviceId: deviceIdentity.deviceId,
      nodePath: resolveNodePath(),
      broker: { brokerDir: resolveBrokerDir({ /* 不变 */ }) },
    };
```

#### Reason

GAP-03。V2 §17 明列"把 `CompanyClaw.exe` 当作 Node 启动 Broker"为高风险；§2 要求"生产环境 Broker 必须使用正确的私有 Node 运行时启动"。

#### Risk

- `resolveNodePath()` 在无可用 Node 时**抛错**。它位于 `registerIpcHandlers()` 内既有的 `try/catch` 中（失败只记录 `[companyclaw] Failed to register security-core IPC`，不阻断应用），行为可接受；但需在 Step 5 手动验证该日志路径仍只是降级。
- `nodePath` 可选 → 既有测试与开发模式行为不变。

#### Verification

```powershell
cd desktop
npx vitest run src/companyclaw/broker-client-spawn.test.ts
npx tsc --noEmit
```

测试（用假 `spawnProcess` 注入，不真起进程）：

```ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BrokerClient } from "./broker-client";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function clientWith(nodePath: string | undefined) {
  const calls: SpawnCall[] = [];
  const child = new FakeChild();
  const client = new BrokerClient({
    brokerDir: path.join("C:", "app", "resources", "companyclaw-broker"),
    scriptDir: path.join("C:", "app", "resources", "companyclaw-broker", "scripts"),
    ...(nodePath ? { nodePath } : {}),
    ownerSid: "S-1-5-21-0",
    deviceId: "device-1",
    allowedProcesses: [],
    allowedWindowTitles: [],
    spawnProcess: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      setImmediate(() => child.stdout.write('{"port":41234}\n'));
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });
  return { client, calls };
}

describe("broker production startup", () => {
  it("launches the broker on the configured private Node runtime", async () => {
    const nodePath = path.join("C:", "app", "resources", "node.exe");
    const { client, calls } = clientWith(nodePath);
    await client.start();
    expect(calls[0].command).toBe(nodePath);
    expect(calls[0].args).toEqual([
      path.join("C:", "app", "resources", "companyclaw-broker", "dist", "main.js"),
    ]);
    await client.stop();
  });

  it("never puts the execution token on the command line", async () => {
    const { client, calls } = clientWith(path.join("C:", "app", "resources", "node.exe"));
    await client.start();
    expect(JSON.stringify(calls[0].args)).not.toContain(client.getToken());
    expect(calls[0].env.COMPANYCLAW_BROKER_TOKEN).toBe(client.getToken());
    await client.stop();
  });

  it("honours a node path that contains spaces and non-ASCII characters", async () => {
    const nodePath = path.join("C:", "程序 文件", "CompanyClaw", "node.exe");
    const { client, calls } = clientWith(nodePath);
    await client.start();
    expect(calls[0].command).toBe(nodePath);
    await client.stop();
  });
});
```

并新增源码级接线契约（防止只改客户端忘了传参）：

```ts
  it("wires the resolved Node runtime from main into the broker client", () => {
    const ipcSource = readFileSync(path.join(srcDir, "companyclaw", "ipc.ts"), "utf-8");
    const mainSource = readFileSync(path.join(srcDir, "main.ts"), "utf-8");
    expect(ipcSource).toContain("options.nodePath");
    expect(mainSource).toContain("nodePath: resolveNodePath()");
  });
```

- [ ] **Step 5.1: 写失败测试**（`broker-client-spawn.test.ts`）
- [ ] **Step 5.2: 运行确认失败**

```powershell
cd desktop
npx vitest run src/companyclaw/broker-client-spawn.test.ts
```
预期：FAIL —— `calls[0].command` 为 `process.execPath` 而非 `nodePath`。

- [ ] **Step 5.3: 实现 `broker-client.ts` / `ipc.ts` / `main.ts` 三处改动**
- [ ] **Step 5.4: 运行测试确认通过 + 回归**

```powershell
cd desktop
npx vitest run src/companyclaw/broker-client-spawn.test.ts
npx tsc --noEmit
npx vitest run
```
预期：新测试 PASS；desktop 全量不低于基线。

- [ ] **Step 5.5: 提交**

```powershell
git add desktop/src/companyclaw/broker-client.ts desktop/src/companyclaw/ipc.ts desktop/src/main.ts desktop/src/companyclaw/broker-client-spawn.test.ts
git commit -m "fix(companyclaw): start the broker on the bundled private Node runtime"
```

---

### Step 6: 构建入口收敛为 NSIS 主线

#### Target

- 修改：`build.ps1`（Step 3 调用统一流水线；Step 5–7 标注为兼容渠道）
- 修改：`docs/companyclaw/IMPLEMENTATION_STATUS.md` 与新增 `docs/companyclaw/13-employee-install-guide.md`（员工视角安装说明）

#### Current Behavior

`build.ps1` Step 3 执行 `npm run pack:prepared`（`electron-builder --win --x64 --dir`，**只出 unpacked 目录，不出 NSIS 安装包**）；Step 4 打包 portable zip；Step 5 用 PyInstaller 构建 `MicroClawInstaller`；Step 7 用 `installer/microclaw-setup.nsi` 出 `dist/MicroClawSetup.exe`，其头部注释写明"the inner installer self-elevates the individual steps (e.g. the Node.js MSI)"——与"员工零依赖"直接冲突。

#### Change

1. Step 3 改为调用正式发布命令：

```powershell
Write-Host "`n=== Step 3/7: Build & pack desktop ===" -ForegroundColor Cyan
Push-Location "$root\desktop"
try {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    # Official employee artifact: NSIS Per-User installer built from the
    # unified runtime pipeline (node.exe + openclaw.asar + broker + manifest).
    npm run release:win 2>&1 | ForEach-Object { Write-Host "  $_" }
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: desktop release build failed" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}
```

2. Step 5/7 之前加显式标注（不删除旧路径，避免破坏既有兼容渠道）：

```powershell
# --- Legacy channel (kept for compatibility, NOT the employee artifact) ---
# The supported employee distribution is
#   desktop\release\CompanyClaw-Setup-<version>.exe   (NSIS, per-user)
# produced by Step 3. The PyInstaller + installer\microclaw-setup.nsi path below
# historically installed Node.js system-wide through the inner installer, which
# the V2 requirement forbids for everyday users. Keep it only for the legacy
# channel and never validate the employee flow against it.
```

3. 结束横幅改写，明确唯一员工产物路径与"未签名"标注位。

#### Reason

GAP-04；V2 §16 要求"正式发行选择：NSIS Per-User x64 作为 V2 主线；MSIX 和 PyInstaller 仅为兼容/后续渠道，不允许污染主流程"；§17 明列"创建 Per-User NSIS，实际首次运行却自动提权安装系统 Node"为不合格。

#### Risk

- `release:win` 依赖 Step 2 的流水线可用（构建机网络 + 子模块），本机**无法执行** → 该步实测记 `BLOCKED`。
- Step 4 的 portable zip 读 `desktop\release\win-unpacked\*`；`electron-builder --win` 同样产出该目录，兼容。
- 不改 `installer-scope.test.ts` 断言（它只校验 `electron-builder.yml`）。

#### Verification

```powershell
# 静态：确认正式入口已切换
Select-String -Path build.ps1 -Pattern "release:win"
Select-String -Path build.ps1 -Pattern "pack:prepared"   # 应仅出现在 legacy 说明或不再出现
cd desktop
npx vitest run src/companyclaw/installer-scope.test.ts src/companyclaw/product-identity.test.ts
```
产物验证（构建机，记 `BLOCKED` 时写明缺什么）：

```powershell
Get-ChildItem desktop\release\*.exe | Select-Object Name, Length
# 期望出现 CompanyClaw-Setup-<version>.exe（NSIS，Per-User）
# 未签名时必须在报告与文档中明示
Get-AuthenticodeSignature desktop\release\CompanyClaw-Setup-*.exe | Select-Object Status
```

- [ ] **Step 6.1: 修改 `build.ps1` Step 3 + 兼容渠道标注 + 结束横幅**
- [ ] **Step 6.2: 静态校验（上条命令）**
- [ ] **Step 6.3: 构建机实跑（记 `BLOCKED` 或产物路径 + 签名状态）**

```powershell
.\build.ps1
```
- [ ] **Step 6.4: 提交**

```powershell
git add build.ps1
git commit -m "build(companyclaw): make the NSIS per-user installer the official artifact"
```

---

### Step 7: 首次使用向导补齐（模型能力探针 + 微信扫码入口）

#### Target

- 修改：`desktop/renderer/src/views/SetupWizard.vue`
- 修改：`desktop/renderer/src/i18n/en-US.ts`、`desktop/renderer/src/i18n/zh-CN.ts`
- 修改：`desktop/renderer/src/views/SettingsView.vue`（模型页展示探针结果）

#### Current Behavior

`SetupWizard.vue` 只做模型表单保存；`window.openclaw.companyClaw.model.probeCapabilities` 已有 IPC + preload，但**renderer 无任何消费者**（`SettingsView.vue` / `SetupWizard.vue` 中零命中）。微信扫码已由 `ChannelsView.vue` 完整实现（`plugin:weixin:login-qr-start` / `-wait`），但向导里没有引导入口。

#### Change

1. 向导保存成功后自动执行真实能力探针，并展示 `summary`（后端已返回中文摘要，含"未验证（不可假定可用）"）：

```ts
const probeSummary = ref("");
const probing = ref(false);

async function runCapabilityProbe(): Promise<void> {
  const bridge = window.openclaw.companyClaw;
  if (!bridge?.model?.probeCapabilities) return;
  probing.value = true;
  probeSummary.value = "";
  try {
    const result = await bridge.model.probeCapabilities({
      baseUrl: form.baseUrl,
      model: form.modelName,
      apiFormat: form.apiFormat,
      apiKey: form.apiKey,
    });
    probeSummary.value = result.summary;
  } catch (error) {
    // A probe failure is information, not a blocker: the model may still work
    // for chat. Never report it as success.
    probeSummary.value = `${t("setup.probeFailed")}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    probing.value = false;
  }
}
```

保存成功后调用 `await runCapabilityProbe();`，并在模板中新增结果展示块（`v-if="probeSummary"`）。

2. 新增"绑定微信"步骤入口（复用既有通道页，不重复实现 QR 逻辑）：

```ts
function goToWeixinBinding(): void {
  router.push("/settings/channels");
}
```
模板新增按钮 + 说明文案，措辞明确"打开微信，用手机扫一扫"，不出现任何命令行字样。

3. i18n 新增键（两种语言必须完全对齐，`desktop/renderer/src/i18n/index.test.ts` 已有对齐校验习惯）：

```
setup.probeTitle            连接与能力自检
setup.probeRunning          正在检测模型能力…
setup.probeFailed           能力自检未完成
setup.probeHint             未验证项不可假定可用；如工具调用为“不支持”，请改用兼容模型
setup.bindWeixin            绑定微信
setup.bindWeixinHint        打开微信，用手机扫一扫完成绑定
```

4. `SettingsView.vue` 模型分区增加"重新检测能力"按钮，复用同一 IPC 与 `summarizeCapabilities` 输出。

#### Reason

V2 §7.3"不仅做文本对话探针"；§13.3 E02 要求真实模型响应 + 实际工具调用证据；纠偏第一节要求员工只做"配置模型 + 微信扫码"两件事。

#### Risk

- 探针需要真实模型凭据；无凭据时 `unknown` 必须原样展示，**不得**显示为"支持"。
- 探针调用会把用户填写的 `apiKey` 作为参数传入主进程（既有实现如此，主进程不持久化）；不得写入日志。

#### Verification

```powershell
cd desktop/renderer
npx vitest run
npx vue-tsc --noEmit   # 若该脚本存在；否则使用项目既有 build 检查
```
手动（需真实凭据，`UNVERIFIED` 直至执行）：向导填入 DeepSeek → 保存 → 摘要出现四行中文结论；对不支持工具调用的模型明确显示"不支持"。

- [ ] **Step 7.1: 写/改 renderer 测试**（若既有 store 测试风格允许，至少断言新增 i18n 键在两语言同时存在）
- [ ] **Step 7.2: 实现向导 + Settings 改动 + i18n**
- [ ] **Step 7.3: 运行 renderer 全量测试与构建检查**
- [ ] **Step 7.4: 提交**

```powershell
git add desktop/renderer/src/views/SetupWizard.vue desktop/renderer/src/views/SettingsView.vue desktop/renderer/src/i18n
git commit -m "feat(companyclaw): show real model capability results in first-run setup"
```

---

### Step 8: Broker 生命周期与"可操作性"区分

#### Target

- 修改：`desktop/src/companyclaw/broker-client.ts`（状态字段 + `getStatus()`）
- 修改：`desktop/src/companyclaw/ipc.ts`（新增 `companyclaw:broker:get-status`）
- 修改：`desktop/src/preload.ts`（新增 `broker.getStatus`）
- 修改：`desktop/src/companyclaw/ipc-contract.test.ts`（**必须同步 `REQUIRED_CHANNELS`**，它断言 handler 数量相等）
- 修改：`desktop/renderer/src/stores/companyclaw.ts`、`desktop/renderer/src/views/TasksView.vue`

#### Current Behavior

`BrokerClient.isRunning()` 只表示"报过端口"。UI 无法区分"Broker 进程活着"与"UIA 在当前会话真的可操作"，也无"最近一次真实调用是否成功"。崩溃后下次 `call()` 会静默重试启动。

#### Change

```ts
// broker-client.ts
  private lastSuccessfulCallAt: string | null = null;
  private lastFailureReason: string | null = null;

  /** Distinguishes a live process from a session that can actually be driven. */
  getStatus(): {
    running: boolean;
    nodePath: string | null;
    lastSuccessfulCallAt: string | null;
    lastFailureReason: string | null;
  } {
    return {
      running: this.isRunning(),
      nodePath: this.options.nodePath ?? null,
      lastSuccessfulCallAt: this.lastSuccessfulCallAt,
      lastFailureReason: this.lastFailureReason,
    };
  }
```

在 `call()` 中记录：`response.status === "ok"` 分支写 `lastSuccessfulCallAt = this.now().toISOString()`；失败分支写 `lastFailureReason = reason`。

IPC / preload / store 各加一处；`TasksView.vue` 新增一行状态：`Broker 进程：存活/未启动` 与 `最近一次真实 UI 自动化：<时间或“尚未发生”>`，后者为空时必须显示"尚未发生"，**不得显示为可用**。

`ipc-contract.test.ts`：在 `REQUIRED_CHANNELS` 追加 `"companyclaw:broker:get-status"`（数量断言随之自动成立）。

#### Reason

V2 §5.7"清晰区分 Broker 进程存活与 UIA 当前会话真正可操作"；§5.4 要求异常时不静默重启。

#### Risk

- `ipc-contract.test.ts` 会因数量断言失败——这是设计意图，必须一并更新，不能放宽断言。
- 渲染层新增文案需双语对齐。

#### Verification

```powershell
cd desktop
npx vitest run src/companyclaw/ipc-contract.test.ts
npx tsc --noEmit
npx vitest run
cd renderer && npx vitest run
```

- [ ] **Step 8.1: 写失败测试**（BrokerClient 状态：初始为 `null`；一次成功调用后 `lastSuccessfulCallAt` 非空；一次失败后 `lastFailureReason` 非空）
- [ ] **Step 8.2: 运行确认失败**
- [ ] **Step 8.3: 实现状态字段 + IPC + preload + store + view + 契约测试更新**
- [ ] **Step 8.4: 全量回归（desktop + renderer）**
- [ ] **Step 8.5: 提交**

```powershell
git commit -m "feat(companyclaw): report broker liveness separately from UIA operability"
```

---

### Step 9: 微信远程闭环（session-source 生产者 + 审批回复拦截）

> **阶段标记：Phase B。** 本步按 ADR 0002 的既定方案实施"最小补丁"，只增不删、不改腾讯核心逻辑。若实施中发现需要改动 `plugins/openclaw-weixin/src/` 更深的调用链，**暂停并提交 Plan Adjustment**（见下方规则）。

#### Target

- 修改：`plugins/openclaw-weixin/src/messaging/process-message.ts`（`processOneMessage()` 内两处**追加**分支）
- 新建：`plugins/openclaw-weixin/src/messaging/desktop-bridge.ts`
- 修改：`plugins/openclaw-weixin/index.ts`（`register()` 内追加监听安装）
- 修改：`desktop/src/main.ts`（`startGatewayInner()` 的 `child.on("message", …)` 消费者：处理 `approval-reply-request` / `session-source`）
- 新增：`docs/companyclaw/ADR/0003-weixin-plugin-bridge.md`

#### Current Behavior

- 会话来源：`desktop/src/main.ts` 的 `cachedRemoteSource` 只有消费者（`child.on("message")` 判断 `msg?.type !== "session-source"`），**全仓库无生产者**；`notifyRemotePermissionNeeded()` 是死代码。
- 入站消息：`plugins/openclaw-weixin/src/messaging/process-message.ts` 的 `processOneMessage()` 命中 `/` 前缀走 `handleSlashCommand`，否则直接进 Agent（`dispatchReplyFromConfig`），**没有任何审批回复拦截**。
- 通道已就绪：`main.ts` 的 Gateway spawn 使用 `stdio: ["ignore","pipe","pipe","ipc"]`，`process.send` 可用。

#### Change

1. 新增插件侧桥接（**裁决权不下沉**：只转发文本、等待桌面答复）：

```ts
// plugins/openclaw-weixin/src/messaging/desktop-bridge.ts
/**
 * Minimal bridge to the CompanyClaw desktop app that owns this Gateway.
 *
 * The plugin never decides an approval: it forwards the raw text and waits for
 * the desktop's verdict. When there is no desktop parent (dev runs, other
 * hosts) or the desktop does not answer in time, the message is released to the
 * AI pipeline unchanged — an approval simply stays pending, which is safe,
 * while swallowing normal chat would not be.
 */
const REPLY_TIMEOUT_MS = 1500;

interface PendingRequest {
  resolve: (handled: boolean) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingRequest>();

function desktopChannel(): NodeJS.Process | null {
  return typeof process.send === "function" ? process : null;
}

export function publishSessionSource(source: {
  channelType: string;
  userId: string;
  accountId: string;
  baseUrl: string;
  token?: string;
  contextToken?: string;
}): void {
  try {
    desktopChannel()?.send?.({ type: "session-source", source });
  } catch {
    // The desktop is optional; a failure here must not affect message handling.
  }
}

export function installDesktopBridgeListener(): void {
  const channel = desktopChannel();
  if (!channel) return;
  channel.on("message", (message: unknown) => {
    const envelope = message as { type?: string; requestId?: string; handled?: boolean };
    if (envelope?.type !== "approval-reply-response") return;
    const requestId = envelope.requestId ?? "";
    const entry = pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.resolve(envelope.handled === true);
  });
}

/** Returns true when the desktop resolved the text as an approval reply. */
export function forwardApprovalReply(text: string, channelUserId: string): Promise<boolean> {
  const channel = desktopChannel();
  if (!channel) return Promise.resolve(false);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(false);
    }, REPLY_TIMEOUT_MS);
    pending.set(requestId, { resolve, timer });
    try {
      channel.send?.({ type: "approval-reply-request", requestId, text, channelUserId });
    } catch {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(false);
    }
  });
}
```

2. `processOneMessage()` 内**追加**两个分支（不改既有行）：

```ts
  const textBody = extractTextBody(full.item_list);
  if (textBody.startsWith("/")) {
    /* …既有 slash 逻辑保持不变… */
  }

  // CompanyClaw: let the desktop decide whether this text is an approval reply.
  // Anything it does not recognise continues to the AI exactly as before.
  if (textBody.trim().length > 0) {
    publishSessionSource({
      channelType: "weixin",
      userId: full.from_user_id ?? "",
      accountId: deps.accountId,
      baseUrl: deps.baseUrl,
      ...(deps.token ? { token: deps.token } : {}),
      ...(full.context_token ? { contextToken: full.context_token } : {}),
    });
    if (await forwardApprovalReply(textBody, full.from_user_id ?? "")) {
      logger.info(`[weixin] Approval reply handled by CompanyClaw, skipping AI pipeline`);
      return;
    }
  }
```

3. 桌面侧在 `startGatewayInner()` 既有 `child.on("message")` 处理函数中**追加**分支：

```ts
      if (msg?.type === "approval-reply-request") {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        const text = typeof msg.text === "string" ? msg.text : "";
        const channelUserId = typeof msg.channelUserId === "string" ? msg.channelUserId : "";
        void (async () => {
          let handled = false;
          try {
            if (companyClawRuntime && channelUserId) {
              // Binding is checked first: a bound identity is not permission to
              // approve, but an unbound sender can never approve anything.
              const authorized = companyClawRuntime.runtime.isRemoteCallerAuthorized({
                channelType: "weixin",
                channelUserId,
              });
              if (authorized) {
                const outcome = await companyClawRuntime.runtime.applyApprovalReply(
                  companyClawOptions.ownerSid,
                  text,
                );
                handled = outcome.handled;
              }
            }
          } catch (error) {
            console.error("[companyclaw] Approval reply failed:", error);
          } finally {
            child.send?.({ type: "approval-reply-response", requestId, handled });
          }
        })();
        return;
      }
```

> 实现注意：`companyClawOptions.ownerSid` 是 `registerIpcHandlers()` 的局部变量；执行时需将其提升为模块级 `companyClawOwnerSid`（与既有 `companyClawRuntime` 同样的做法），或从 `companyClawRuntime` 侧读取。此为实现细节，不改变最终行为。

4. 在插件注册时安装一次应答监听（`installDesktopBridgeListener()` 必须在**收到任何发起消息之前**只执行一次；`register()` 是唯一注册点）：

```ts
// plugins/openclaw-weixin/index.ts —— 仅在 register() 内追加一行 import 与一行调用
import { installDesktopBridgeListener } from "./src/messaging/desktop-bridge.js";

  register(api: OpenClawPluginApi) {
    // Fail-fast: reject incompatible host versions before any side-effects.
    assertHostCompatibility(api.runtime?.version);

    // CompanyClaw: the desktop app answers approval-reply requests over the
    // parent-process channel. Installing the listener once here (not per
    // message) is what keeps the pending map from leaking.
    installDesktopBridgeListener();

    api.registerChannel({ plugin: weixinPlugin });
  },
```

> 说明：`process.on("message")` 在插件生命周期内只注册一次，`pending` 映射随应答/超时清理；若桌面始终不答复，条目也会在 1.5s 后被移除，不会无限增长。

5. 追加 ADR：`docs/companyclaw/ADR/0003-weixin-plugin-bridge.md`，记录方案、`process.send` 通道选择理由、超时放行策略、以及"插件不持有裁决权"的边界。

#### Reason

V2 §10.3 第一条："会话来源绝不可通过自然语言自报"；§10.1 要求"微信插件先拦截审批回复（不作为普通 Agent 指令）"；ADR 0002 决策 5 已批准该最小补丁方式。当前 `session-source` 无生产者，导致 `runtime.isRemoteCallerAuthorized()` 永远拿不到可信来源。

#### Risk

- **插件源码侵入**：仅两处追加 + 一个新文件，不修改腾讯既有函数体。若 diff 超出此范围 → Plan Adjustment。
- **超时语义**：桌面 1.5s 内未答复则放行给 AI。安全后果为零（无票据不能写入），但不能因此把"审批失败"当成"已拒绝"。
- 插件测试需 mock `process.send`；不能用真实微信账号（`BLOCKED` B1）。

#### Verification

```powershell
cd plugins/openclaw-weixin
npx vitest run        # 若既有测试可运行；否则只做 typecheck
```
新增单测（mock `process.send`）：

| 用例 | 期望 |
|---|---|
| 桌面回 `handled:true` | `forwardApprovalReply` 返回 true |
| 桌面回 `handled:false` | 返回 false（文本继续进 AI） |
| 无 `process.send`（开发模式） | 立即返回 false，不抛错 |
| 超时未答复 | 返回 false，且 `pending` 被清理 |
| `publishSessionSource` 抛错 | 不冒泡 |

```powershell
cd desktop
npx tsc --noEmit
npx vitest run
```

- [ ] **Step 9.1: 写插件侧桥接测试（失败）**
- [ ] **Step 9.2: 实现 `desktop-bridge.ts`**
- [ ] **Step 9.3: 运行插件测试通过**
- [ ] **Step 9.4: 在 `processOneMessage()` 追加分支**
- [ ] **Step 9.5: 在 `plugins/openclaw-weixin/index.ts` 的 `register()` 内安装监听**
- [ ] **Step 9.6: 桌面侧追加 `approval-reply-request` 分支并提升 `ownerSid`**
- [ ] **Step 9.7: `tsc` + desktop 全量回归**
- [ ] **Step 9.8: 追加 ADR 0003 并提交**

```powershell
git add plugins/openclaw-weixin/index.ts plugins/openclaw-weixin/src/messaging/desktop-bridge.ts plugins/openclaw-weixin/src/messaging/process-message.ts desktop/src/main.ts docs/companyclaw/ADR/0003-weixin-plugin-bridge.md
git commit -m "feat(companyclaw): bridge weixin session source and approval replies to the desktop"
```

---

### Step 10: 文档与源码一致性修正

#### Target

- 修改：`docs/companyclaw/IMPLEMENTATION_STATUS.md`
- 修改：`docs/companyclaw/00-source-audit.md`（追加 V2 一致性修正节）
- 修改：`docs/companyclaw/12-known-limitations.md`
- 修改：`BLOCKERS.md`
- 修改：`CHANGELOG-COMPANY.md`

#### Change

登记以下**必须修正**的文档事实（按 SHA `f1ab74e7f489909dc1307436dacf12ef3f1ac4c4` + 符号）：

| 原表述 | 修正为 |
|---|---|
| `main.ts:543`、`main.ts:4106` | `desktop/src/main.ts` 的 `cachedRemoteSource` 声明与 `startGatewayInner()` 内的 `child.on("message")` 分支（stdin `stdio` 含 `"ipc"`） |
| §1.1"已有 Browser 配置/目标限制逻辑" | **生产功能缺失**：仅 `deployer/windows_setup.py` 写入 `browser.executablePath`；`desktop/src/companyclaw/policy/browser-policy.ts` 只有策略，无执行器；Step 4 首次运行配置补齐配置项 |
| `dist` 已准备资源 | 修正为：Step 2 之前 `dist` 不装配 `node.exe`/`openclaw.asar` |
| 任务链"已完成" | 明确 `TaskOrchestrator` 与 `runtime.execute()` 无生产调用方（仅测试引用） |

同时：在 `BLOCKERS.md` 中把"缺少 .NET SDK""Git 子模块未初始化""无代码签名证书"标注为**构建/发布方责任**，明确"不得转化为员工安装前置要求"；保留 PKG/E 系列的 `UNVERIFIED` 状态与解除条件。

#### Reason

用户指令第 1/4/6 条：以源码为准、修正引用、记录差异并继续执行。

#### Verification

```powershell
git diff --stat docs/ BLOCKERS.md CHANGELOG-COMPANY.md
```
文档中不得出现旧行号引用；每条新引用须含 SHA + 路径 + 符号。

- [ ] **Step 10.1: 更新 5 份文档**
- [ ] **Step 10.2: 提交**

```powershell
git add docs/companyclaw BLOCKERS.md CHANGELOG-COMPANY.md
git commit -m "docs(companyclaw): align the V2 references with the current source"
```

---

## 4. Changed Files Tracking

| File | Action | Reason |
| ---- | ------ | ------ |
| `desktop/src/companyclaw/runtime-manifest.ts` | Add | 清单契约 + 失败关闭的完整性校验 |
| `desktop/src/companyclaw/runtime-manifest.test.ts` | Add | 8 项负向/正向用例 |
| `desktop/scripts/prepare-production-resources.mjs` | Add | 统一资源流水线（staging → manifest → 原子切换） |
| `desktop/src/companyclaw/production-resources.test.ts` | Add | 钉住流水线输出与 `dist` 入口契约 |
| `desktop/package.json` | Modify | 新增 `release:win` / `prepare-production-resources`，`dist` 指向正式入口 |
| `desktop/electron-builder.yml` | Modify | 移除死引用 `resources/openclaw/`；新增 broker 与 manifest |
| `desktop/src/companyclaw/extra-resources-contract.test.ts` | Add | 防止 `extraResources` 死引用复发 |
| `desktop/src/companyclaw/product-identity.test.ts` | Modify | 同步 `to: openclaw/` → `to: openclaw.asar` + broker 条目断言 |
| `desktop/src/companyclaw/first-run-init.ts` | Add | 首次运行生成 gateway token/port 与 browser 配置 |
| `desktop/src/companyclaw/first-run-init.test.ts` | Add | 幂等、不覆盖用户值、Edge 探测 |
| `desktop/src/main.ts` | Modify | 首次运行初始化接线 + 资源完整性诊断 + Broker nodePath + 审批回复分支 |
| `desktop/src/companyclaw/broker-client.ts` | Modify | `nodePath` 启动私有 Node；`getStatus()` 区分存活与可操作性 |
| `desktop/src/companyclaw/broker-client-spawn.test.ts` | Add | 启动命令/令牌不落 argv/中文空格路径 |
| `desktop/src/companyclaw/ipc.ts` | Modify | 透传 `nodePath`；新增 `companyclaw:broker:get-status` |
| `desktop/src/companyclaw/ipc-contract.test.ts` | Modify | 同步 `REQUIRED_CHANNELS`（含数量断言） |
| `desktop/src/preload.ts` | Modify | 暴露 `broker.getStatus` |
| `desktop/renderer/src/stores/companyclaw.ts` | Modify | Broker 状态字段与拉取 |
| `desktop/renderer/src/views/TasksView.vue` | Modify | 展示"进程存活 / 最近一次真实 UIA 成功" |
| `desktop/renderer/src/views/SetupWizard.vue` | Modify | 能力探针展示 + 微信绑定入口 |
| `desktop/renderer/src/views/SettingsView.vue` | Modify | 重新检测能力入口 |
| `desktop/renderer/src/i18n/en-US.ts`, `zh-CN.ts` | Modify | 新增双语键（必须对齐） |
| `build.ps1` | Modify | Step 3 改走 `release:win`；标注兼容渠道 |
| `plugins/openclaw-weixin/src/messaging/desktop-bridge.ts` | Add | 插件→桌面桥（转发 + 超时放行） |
| `plugins/openclaw-weixin/index.ts` | Modify | `register()` 内安装一次应答监听 |
| `plugins/openclaw-weixin/src/messaging/process-message.ts` | Modify | 追加 `session-source` 发布与审批回复拦截分支 |
| `docs/companyclaw/ADR/0003-weixin-plugin-bridge.md` | Add | 记录插件补丁方式与边界 |
| `docs/companyclaw/IMPLEMENTATION_STATUS.md` | Modify | V2 里程碑与真实完成度 |
| `docs/companyclaw/00-source-audit.md` | Modify | 追加 V2 一致性修正 |
| `docs/companyclaw/12-known-limitations.md` | Modify | Browser 执行器缺失等现状 |
| `docs/companyclaw/13-employee-install-guide.md` | Add | 员工视角安装/配置说明（零命令行） |
| `BLOCKERS.md` | Modify | 责任主体重分类（构建方 vs 员工方） |
| `CHANGELOG-COMPANY.md` | Modify | 本轮变更记录 |

---

## 5. Verification Checklist

### 主流程验证

- [ ] `desktop/resources/` 从零重建：`npm run prepare-production-resources` 退出码 0，产出 `node.exe` / `openclaw.asar` / `companyclaw-broker/{dist,scripts}` / `runtime-manifest.json`。
- [ ] 篡改任一已登记文件后校验失败（`hash-mismatch`），构建中止。
- [ ] `extraResources` 每个 `from` 均可产出；Broker 在清单内。
- [ ] `BrokerClient` 用 `resolveNodePath()` 结果启动；argv 无令牌；令牌经 env 传递。
- [ ] 首次运行初始化幂等：二次启动不覆盖 `gateway.auth.token`；`gatewayToken` 不再为空。
- [ ] `build.ps1` 产出 `desktop/release/CompanyClaw-Setup-<version>.exe`（NSIS，Per-User）。

### 关联流程验证

- [ ] `desktop/src/bundled-runtime.ts` 仍能从 `openclaw.asar` 解包出 `node_modules/openclaw/openclaw.mjs`。
- [ ] `desktop/src/path-resolver.ts` 三条解析路径（Node / OpenClaw entry / builtin skills）在打包布局下仍成立。
- [ ] `installer-scope.test.ts`（Per-User / 无提权 / 无 Defender）与 `product-identity.test.ts`（CompanyClaw 标识）全绿。
- [ ] `ipc-contract.test.ts` 数量断言与 `REQUIRED_CHANNELS` 一致。
- [ ] `broker-protocol.test.ts` 的双源一致性未受影响。
- [ ] 微信审批回复：未识别文本继续进 AI；越权发送者无法批准；插件无桌面父进程时不抛错。

### 边界情况验证

- [ ] 中文/含空格安装路径下的 Broker 启动命令（单测已覆盖）。
- [ ] `openclaw.json` 不存在 / 为空 / 非对象 / 已有 token 四种输入。
- [ ] Edge 不存在时只写 `browser.enabled`，不写 `executablePath`。
- [ ] 资源清单缺失或损坏时输出中文提示且**不阻塞应用启动**。
- [ ] Broker 崩溃后 `lastFailureReason` 可见，且不静默重启。
- [ ] MXC 模式下首次运行初始化被跳过（不与其 config pinning 冲突）。

### Test / Build / Lint / Typecheck

```powershell
# desktop
cd desktop
npx tsc --noEmit
npx vitest run
npx eslint .

# broker
cd ..\broker
npx tsc --noEmit
npx vitest run

# renderer
cd ..\desktop\renderer
npx vitest run

# 仓库根
cd ..\..
npm run format:check
ruff format --check .
```

- [ ] desktop `tsc --noEmit` clean；`vitest run` 不低于 **1405 passed**；`eslint .` 不新增错误（既有 `chat-attachments.ts` / `openclaw-upgrade-recovery.ts` 两处上游问题不在本次范围）。
- [ ] broker `tsc --noEmit` clean；`vitest run` 不低于 **63 passed**（含 11 实机；实机需 Windows 会话）。
- [ ] renderer `vitest run` 不低于 **318 passed**。
- [ ] Python `pytest` 不低于 **298 passed**，2 项既有 error 不因本次改动引入或修复。
- [ ] `npm run format:check` 与 `ruff format --check .` 通过。

### 目标机验证（本机 BLOCKED）

- [ ] **离线段**：干净 Win11 标准账号、无 Node/Python/Git/.NET SDK/OpenClaw，断网安装 → 首次启动 → Node/Gateway/Broker 就绪，且**未触发**任何 npm/pip/git 调用（PKG-01/02/03）。
- [ ] **联网段**：模型配置 + 工具调用自检（E02/PKG-04）；微信扫码与消息往返（E03）；受控 Windows 操作与写入前微信审批（E08/E09/E16）；结果与文件回传（E10/E11）；重启恢复（PKG-07/E20）；升级保配置（PKG-06）；卸载可选保留（PKG-10）。
- [ ] 证据落盘 `docs/companyclaw/evidence/<release-id>/<test-id>/`；未执行项一律 `UNVERIFIED`。

---

## Plan Adjustment 规则（执行期遇到即暂停）

若出现以下任一情况，**停止编码**并输出：

```
## Plan Adjustment

原计划：
新发现：
为什么需要调整：
新增修改范围：
等待确认
```

1. 需要修改 `appcontainer/**`、`windows-node-host/**`、`skills/**`、`desktop/src/windows-node-mxc*.ts`；
2. 需要改动 `plugins/openclaw-weixin/src/` 超出 Step 9 声明的"两处追加 + 一个新增文件"；
3. 需要新增第三方运行时依赖；
4. 影响范围超出第 4 节 `Changed Files Tracking` 中已登记的 32 个文件；
5. 发现某项需求必须重新设计既有模块（而非接线）。
