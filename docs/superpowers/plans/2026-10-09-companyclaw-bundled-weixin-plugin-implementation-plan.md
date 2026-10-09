# 微信插件依赖内置（打包完整性）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:executing-plans`（本仓库既有惯例，见 `docs/superpowers/plans/2026-10-09-companyclaw-v3-closure.md`）按 Step 顺序执行，每步先跑失败测试再实现。执行中若发现影响范围扩大或本 Plan 与实际代码不符，必须先输出 **Plan Adjustment** 并停下等待确认，不得自行扩大范围。

- 计划文件：`docs/superpowers/plans/2026-10-09-companyclaw-bundled-weixin-plugin-implementation-plan.md`
- 代码基线：`feat/companyclaw-foundation` / `250c96a`
- 需求来源：已确认需求「微信插件需要内置在应用内，因为用户不一定有 npm 环境，所以需要内置好」（截图：`plugin not installed: openclaw-weixin — openclaw plugins install @tencent-weixin/openclaw-weixin@2.4.8` + `Install Weixin plugin? > Download from npm (...) / Skip for now`）
- 前置已完成：需求确认 → 代码调查 → Impact Map → Mini Plan（见对话记录，本文件是其正式化落地）
- 责任主体标注沿用 `BLOCKERS.md`：**[构建方]** 由构建机/CI 解决；**[验证方]** 记 `BLOCKED`/`UNVERIFIED`

---

## 0. Global Constraints（执行原则）

1. 只修改本 Plan「4. Changed Files Tracking」中列出的文件；不额外重构、不提前抽象、不改既有架构与代码风格、不动插件源码（`plugins/openclaw-weixin/**`）。
2. 每步走 TDD：先写失败断言 → 跑失败（记录输出）→ 最小实现 → 跑通过 → 更新「Execution Log」。
3. 修改文件前先备份到 `backups/2026-10-09-weixin-plugin-deps/`（Step 0）。
4. **不得引入任何在线安装路径**：员工机没有 npm、通常也没有 registry 访问；依赖只能来自 `plugins/openclaw-weixin/vendor/*.tgz`（构建期离线安装）。
5. 当前工作树存在**另一批需求的未提交改动**（`desktop/src/main.ts`、`desktop/src/companyclaw/ipc.ts`、`runtime.ts`、`renderer/src/views/*`、`i18n/*`、`plugins/weixin-plugin-install.*` 等）。本次执行**不得**改动、不得回退、不得连带提交这些文件。
6. 是否提交由用户决定，本 Plan 默认**不自动 commit**（避免把第 5 条的无关改动一起带上）。
7. 新增/修改 `extraResources` 来源时，必须同步更新 `extra-resources-contract.test.ts` 的分类表，否则 `accounts for every declared source in one of the three groups` 会失败。

---

## 1. Goal

### 1.1 本次修改目标

让「微信插件内置」在**打包产物**上真正成立，而不是只在内置 staging 阶段成立：

1. 打包后的 `resources/openclaw-weixin` 必须同时含有插件本体与它的运行时依赖（`zod`、`qrcode-terminal`）。
2. 把「依赖缺失」从员工机的运行期模块解析失败，提前为**构建期硬失败**。
3. 用测试固化上述两条，防止以后有人把两条映射合并成一条、或删掉依赖校验。

### 1.2 不包含（明确排除）

- 不改 `desktop/src/companyclaw/plugins/weixin-plugin-install.ts` 及 `main.ts` 的安装/启用/扫码流程（工作树已有改动，本次不碰）。
- 不改宿主（`openclaw.asar` 内）代码：截图中的 `plugin not installed ... openclaw plugins install @tencent-weixin/openclaw-weixin@2.4.8` 与 `Install Weixin plugin?` 向导由打包在 `openclaw.asar` 里的宿主产生，本仓库无法修改。
- 不把内置插件版本从 `2.4.6` 升到官方目录声明的 `2.4.8`（版本口径分歧只在验收报告里记录）。
- 不改 legacy Python 安装器通道（`deployer/windows_setup.py`、`MicroClawDeployer.spec`、`installer/*.nsi`）。
- 不改 `desktop/scripts/prepare-resources.mjs`（旧 MSIX 资源脚本，不在 `release:win` / `dist:msix` 主链路）。
- 不改 `runtime-manifest.json` 的生成规则与格式（manifest 本就覆盖插件全部 827 个文件，缺的是复制环节）。
- 不做 UI 视觉重构、不新增抽象层、不为未来插件预留通用机制。

### 1.3 成功标准

| # | 标准 | 判定证据 |
|---|---|---|
| S1 | 打包产物含插件运行时依赖 | `desktop/release/win-unpacked/resources/openclaw-weixin/node_modules/{zod,qrcode-terminal}/package.json` 存在 |
| S2 | 打包产物与 manifest 一致 | `release/win-unpacked/resources/openclaw-weixin` 文件数 == `desktop/resources/openclaw-weixin` 文件数 == manifest 中 `openclaw-weixin/*` 条目数（当前 827）；修复前实测为 84 |
| S3 | 依赖缺失时构建失败 | 移除 staging 的 `node_modules/zod` 后跑 `prepare-production-resources`，报 `WeChat plugin staging is missing dependency zod` |
| S4 | 回归被测试固化 | `extra-resources-contract.test.ts` 同时断言 `resources/openclaw-weixin/` 与 `resources/openclaw-weixin/node_modules/` 两条来源存在 |
| S5 | 无回归 | `npm test`、`npm run build`、`npm run lint` 全绿 |

### 1.4 已知阻塞（不影响本次判定）

- **B1 [验证方]** 无微信测试账号：真实扫码、消息往返、审批闭环仍记 `BLOCKED`/`UNVERIFIED`，不得用 Mock 冒充 PASS。
- 宿主 `plugins install` 会自行 link `openclaw` peer；peer 依赖不进包属预期行为（`--omit=peer`）。

---

## 2. Current Understanding

### 2.1 当前实现方式（已核实，含实测数据）

| 关注点 | 位置 | 现状 |
|---|---|---|
| 插件源码（vendored） | `plugins/openclaw-weixin/` | 官方 2.4.6 + 本仓库补丁（`src/messaging/desktop-bridge.ts`、`file-send.ts`）；依赖声明 `qrcode-terminal@0.12.0`、`zod@^4.3.6`；peer `openclaw` |
| 依赖来源（离线） | `plugins/openclaw-weixin/vendor/{qrcode-terminal-0.12.0.tgz,zod-4.4.3.tgz,tencent-weixin-openclaw-weixin-2.4.6.tgz}` | 构建机 `npm install --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts` 从 tarball 装入 staging，员工机不需要 npm |
| 编译 | `desktop/scripts/prepare-production-resources.mjs:171-221`（`buildWeixinPluginDist`） | tsc 编译插件源码到 `staging/openclaw-weixin/dist`（`noCheck`，开发机不需要宿主 SDK 类型） |
| 装配 | 同上 `:363-388`（2f 阶段） | 复制插件本体（跳过源 `node_modules`/`vendor`/`*.test.ts`）→ 编译 → `installWeixinPluginDeps()` → 检查 4 个必需文件 |
| 依赖安装 | 同上 `:228-256`（`installWeixinPluginDeps`） | 从 `vendor/*.tgz` 安装到 `staging/openclaw-weixin/node_modules` |
| manifest | 同上 `:470-478` | 逐文件写 `runtime-manifest.json`，插件 827 条（其中 `node_modules/**` 743 条） |
| staging 换入 | 同上「swap」段 | 校验哈希后整体 rename 到 `desktop/resources/` |
| 打包声明 | `desktop/electron-builder.yml:58-84`（`extraResources`） | `resources/openclaw-weixin/ → openclaw-weixin/`（**仅一条**）；`resources/agent-skills/ → agent-skills/` |
| 启动校验 | `desktop/src/companyclaw/runtime-manifest.ts`、`desktop/src/main.ts:1546-1583`（`reportRuntimeIntegrity`） | 逐条核对 manifest 的 path + sha256，缺失即输出中文告警 |
| 运行期安装 | `desktop/src/companyclaw/plugins/weixin-plugin-install.ts:89-145` | `node <openclaw.mjs> plugins install --force [--accept-capabilities] <本地插件目录>` → 复制进 `<stateDir>/extensions/openclaw-weixin`，宿主自行记录 `plugins.installs` |

### 2.2 缺陷与根因（本次修改对象）

**实测事实（2026-10-09 本机）**

| 位置 | 文件数 | 是否含 `node_modules` |
|---|---|---|
| `desktop/resources/openclaw-weixin`（pipeline 输出） | 827 | 是（`zod`、`qrcode-terminal`） |
| `desktop/release/win-unpacked/resources/openclaw-weixin`（打包产物） | **84** | **否** |
| `runtime-manifest.json` 中 `openclaw-weixin/*` 条目 | 827 | 是（声明含 743 条依赖文件） |

**根因**：electron-builder 的目录映射会剪掉该目录的**根** `node_modules`。链路为 `copyFiles` → `FileMatcher.createFilter()` → `util/filter.js`：

```js
// filter the root node_modules, but not a subnode_modules
if (relative === "node_modules") return false;
```

`createFilter` 对 `node_modules` 无条件返回 `false`，`builder-util/out/fs.js` 的 `walk()` 因此不再深入该目录 → 743 个依赖文件全部丢失。**该判断在 `filter` 之前，无法用 `filter` 重新包含**。

**实测修复方案（本机已用同版本 `FileMatcher` + `copyFiles` 复现验证）**

| 映射组合 | 结果 |
|---|---|
| 仅 `resources/openclaw-weixin/ → openclaw-weixin/` | 84 文件，`node_modules` 不存在 |
| 追加 `resources/openclaw-weixin/node_modules/ → openclaw-weixin/node_modules/` | **827 文件**，`node_modules/{zod,qrcode-terminal}` 均在，`dist/index.js` 正常 |

**后果链（为什么必须修）**：依赖缺失 → `plugins install` 把不完整目录复制进 `<stateDir>/extensions/openclaw-weixin` → 插件 `dist/src/config/config-schema.js` 的 `import { z } from "zod"` 运行期无法解析 → 宿主始终判定 `plugin not installed` → 截图中的 `openclaw plugins install @tencent-weixin/openclaw-weixin@2.4.8` 告警与 `Install Weixin plugin? / Download from npm` 向导出现（该向导只有 npm/clawhub/本地路径选项，员工机无 npm 即死路）。

### 2.3 数据流 / 调用链

**构建（本 Plan 修改点）**
```
plugins/openclaw-weixin (源码 + vendor/*.tgz)
  → prepare-production-resources.mjs
      2f. cp 插件本体 → buildWeixinPluginDist() → installWeixinPluginDeps()   ← Step 3 增加未决依赖校验
          → 逐文件写 runtime-manifest.json（827 条）
          → rename staging → desktop/resources/openclaw-weixin               ← pipeline 输出正确
  → electron-builder extraResources                                          ← Step 1 修复点（丢 743 文件）
          resources/openclaw-weixin/          → openclaw-weixin/
          resources/openclaw-weixin/node_modules/ → openclaw-weixin/node_modules/   ← 新增
  → release/win-unpacked/resources/openclaw-weixin (827) → NSIS / MSIX 安装包
```

**运行（本次不改，仅验收观察）**
```
应用启动 → reportRuntimeIntegrity()  读 <resources>/runtime-manifest.json 校验 827 条 → 完整则无告警
         → ensureWeixinPluginAvailable() → ensureWeixinPluginInstalled()
             → node <openclaw.mjs> plugins install --force <resources>/openclaw-weixin
             → <stateDir>/extensions/openclaw-weixin（含 node_modules）
渲染层 PluginsView / ChannelsView → plugin:weixin:get-status → readWeixinPluginStatus()
```

### 2.4 已确认的影响范围

- **直接修改**：`desktop/electron-builder.yml`、`desktop/src/companyclaw/extra-resources-contract.test.ts`、`desktop/scripts/prepare-production-resources.mjs`、`desktop/src/companyclaw/production-resources.test.ts`。
- **关联检查（不改）**：`desktop/src/companyclaw/runtime-manifest.ts`、`desktop/src/main.ts`（`reportRuntimeIntegrity` / `ensureWeixinPluginAvailable`）、`desktop/scripts/build-msix.mjs`、`desktop/src/companyclaw/resource-pipeline.test.ts`（断言 `prepare` 脚本内容，需确认新增代码不破坏其断言）。
- **确认无需修改**：`weixin-plugin-install.ts`、`preload.ts`、`PluginsView.vue`、`ChannelsView.vue`、`prepare-resources.mjs`、`deployer/windows_setup.py`、`MicroClawDeployer.spec`、`plugins/openclaw-weixin/**`。
- **现有测试对该配置的约束（必须同时满足）**：`installer-scope.test.ts`（`perMachine/oneClick/allowElevation/shortcutName`、不得出现 `defender`、不得有 `include:`）、`product-identity.test.ts`（`appId/productName`、`from: resources/agent-skills/`、`to: openclaw.asar`、不得出现 `from: resources/openclaw/`）。本次只新增一行来源，不触碰上述键。

### 2.5 需求与代码的不一致（记录，不在本次改动范围）

1. 需求表述为「插件需要内置」；代码里内置链路**已存在**，缺口在打包复制环节（本次修复）。
2. 宿主官方外部插件目录声明 `@tencent-weixin/openclaw-weixin@2.4.8`，本项目内置 `2.4.6`：宿主的「官方外部插件」提示可能长期存在；本次**不**改版本口径。

---

## 3. Implementation Steps

### Step 0 备份待改文件

#### Target

- 新建：`backups/2026-10-09-weixin-plugin-deps/`

#### Current Behavior

- 仓库根已有 `backups/`（含 `2026-10-09-mini-fixes/` 等历史备份）；本次待改的 4 个文件尚无备份。

#### Change

在仓库根 `code/CompanyClaw` 执行：

```bash
mkdir -p backups/2026-10-09-weixin-plugin-deps
cp --parents \
  desktop/electron-builder.yml \
  desktop/scripts/prepare-production-resources.mjs \
  desktop/src/companyclaw/extra-resources-contract.test.ts \
  desktop/src/companyclaw/production-resources.test.ts \
  backups/2026-10-09-weixin-plugin-deps/
```

#### Reason

- 执行宪法 D1：修改重要文件前先备份到当前项目根 `backups/`。

#### Risk

- 无（仅新增备份文件）。

#### Verification

- `ls -R backups/2026-10-09-weixin-plugin-deps/desktop` 能看到 4 个文件。

---

### Step 1 用测试固定「插件依赖必须随包」

#### Target

- 文件：`desktop/src/companyclaw/extra-resources-contract.test.ts`
  - 常量 `PRODUCED_BY_PIPELINE`（第 22-40 行）
  - `describe("installer extraResources contract")` 内新增用例

#### Current Behavior

- `PRODUCED_BY_PIPELINE` 含 `"resources/openclaw-weixin/"`，不含依赖目录。
- 现有用例 `declares every source the unified pipeline produces` 只检查「表里的来源都在 yml 中」，`accounts for every declared source in one of the three groups` 只检查「yml 里的来源都在表中」。因此**当前测试全绿，却漏掉了 743 个文件**。

#### Change

1a. 在 `PRODUCED_BY_PIPELINE` 中，紧跟 `"resources/openclaw-weixin/",` 之后插入：

```ts
  // electron-builder drops the root `node_modules` of a directory mapping, so
  // the plugin's runtime dependencies are declared as their own source.
  "resources/openclaw-weixin/node_modules/",
```

1b. 在 `ships the broker so a packaged app can start it` 用例之后新增：

```ts
  it("ships the WeChat plugin's runtime dependencies next to the plugin", () => {
    // The plugin's compiled dist/ imports zod (and qrcode-terminal) at runtime.
    // electron-builder's directory mapping skips the root `node_modules`
    // (`createFilter` returns false for `relative === "node_modules"`), which
    // dropped 743 payload files from the installer while the pipeline itself
    // looked correct — and the employee machine has no npm to recover them.
    const sources = extraResourceSources();
    expect(sources).toContain("resources/openclaw-weixin/");
    expect(sources).toContain("resources/openclaw-weixin/node_modules/");
  });
```

#### Reason

- 把「依赖必须随包」变成可执行断言，防止两条映射被合并或删除后再次静默丢包。

#### Risk

- 若只改本文件而不同步 Step 2，`declares every source the unified pipeline produces` 与新增用例会失败（这是预期的 RED 阶段）；`accounts for every declared source in one of the three groups` 仍应通过。

#### Verification

```bash
cd desktop && npx vitest run src/companyclaw/extra-resources-contract.test.ts
```
预期：`ships the WeChat plugin's runtime dependencies next to the plugin` 与 `declares every source the unified pipeline produces` **失败**（RED），其余用例通过。

---

### Step 2 在 extraResources 中显式加入插件依赖目录

#### Target

- 文件：`desktop/electron-builder.yml`
  - `extraResources` 的微信公众号条目（第 77-82 行）

#### Current Behavior

```yaml
  # The WeChat plugin and the agent skills come from the unified pipeline
  # (prepare-production-resources.mjs). Shipping a second copy straight from the
  # source tree would let the packaged payload and the manifest drift apart.
  - from: resources/openclaw-weixin/
    to: openclaw-weixin/
  - from: resources/agent-skills/
    to: agent-skills/
```

仅此一条插件来源 → 打包产物只有 84 个文件（实测），`node_modules` 整体丢失。

#### Change

保持原条目不变，紧随其后插入一条依赖来源：

```yaml
  # electron-builder skips the root `node_modules` of a directory mapping
  # (util/filter.js returns false for `relative === "node_modules"`), which
  # silently dropped the plugin's runtime dependencies. They are shipped as
  # their own source so the packaged plugin can load with no npm on the machine.
  - from: resources/openclaw-weixin/node_modules/
    to: openclaw-weixin/node_modules/
```

#### Reason

- `desktop/resources/openclaw-weixin` 已是完整 payload（含 `node_modules`），只需让 electron-builder 不再剪掉它；这是「内置好」的实际闭环点。

#### Risk

- 两条来源写入同一目的地（`openclaw-weixin/` 与 `openclaw-weixin/node_modules/`）：已用同版本 `FileMatcher` + `copyFiles` 实测，合并结果为 827 文件、无冲突无覆盖；为稳妥保持「先整目录、后 node_modules」顺序。
- 依赖换版本会改变文件数，因此验证以「产物数 == manifest 条目数」为准，不硬编码 827。

#### Verification

```bash
cd desktop && npx vitest run src/companyclaw/extra-resources-contract.test.ts
```
预期：**全绿**（RED → GREEN）。

---

### Step 3 让依赖缺失在构建期失败

#### Target

- 文件：`desktop/src/companyclaw/production-resources.test.ts`（`refuses to ship a plugin or skill that is incomplete` 用例，第 45-58 行）
- 文件：`desktop/scripts/prepare-production-resources.mjs`（2f 必检清单，第 378-388 行）

#### Current Behavior

- 2f 阶段只校验 4 个文件：

```js
for (const required of [
  "package.json",
  "openclaw.plugin.json",
  "dist/index.js",
  "dist/src/messaging/desktop-bridge.js",
]) {
  if (!existsSync(path.join(weixinPluginStagingDir, required))) {
    throw new Error(`WeChat plugin staging is missing ${required}`);
  }
}
```

- 依赖没装上时构建**照样成功**，产出的安装包要到员工机运行期才炸（`Cannot find package 'zod'`）。

#### Change

3a. 先在 `production-resources.test.ts` 的 `refuses to ship a plugin or skill that is incomplete` 用例中补充断言：

```ts
    // The plugin's dist/ imports zod and qrcode-terminal at runtime; a payload
    // without them still builds, and only fails on the employee machine, where
    // no npm exists to install them.
    expect(script).toContain("WeChat plugin staging is missing dependency");
```

3b. 在 `prepare-production-resources.mjs` 现有必检清单之后追加：

```js
// The plugin's compiled dist/ imports its dependencies at runtime, and nobody
// on the employee machine can install them: a staging directory without
// `node_modules` must fail the build instead of shipping a dead plugin.
const weixinPluginManifest = JSON.parse(
  readFileSync(path.join(weixinPluginStagingDir, "package.json"), "utf8"),
);
for (const dependency of Object.keys(weixinPluginManifest.dependencies ?? {})) {
  if (
    !existsSync(path.join(weixinPluginStagingDir, "node_modules", dependency, "package.json"))
  ) {
    throw new Error(`WeChat plugin staging is missing dependency ${dependency}`);
  }
}
```

（`readFileSync`、`existsSync`、`path` 均已在脚本头部导入，无需新增 import。）

#### Reason

- 把「员工机才暴露的模块解析失败」前移到构建机，错误信息可直接执行（重跑依赖安装）。

#### Risk

- 依赖声明为 `zod` 与 `qrcode-terminal`，校验按 `package.json#dependencies` 动态枚举 → 插件升级新增依赖时自动纳入校验，不会漏。
- `resource-pipeline.test.ts` 断言脚本内容（`.staging-`、`discardStaging()`、`os.tmpdir()` 等），本次新增代码不影响这些断言，但必须跑该文件确认。

#### Verification

```bash
# 1) RED：先加 3a 断言，此时 3b 未落，测试应失败
cd desktop && npx vitest run src/companyclaw/production-resources.test.ts
# 2) 落 3b 后重跑 → 全绿
cd desktop && npx vitest run src/companyclaw/production-resources.test.ts src/companyclaw/resource-pipeline.test.ts
# 3) 负向验证（临时，验证后还原）：把 staging 的依赖目录改名再跑脚本，必须报 missing dependency
```

第 3 步的负向验证方式（临时改名，验证后立即还原，不做任何删除）：

```bash
cd desktop/resources/openclaw-weixin && mv node_modules node_modules.bak-check
cd ../../../ && node desktop/scripts/prepare-production-resources.mjs --arch=x64   # 期望：报错停止
cd desktop/resources/openclaw-weixin && mv node_modules.bak-check node_modules
```

> 注意：`prepare-production-resources.mjs` 会重新从 npm registry 拉取 OpenClaw staging（既有行为，需网络）。若构建机当前离线，改为只做 1)、2) 两条 + 代码走查，并在 Execution Log 记为「未执行的验证及原因」。

---

## 4. Changed Files Tracking

> 以下为**执行后的实际结果**（`git diff --stat` 核对，4 个文件共 +64 行，无删除、无 Plan 外代码文件）。

| File | Action | Change |
| ---- | ------ | ------ |
| `desktop/electron-builder.yml` | Modify | `extraResources` 新增 `resources/openclaw-weixin/node_modules/ → openclaw-weixin/node_modules/`，并加注释说明 electron-builder 会剪掉目录映射的根 `node_modules` |
| `desktop/scripts/prepare-production-resources.mjs` | Modify | ① `installWeixinPluginDeps()` 增加 `--offline`（阻止 registry 补包）并修正注释；② 安装前新增 vendor 覆盖校验：按插件 `package.json#dependencies` 枚举，要求 `vendor/` 存在对应 tarball，缺失抛 `No vendored tarball for plugin dependency <name> in <dir>`；③ 2f 校验清单后新增 staging 依赖完整性校验（`WeChat plugin staging is missing dependency <name>`） |
| `desktop/src/companyclaw/extra-resources-contract.test.ts` | Modify | `PRODUCED_BY_PIPELINE` 登记 `resources/openclaw-weixin/node_modules/`；新增用例「ships the WeChat plugin's runtime dependencies next to the plugin」断言两条来源同时存在 |
| `desktop/src/companyclaw/production-resources.test.ts` | Modify | `refuses to ship a plugin or skill that is incomplete` 增加 `WeChat plugin staging is missing dependency` 断言；`compiles the plugin …` 增加 `--offline` 与 `No vendored tarball for plugin dependency` 断言 |
| `docs/superpowers/plans/2026-10-09-companyclaw-bundled-weixin-plugin-implementation-plan.md` | Add | 本 Plan（含 Execution Log、Plan Adjustment、Final Report） |
| `backups/2026-10-09-weixin-plugin-deps/**` | Add | Step 0 备份（宪法 D1，非交付物；4 个待改文件的执行前副本） |

> **未修改**（明确记录）：`desktop/src/companyclaw/plugins/weixin-plugin-install.ts(/test)`、`desktop/src/main.ts`、`ipc.ts`、`runtime.ts`、`gateway-client.ts`、`renderer/**`、`i18n/**`、`plugins/openclaw-weixin/**`、`runtime-manifest.ts`、`deployer/**`、`MicroClawDeployer.spec`。工作树中这些文件的改动属于**另一批需求**的进行中改动，与本次无关。

---

## 5. Verification Checklist

### 主流程

- [x] `cd desktop && npx vitest run src/companyclaw/extra-resources-contract.test.ts src/companyclaw/production-resources.test.ts src/companyclaw/resource-pipeline.test.ts src/companyclaw/plugins/weixin-plugin-install.test.ts` 全绿
- [x] `cd desktop && npm run pack:prepared`（复用现有 `desktop/resources`，只重跑 electron-builder）后：
  - [x] `desktop/release/win-unpacked/resources/openclaw-weixin/node_modules/zod/package.json` 存在（实测 true，zod 4.4.3）
  - [x] `desktop/release/win-unpacked/resources/openclaw-weixin/node_modules/qrcode-terminal/package.json` 存在（实测 true）
  - [x] 产物文件数 == `desktop/resources/openclaw-weixin` 文件数 == manifest 中 `openclaw-weixin/*` 条目数（实测三者均 827；修复前产物为 84）
- [ ] 启动解包产物（`desktop/release/win-unpacked/CompanyClaw.exe`）后，日志中不再出现插件相关的「运行资源校验未通过 / 资源缺失」告警 —— **未执行**：需人工启动 GUI 观察；已用等价的逐条哈希校验替代（827 条 0 缺失 0 不匹配，即 `reportRuntimeIntegrity()` 的同一判定输入）

### 关联流程

- [x] `desktop/src/companyclaw/plugins/weixin-plugin-install.test.ts` 仍全绿（含在 `npm test` 86 files 全绿内）
- [x] `installer-scope.test.ts`、`product-identity.test.ts` 全绿（实测 17 tests 通过）
- [x] MSIX 通道说明确认：`dist:msix` 复用同一 `extraResources`（已读 `build-msix.mjs` 确认），故修复同样生效；`build-msix.mjs` 结束时会 `rmSync(desktop/resources)`，验证后如需继续开发须重跑 `npm run prepare-production-resources`（**代码走查确认，未执行 MSIX 构建**）

### 边界情况

- [x] **负向验证（按 Plan Adjustment 7.1/7.1.1 改为改名 vendor tarball）**：`mv vendor/zod-4.4.3.tgz ...bak-check` → 构建 EXIT=1，报 `No vendored tarball for plugin dependency zod`；随后立即还原（**未删除任何文件**）
- [ ] **staging 依赖缺失**（`WeChat plugin staging is missing dependency`）：`--offline` 下 npm 只要装得出来就不会缺；该分支由代码走查覆盖，未构造执行（如实记录，不伪造）
- [x] **构建机离线（部分）**：已加 `--offline` + vendor 覆盖校验；**残余未覆盖**：`--offline` 在「npm 缓存为空且 tarball 齐全」的干净构建机上未本地验证（本机缓存非空）
- [x] **当前工作树的其他未提交改动**：`git status --short` 显示本次仅 `electron-builder.yml`、`prepare-production-resources.mjs`、2 个测试文件、1 个 Plan、1 个 backups 目录为本次新增；其余改动属另一批需求，未被本次触碰

### Test / Build / Lint / Typecheck

- [x] `cd desktop && npm test`（vitest run，主进程全量）→ 86 files / 1570 passed + 2 skipped
- [x] `cd desktop && npm run build`（tsc + renderer vite build，含 typecheck）→ 通过
- [x] `cd desktop && npm run lint` → 2 errors / 116 warnings，与执行前一致（均为既有文件，非本次引入）
- [x] `cd desktop/renderer && npm run test` → **跳过**：本次未改动渲染层（仅改动 1 个 yml、1 个构建脚本、2 个 main-process 测试）

### 不在本次验收内（明确记录）

- 真实微信扫码 / 消息往返 / 审批闭环：**B1 [验证方]**，记 `BLOCKED`/`UNVERIFIED`
- 内置 2.4.6 与宿主目录 2.4.8 的版本口径：仅在 Final Report 记录，不在本次修复

---

## 6. Execution Log

### Step 0 Completed

- **Modified:** `backups/2026-10-09-weixin-plugin-deps/desktop/{electron-builder.yml,scripts/prepare-production-resources.mjs,src/companyclaw/extra-resources-contract.test.ts,src/companyclaw/production-resources.test.ts}`
- **Changes:** 仅新增 4 个备份文件，未改代码。
- **Reason:** 宪法 D1：改重要文件前先备份。
- **Verification:** `find backups/2026-10-09-weixin-plugin-deps -type f` → 4 个文件均在。

### Step 1 Completed

- **Modified:** `desktop/src/companyclaw/extra-resources-contract.test.ts`
- **Changes:** `PRODUCED_BY_PIPELINE` 增加 `"resources/openclaw-weixin/node_modules/"`；新增用例断言 yml 同时声明两条插件来源。
- **Reason:** 把「依赖必须随包」变成可执行回归断言。
- **Verification:** `npx vitest run src/companyclaw/extra-resources-contract.test.ts` → **2 failed / 5 passed**（RED，与 Plan 预期一致）。

### Step 2 Completed

- **Modified:** `desktop/electron-builder.yml`
- **Changes:** 原有整目录条目保持不变，其后新增 `resources/openclaw-weixin/node_modules/ → openclaw-weixin/node_modules/`。
- **Reason:** electron-builder 的目录映射会剪掉根 `node_modules`（实测产物仅 84/827 文件）。
- **Verification:** `npx vitest run extra-resources-contract.test.ts installer-scope.test.ts product-identity.test.ts` → **3 files / 17 tests 全通过**（RED → GREEN，未破坏既有配置约束）。

### Step 3 Completed

- **Modified:** `desktop/src/companyclaw/production-resources.test.ts`、`desktop/scripts/prepare-production-resources.mjs`
- **Changes:** 先加断言（RED 1 failed / 6 passed），再实现 2f 依赖完整性校验（按 `dependencies` 枚举，缺失抛 `WeChat plugin staging is missing dependency <name>`）。
- **Reason:** 把员工机才暴露的模块解析失败前移到构建机。
- **Verification:** `production-resources / resource-pipeline / extra-resources-contract` → **21 tests 全通过**。
- **Plan Adjustment：** 见 §7.1 —— Plan 原定的负向验证方式（改 live payload 的 `node_modules`）不成立，因为 2f 每次重建并覆盖该目录。

### Step 3-补（方案 B，经用户确认）Completed

- **Modified:** `desktop/scripts/prepare-production-resources.mjs`、`desktop/src/companyclaw/production-resources.test.ts`
- **Changes:** ① `installWeixinPluginDeps()` 增加 `--offline`；② 实测发现 `--offline` 只禁网络不禁本地缓存（改名 tarball 后仍装上缓存里的 zod 4.6.5，构建照旧成功），因此补上确定性的 **vendor 覆盖校验**：按插件 `dependencies` 要求 `vendor/` 存在对应 tarball，缺失即抛 `No vendored tarball for plugin dependency <name> in <dir>`；③ 两条断言先 RED 后 GREEN。
- **Reason:** 员工机没有 npm、构建机是唯一防线；同一个产品版本不得因构建机不同而携带不同依赖代码（方案 B = 最贴近用户体验：员工终将拿到的 payload 必须是被验证过的那一份）。
- **Verification:**
  - `npx vitest run production-resources / resource-pipeline / extra-resources-contract` → **21 tests 全通过**。
  - 负向验证：`mv vendor/zod-4.4.3.tgz ...bak-check` → `node scripts/prepare-production-resources.mjs --arch=x64` **EXIT=1**，报 `No vendored tarball for plugin dependency zod in …\vendor`；随后立即还原 tarball。
  - 还原后重跑 pipeline → 827 文件 / 886 manifest 条目 / `zod@4.4.3`。

### 最终验证 Completed

- `npm run pack:prepared` 重新打包 → packaged payload **827 文件、0 缺失、0 哈希不匹配**（逐条比对 `runtime-manifest.json` 的 path + sha256），`zod@4.4.3`、`qrcode-terminal`、`dist/index.js` 均在。
- `npm test` → **86 files / 1570 passed + 2 skipped**。
- `npm run build`（tsc + renderer vite）→ 成功。
- `npm run lint` → 2 errors / 116 warnings，**与执行前完全相同**，两处 error 位于本次未触碰的 `src/chat-attachments.ts`、`src/openclaw-upgrade-recovery.ts`；本次改动文件 eslint **0 errors**。

---

## 7. Plan Adjustment

### 7.1 记录 1：Step 3 的负向验证方式不成立（已按用户确认调整，方案 B）

- **原计划**：Step 3「Verification」第 3 条——把 `desktop/resources/openclaw-weixin/node_modules` 改名后重跑脚本，期望报 `missing dependency`。
- **新发现**：
  1. 2f 阶段每次运行都会重建 `staging/openclaw-weixin` 并在末尾整体 rename 覆盖 `desktop/resources/openclaw-weixin`，因此改 live payload **对守卫没有任何影响**（按 Plan 字面执行时构建成功，守卫未触发）。
  2. 更重要的新事实：`installWeixinPluginDeps()` 用 npm 从 `vendor/*.tgz` 安装，**npm 会对 tarball 未满足的版本范围回落到 registry**。实测把 `vendor/zod-4.4.3.tgz` 改名后，npm 静默从 registry 装了 `zod@4.6.5`（声明为 `^4.3.6`），依赖安装并非注释所声称的离线/固定。后果是同一产品版本可能在不同构建机上产出不同 payload，且 Step 3 的守卫在这种场景下不会失败。
- **为什么需要调整**：守卫要能真正挡住在员工机上炸掉的 payload；而「依赖缺失」在联网构建机上会被 npm 静默补包，守卫形同虚设。员工机没有 npm，构建机是唯一防线。
- **调整内容（经用户确认选 B）**：
  1. `desktop/scripts/prepare-production-resources.mjs` 的 `installWeixinPluginDeps()` 增加 `--offline`，使 vendor tarball 缺失/失配时**在安装阶段硬失败**（让注释里「keeps this step offline」真正成立），并修正注释。
  2. `desktop/src/companyclaw/production-resources.test.ts` 增加 `--offline` 断言（TDD：先 RED 后实现）。
  3. Step 3 的负向验证改为「改名 `plugins/openclaw-weixin/vendor/zod-4.4.3.tgz` → 构建必须在依赖安装阶段失败」，实测后立即还原。
- **新增修改范围**：`desktop/scripts/prepare-production-resources.mjs`（已在本 Plan 表内）、`desktop/src/companyclaw/production-resources.test.ts`（已在本 Plan 表内）。**无 Plan 外文件**。
- **需如实记录的验证缺口**：「npm 退出码为 0 但依赖仍然缺失」这一场景在 `--offline` 下近乎不可达；该分支由代码走查覆盖，**不伪造执行结果**。

### 7.1.1 记录 3：`--offline` 仍不足，补 vendor 覆盖校验（B 方案的「+ 校验」部分）

- **实测**：加了 `--offline` 后，把 `vendor/zod-4.4.3.tgz` 改名再跑构建——**构建仍然成功**，npm 从本地缓存装上 `zod@4.6.5`（缓存里存在联网实验期间拉下的版本）。故 `--offline` 只禁网络，**不禁本地缓存**，无法单独保证「vendor tarball 缺失即失败」。
- **补充实现（仍在 B 授权语义内，文件不变）**：`installWeixinPluginDeps()` 在安装前读取插件源 `package.json#dependencies`，要求每个依赖在 `vendor/` 中都有对应 tarball（按 `<dep>-` 前缀匹配），缺失即抛 `No vendored tarball for plugin dependency <name> in <vendorDir>`。该校验与 npm 缓存/网络状态无关，是确定性的。
- **保留** `--offline`：它阻止从 registry 拉取新版本，缩小风险面；两者互补。
- **验证方式**：改名 `vendor/zod-4.4.3.tgz` → 构建必须报上述错误（实测后立即还原）。
- **残余风险（如实记录）**：`--offline` 在「缓存为空且 tarball 齐全」的干净构建机上的行为未能本地验证（本机缓存非空）；tarball 齐全时应无需网络，但此项属未覆盖场景。

### 7.2 记录 2：实验期间构建产物被重建（非交付物，需知晓）

- 负向实验期间 `desktop/resources/openclaw-weixin` 与 `runtime-manifest.json` 被重跑两次（zod 4.6.5 → 复原后 4.4.3），随后已重新执行 pipeline 恢复为 827 文件 / 886 manifest 条目。
- `plugins/openclaw-weixin/vendor/*.tgz` 三个 tarball 均已复位，仓库源码未被污染。
- `desktop/resources/**`、`desktop/release/**` 属构建产物（gitignore 内），非交付物。

---

## 8. Final Report

### Changed Files（实际结果）

| File | Action | Change |
| ---- | ------ | ------ |
| `desktop/electron-builder.yml` | Modify | 新增 `resources/openclaw-weixin/node_modules/ → openclaw-weixin/node_modules/`（+6 行） |
| `desktop/scripts/prepare-production-resources.mjs` | Modify | `installWeixinPluginDeps()` 加 `--offline` + vendor 覆盖校验；2f 增加 staging 依赖完整性校验（+31 行） |
| `desktop/src/companyclaw/extra-resources-contract.test.ts` | Modify | 登记依赖来源 + 新增「依赖随包」回归用例（+14 行） |
| `desktop/src/companyclaw/production-resources.test.ts` | Modify | 断言依赖校验、`--offline`、vendor 覆盖校验（+13 行） |
| `docs/superpowers/plans/2026-10-09-companyclaw-bundled-weixin-plugin-implementation-plan.md` | Add | 本 Plan + Execution Log + Plan Adjustment + Final Report |
| `backups/2026-10-09-weixin-plugin-deps/**` | Add | Step 0 备份（非交付物） |

### Completed Plan Steps

- Step 0 备份待改文件
- Step 1 测试固化「插件依赖必须随包」（RED → 见 Step 2 GREEN）
- Step 2 extraResources 显式加入插件依赖目录
- Step 3 依赖缺失在构建期失败（staging 校验）
- Step 3-补 方案 B：`--offline` + vendor 覆盖校验（经用户确认）

### Verification（执行与结果）

| 验证 | 命令 | 结果 |
|---|---|---|
| 单元/集成测试 | `npm test` | 86 files / **1570 passed + 2 skipped** |
| 相关测试 | `vitest run extra-resources-contract / production-resources / resource-pipeline / installer-scope / product-identity / weixin-plugin-install` | 全绿 |
| 打包 | `npm run pack:prepared` | 成功 |
| 产物完整性 | 逐条比对 manifest path+sha256（827 条） | **0 缺失 / 0 哈希不匹配**，zod 4.4.3、qrcode-terminal、dist/index.js 均在 |
| 构建 | `npm run build` | 通过 |
| Lint | `npm run lint` | 2 errors / 116 warnings，与执行前一致（均为既有文件） |
| 负向验证 | 改名 `vendor/zod-4.4.3.tgz` 后跑 pipeline | **EXIT=1**，报 `No vendored tarball for plugin dependency zod`；已还原 |

### Notes

- **Plan 调整（2 处，均已在 §7 记录）**：
  1. Plan 原定负向验证方式（改 live payload 的 `node_modules`）不成立——2f 每次重建并覆盖该目录；已改为改名 vendor tarball。
  2. 实测发现 `installWeixinPluginDeps()` 的依赖安装并非真正的离线/固定：tarball 缺失时 npm 会回落 registry（装到 zod 4.6.5）；加 `--offline` 后仍然从**本地缓存**装 4.6.5。经用户确认选方案 B，补上确定性的 vendor 覆盖校验。
- **未覆盖风险**：
  1. 内置插件为 `2.4.6`，宿主官方目录声明 `2.4.8`；宿主的「官方外部插件」提示可能仍会出现（本次不改版本口径）。
  2. 真实微信扫码 / 消息往返 / 审批闭环受 `BLOCKERS.md` B1 阻塞，记 `BLOCKED`/`UNVERIFIED`。
  3. `--offline` 在「npm 缓存为空 + tarball 齐全」的干净构建机上的行为未本地验证。
  4. 解包产物 GUI 启动后的日志观察未执行（已用等价的逐条哈希校验替代）。
- **构建产物状态**：`desktop/resources/openclaw-weixin` = 827 文件 / `runtime-manifest.json` = 886 条；`desktop/release/win-unpacked` 与 manifest 逐条一致；`plugins/openclaw-weixin/vendor/*.tgz` 三个 tarball 已复位。

### Final Summary

- **完成内容**：让「微信插件内置」在打包产物上真正成立——`extraResources` 不再丢失插件运行时依赖（84 → 827 文件，哈希全对）；构建期新增两道确定性守卫（vendor tarball 覆盖校验、staging 依赖完整性校验），并关闭 npm 回落到 registry 的通道。
- **未修改内容**：插件源码、运行期安装/启用/扫码流程、宿主 `openclaw.asar`、legacy Python 安装器、manifest 生成规则、渲染层 UI；工作树中属于另一批需求的未提交改动一律未触碰。
- **是否符合原始 Mini Plan**：符合。Mini Plan 的 Step 1–3（映射补全 / 测试固化 / 构建期失败）全部落地；额外增加的一步（`--offline` + vendor 校验）是在用户明确选择方案 B 后追加，且未新增 Plan 外文件。
