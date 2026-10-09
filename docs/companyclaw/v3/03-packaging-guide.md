# 03 — 打包指南（构建机侧）

- 更新时间：2026-10-09
- 适用基线：`feat/companyclaw-foundation`，V3 收口完成后
- 面向对象：**构建机 / CI**。员工侧只安装一个 EXE，见 `04-employee-guide.md`。

## 唯一发行命令

```powershell
cd desktop
npm run release:win
```

该命令等价于：

```text
prepare-production-resources  →  build  →  electron-builder --win
```

`dist` 与 `dist:msix` 都指向同一套资源准备（`prepare-production-resources.mjs`），不存在"某个发行命令偷偷跳过准备步骤"的路径。`pack`（`--dir` 输出，用于本机检查）同样先跑准备脚本。

## 构建机前置条件（**员工机不需要任何一项**）

| 组件 | 版本要求 | 用途 |
|---|---|---|
| Windows | 10/11 x64 | 资源准备脚本要求 `process.platform === "win32"` 且解释器名为 `node.exe` |
| Node.js | 26.x（`>=24.16 <25 \|\| >=26.1`） | 构建与私有运行时来源（脚本把自身 `node.exe` 复制进包） |
| npm | 随 Node | 装 OpenClaw（锁定版）与插件依赖 |
| Git | 任意较新版本 | 读取 HEAD 写入 manifest 的 `buildSha` |
| .NET SDK | 9（`appcontainer`）与 10（`windows-node-host`）**按各自目标框架** | `dotnet publish`；缺失会导致流水线在 Stage 2d 中止（`BLOCKERS.md` B4） |
| 网络 | 可访问 npm registry（可用 `MSIX_NPM_REGISTRY` 覆盖） | 仅构建期下载 OpenClaw |

## 资源装配内容

`desktop/resources/`（每次构建重建，失败时保留上一份可用产物）：

```text
node.exe                     私有 Node 运行时（复制构建机解释器）
openclaw.asar                OpenClaw 锁定版（deployer/openclaw_version.py 为唯一版本真源）
windows-node/                MXC / Windows Node 运行产物 + RUNTIME.json
companyclaw-broker/dist      Broker 编译产物
companyclaw-broker/scripts   UIA PowerShell 脚本
openclaw-weixin/             微信插件：本仓库源码编译出的 dist/ + vendor 依赖
agent-skills/                目录里的 agent 技能（清单取自 src/agent-catalog.ts）
runtime-manifest.json        以上每个文件的 path/kind/version/sha256/license
```

**插件为什么要在构建机重编译**：`vendor/tencent-weixin-openclaw-weixin-2.4.6.tgz` 自带的 `dist/` 基于腾讯源码，**不含**本仓库的 `src/messaging/desktop-bridge.ts`（审批回复桥）与 `file-send.ts`。直接发 tarball 的 dist 会让审批与文件回传静默失效。插件运行期依赖（`zod`、`qrcode-terminal`）从 `vendor/*.tgz` 安装，参数含 `--omit=peer` 与 `--legacy-peer-deps`，因此 **npm 不会联网拉取 `openclaw`**（宿主自带）。

## 确定性工艺

1. **版本锁定**：OpenClaw 版本来自 `deployer/openclaw_version.py` 的 `OPENCLAW_TARGET_VERSION`，脚本读不到就报错，不会盲升 latest。
2. **私有 Node 不写 PATH**：只把 `node.exe` 放进 `resources/`，不修改系统 Node、不写全局 PATH。
3. **staging 隔离**：装配发生在 `desktop/resources/.staging-<pid>/`，逐项 hash 复校验通过后才用同卷 `rename` 原子替换；失败时逆序回滚并清理 staging。
4. **生成物不误入包**：插件编译用的临时 tsconfig 写在系统临时目录（staging 顶层的任何文件都会被搬进 `resources/`）。
5. **缺件即失败**：缺 `node.exe`、`openclaw.mjs`、插件 `dist/src/messaging/desktop-bridge.js`、任一 skill 的 `SKILL.md` 都会中止构建。

## 产物与校验

- 安装包：`desktop/release/CompanyClaw-Setup-<version>-x64.exe`（NSIS，Per-User）。
- 完整性清单：包内 `resources/runtime-manifest.json`；应用启动时由 `verifyRuntimeManifest()` 逐条校验并打印中文告警。
- **签名状态**：当前无签名证书（`BLOCKERS.md` B6），产物必须如实标注"未签名技术预览"，不得宣称通过企业发行审核。
- 建议同时发布 `sha256sum` 清单与构件来源 commit（manifest 的 `buildSha` 字段即提交 SHA）。

## 重建步骤

```powershell
git submodule update --init --recursive   # windows-node-host 依赖
cd desktop && npm install                  # 同时安装 renderer 依赖
cd ../broker && npm install
cd ../desktop && npm run release:win
```

## 兼容版本表

| 组件 | 版本 | 备注 |
|---|---|---|
| OpenClaw | `2026.9.3` | 唯一支持版本；升级必须重测 |
| Node（运行时） | 随构建机（当前 26.7.0） | 必须满足 OpenClaw 的 engines 范围 |
| 微信插件 | `2.4.6`（vendored 源码 + 本仓库补丁） | 升级需同步移植 `desktop-bridge.ts` 与 `file-send.ts` |
| `openclaw-approval-replay-compat.mjs` | 绑定 OpenClaw 模块文件名 + SHA256 白名单 | 见 `07-adr-upgrade-compat.md` |

## 回滚

升级被拒绝或失败时（`upgrade-guard.ts` 判定），**保留旧程序与旧状态**，不重置 API Key、微信 token、审批日志与任务历史。手工回退方式：重新安装旧版本安装包；用户数据目录 `%APPDATA%/CompanyClaw`（Electron userData）与 `%APPDATA%/openclaw` 不受影响。

## legacy 通道（非员工主线）

`build.ps1` 与 `deployer/`（PyInstaller + 内层 NSIS）保留供兼容性研究。`desktop/scripts/prepare-resources.mjs` 是 MSIX 早期工艺，会**整目录删除** `desktop/resources/`；它不挂在 `release:win` 或 `dist` 上，**不要**用它准备员工发行物。
