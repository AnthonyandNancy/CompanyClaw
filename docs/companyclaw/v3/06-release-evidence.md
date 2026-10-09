# 06 — 发行证据（PKG-01–10 / E01–20）

- 生成时间：2026-10-09
- 代码基线：见各条 `Baseline`
- 判据来源：V3 实施书 §15.2（PKG）、§15.3（E）、§15.4（真实状态规则）
- 证据目录：`docs/companyclaw/evidence/<release-id>/<test-id>/`（**当前为空**）

> **状态诚实性声明**：本机可完成的验证只覆盖"代码 + 单元测试 + 类型检查 + lint + broker 实机 UIA 用例"。
> 依赖真实微信账号、内网业务系统、清洁 Win11 目标机、.NET SDK 与代码签名证书的项**全部**记 `BLOCKED` 或 `UNVERIFIED`。
> 不得把策略层单测折算为"整包可用"，不得用 mock 替代手机收件。当前**尚未产出签名安装包**，因此不存在 release-id。

## 阻塞依据（详见 `BLOCKERS.md`）

| 阻塞 | 内容 | 影响的状态 |
|---|---|---|
| B1 | 无微信测试账号 | 所有微信收发/审批/文件回传项 |
| B2 | 无内网业务系统与脱敏数据 | Web 自主操作与业务写入项 |
| B4 | 构建机无 .NET SDK | `dotnet publish`、`AppContainerLauncher.exe`、安装包产出 |
| B6 | 无代码签名证书 | 安装包交付与 SmartScreen 相关项 |
| B7 | 非管理员会话（目标机缺失） | 清洁机安装/卸载实测 |

## PKG-01–10

| ID | 验收项 | 状态 | 说明 / 现有证据 |
|---|---|---|---|
| PKG-01 | 断网 Per-User 安装 | `BLOCKED` | 需清洁 Win11 + 已构建安装包（B4/B6/B7）。装配侧已保证不执行 npm/pip/git：`prepare-production-resources.mjs` 的插件依赖来自 `vendor/*.tgz`（离线），OpenClaw 在构建机预装。 |
| PKG-02 | payload 完整性 | `UNVERIFIED` | 构建期逐文件 hash 校验与失败即中止已实现并有负向单测（`resource-pipeline.test.ts`：缺件/篡改/重复）；**从未在完整 payload 上实跑**（B4 使流水线在 `dotnet publish` 处中止）。 |
| PKG-03 | 生产 Broker 启动 | `UNVERIFIED` | 私有 Node 解析 + 前置校验 + 错误码有单测覆盖；UIA 实机用例（9 项）在开发态通过。打包态未验证（B4）。 |
| PKG-04 | 生产 Gateway 启动 | `UNVERIFIED` | 首启配置生成与插件安装有单测；打包态启动与真实鉴权未验证（B4/B1）。 |
| PKG-05 | 双员工隔离 | `BLOCKED` | 需两个真实 Windows 账户/微信身份（B1/B7）。代码侧按 SID 隔离（`owner-sid.ts`、per-user userData）。 |
| PKG-06 | 升级与回滚 | `UNVERIFIED` | 升级判定逻辑有 12 条单测（schema 更新即拒绝、manifest 契约不符即拒绝）；需两个版本产物才能实测（B4/B6）。 |
| PKG-07 | 关闭/后台/重启 | `BLOCKED` | 需目标机与托盘实测；Broker 生命周期（退出检测/重启上限/停止收口）已有单测。 |
| PKG-08 | 中文与特殊路径 | `UNVERIFIED` | 中文/空格路径在 Node 路径解析、Broker 启动、产物文件名上均有单测；DPI/多屏未验证（B7）。 |
| PKG-09 | 安全默认项 | `UNVERIFIED` | 无 Defender 例外、无提权、R3 拒绝均已有测试；需安装态复核（B4）。 |
| PKG-10 | 卸载数据 | `UNVERIFIED` | 卸载默认保留用户数据已有测试（`installer-scope.test.ts`、Python 用例）；需真实卸载实测（B7）。 |

## E01–E20

| ID | 业务测试 | 状态 | 说明 |
|---|---|---|---|
| E01 | 新机安装 | `BLOCKED` | 依赖 PKG-01/02/04 |
| E02 | DeepSeek + Tool Call | `BLOCKED` | 需真实模型密钥与网络；探针逻辑已有单测（三态，未验证不当作可用） |
| E03 | 微信扫码/解绑 | `BLOCKED` | B1 |
| E04 | 双员工隔离 | `BLOCKED` | B1/B7 |
| E05 | Web 多级菜单搜索 | `BLOCKED` | B2 |
| E06 | Web 修改（含审批与回读） | `BLOCKED` | B2 |
| E07 | 复杂 Web（iframe/异步/弹窗） | `BLOCKED` | B2 |
| E08 | Windows 客户端查询 | `UNVERIFIED` | UIA 读取在开发机实机通过（含中文窗口）；打包态未验证（B4） |
| E09 | Windows 客户端写入 | `UNVERIFIED` | 写入+回读在开发机实机通过；打包态与真实业务客户端未验证（B2/B4） |
| E10 | Browser→Windows→Excel | `BLOCKED` | B2 |
| E11 | 微信文件回传 | `BLOCKED` | 需手机实际收件（B1）。校验/送达状态机有 10 条单测 |
| E12 | 锁屏/睡眠/离线 | `BLOCKED` | 需目标机 |
| E13 | SSO/MFA 过期 | `BLOCKED` | B2 |
| E14 | 微信重复投递 | `UNVERIFIED` | 去重与幂等有单测（同 messageId 恢复同一任务）；真实断线重连未验证（B1） |
| E15 | 模型超时/429 | `UNVERIFIED` | 探针区分传输失败与模型不可用；真实 429 未验证（B1 外的外部条件） |
| E16 | 提示词注入与越权 | `UNVERIFIED` | "来源不可自报"有单测；真实页面注入未验证（B2） |
| E17 | 沙盒/Broker/Browser | `UNVERIFIED` | R3/无票据/不可映射动作的执行层拒绝有单测；打包态未验证（B4） |
| E18 | 中文 Win11/DPI/多屏 | `UNVERIFIED` | 中文路径有单测；DPI/多屏未验证（B7） |
| E19 | 安装升级卸载 | `BLOCKED` | 依赖 PKG-06/09/10 |
| E20 | 任务中断恢复 | `UNVERIFIED` | 任务状态持久化与"已提交但未 ACK 先回读"语义有测试；断电实测未做 |

## 本机已实测通过的部分（可作为开发构建证据）

| 范围 | 命令 | 结果 |
|---|---|---|
| desktop 全量 | `cd desktop && npx vitest run` | 85 files / 1562 passed, 2 skipped |
| renderer 全量 | `cd desktop/renderer && npx vitest run` | 28 files / 326 passed |
| broker 全量 | `cd broker && npx vitest run` | 10 files / 68 passed |
| 插件全量 | `cd desktop && npx vitest run --root ../plugins/openclaw-weixin` | 15 passed |
| 类型检查 | `npx tsc --noEmit`（desktop、broker）与 `vue-tsc --noEmit`（renderer） | 均 clean |
| Lint | `npx eslint src/companyclaw`、`npm run lint:weixin` | 0 errors（既有 warning 除外） |
| 装配失败路径 | `cd desktop && npm run prepare-production-resources` | 在 `dotnet publish` 处失败（B4），旧 `resources/` 完好、无 `.staging-*` 残留 |

## 分级放行（§15.5 对照）

| 等级 | 当前是否达到 | 依据 |
|---|---|---|
| 开发构建 | **是** | 上表全部通过 |
| 只读技术预览 | **否** | 需先产出安装包并完成本地安装与只读工具调用（B4/B6） |
| 内部真实业务修改试点 | **否** | 需 E01–E04、E06、E09、E11、E16、E17、E19 实际 PASS |
| 正式员工推广 | **否** | 需全部适用 E/PKG 项与签名 |
