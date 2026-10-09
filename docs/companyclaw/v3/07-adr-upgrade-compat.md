# 07 — OpenClaw 升级兼容关系（`openclaw-approval-replay-compat`）

- 更新时间：2026-10-09
- 状态：记录现状与升级约束，不改变既有实现
- 相关文件：`desktop/src/openclaw-approval-replay-compat.mjs`、`desktop/src/main.ts`、`docs/companyclaw/ADR/0004-browser-execution-path.md`

## 它是什么

一个以 `--import` 注入 Gateway 子进程的 Node 模块钩子（`node:module` 的 `registerHooks`）。它在模块加载期重写 OpenClaw 内部实现，为 **Windows Node / MXC** 路径补上"审批证明"绑定与防重放语义。

## 与 OpenClaw 版本的真实耦合（源码事实）

文件顶部以常量形式钉住版本与模块身份，任一不匹配即拒绝继续：

| 常量 | 值 |
|---|---|
| `EXPECTED_VERSION` | `2026.9.3` |
| `EXPECTED_NODE_GATEWAY_MODULE` | `nodes-C8-hkmi0.mjs` + 对应 SHA-256 |
| `EXPECTED_SYSTEM_RUN_MODULE` | `system-run-approval-binding-DMkQH3tb.mjs` + 对应 SHA-256 |
| `EXPECTED_EXEC_APPROVAL_MODULE` | `exec-approval-B0MHHes6.mjs` + 对应 SHA-256 |

`validatePinnedOpenClawApprovalPackage()` 会校验包的 `version`，并逐个校验被 patch 模块的文件名与 SHA-256；patch 本身是对源码做**逐字节**替换（`replaceExactlyOnce`）。因此：

- 上游改变任一模块的文件名或内容 → 校验失败（这是**预期**行为，宁可失败也不要静默不生效）。
- 上游改版本号 → 同样失败。

## 当前生效范围（重要）

该钩子**只在** `securityMode === "windows-node-mxc"` 时注入（`main.ts` 的 Gateway spawn 参数）。`securityMode` 的默认值是 `appcontainer`，因此：

- 普通员工的默认配置下，**这个钩子不生效**；
- 它保护的写入路径是 MXC 模式下的 `exec` 审批，不是 CompanyClaw 自有执行器（Broker / Browser）的授权路径；
- 不得据此宣称"所有远程写入都由它拦截"——CompanyClaw 的执行授权在 `CompanyClawRuntime` + `ExecutionBridge` + Broker 服务端校验，与该钩子无关。

## 升级 OpenClaw 时的必做清单

1. 更新 `deployer/openclaw_version.py` 的 `OPENCLAW_TARGET_VERSION`（版本唯一真源）。
2. 在目标版本上重新确认三个模块的**文件名与 SHA-256**；若文件名变化，说明上游重构了这些模块，需要重新移植 patch 逻辑，而不是只改常量。
3. 重跑 `validatePinnedOpenClawApprovalPackage()` 相关的既有测试与 MXC 路径回归（本仓库保留 `desktop/src/openclaw-approval-replay-compat` 的测试资产）。
4. **不得**通过关闭校验（例如放宽 SHA 比较）来解决不兼容，V3 §7.2 第 6 条明确禁止。
5. 同步更新 `03-packaging-guide.md` 的兼容版本表。

## 与微信插件的同类约束

微信插件同样以固定版本分发（`2.4.6`），且本仓库在其源码上做了两处**追加式**补丁：

- `src/messaging/desktop-bridge.ts`（会话来源转发 + 审批回复转发，以及文件发送请求的分发入口）；
- `src/messaging/file-send.ts`（应桌面请求执行上传）。

`vendor/tencent-weixin-openclaw-weixin-2.4.6.tgz` 自带的 `dist/` **不含**这些补丁，所以构建机必须用本仓库源码重新编译（见 `03-packaging-guide.md`）。升级插件版本时，需要把这两个文件按新版本源码重新移植并重跑插件测试，而不是直接采用上游 tarball 的 `dist/`。
