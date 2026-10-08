# 11 — 运维手册

## 常用命令

```bash
# 桌面主进程（含安全内核）
cd desktop && npx vitest run
cd desktop && npx vitest run src/companyclaw        # 仅安全内核
cd desktop && npx tsc --noEmit
cd desktop && npx eslint src/companyclaw

# 渲染端
cd desktop/renderer && npx vitest run

# Windows Execution Broker（实机测试会串行驱动真实 UI Automation）
cd broker && npx vitest run
cd broker && npx vitest run uia-write.live.test.ts  # 仅写入路径
cd broker && npx tsc --noEmit

# 安装器（Python ≥3.10；CI 使用 3.12）
python -m unittest discover -s tests

# 开发运行
cd desktop && npm run dev
```

## 数据位置与重置

```text
%APPDATA%/<产品目录>/companyclaw/
  tasks.json                 任务
  approvals.json             审批
  identity-binding.json      微信身份绑定
  companyclaw-ticket-secret  票据密钥
  jobs/<taskId>/artifacts/   任务产物
```

| 目标 | 操作 |
|---|---|
| 解除微信绑定 | 任务中心 / `companyclaw:identity:unbind`，或删除 `identity-binding.json` |
| 作废所有待审批 | 删除 `approvals.json`（失败关闭：读不到即无待审批） |
| 清空任务 | 删除 `tasks.json` |
| 轮换票据密钥 | 删除 `companyclaw-ticket-secret`，重启应用（旧票据自然失效） |

**注意**：删除上述文件的语义是"什么都不授权"，不是"全部授权"。这是有意的失败关闭设计。

## 紧急停止

1. **任务级**：任务中心 → 对应任务的「紧急停止」
2. **能力级**：任务中心 → 「立即撤销」远程操作授权（立即生效）
3. **进程级**：退出应用（Broker 随 stdin 关闭而终止，不留孤立监听）
4. **彻底阻断**：任务中心 → 解绑微信身份

**不得宣称**紧急停止可撤销已提交的业务交易。

## Broker 排查

| 现象 | 检查 |
|---|---|
| 所有操作返回 `process-not-allowed` | 应用白名单当前为**空**（失败关闭默认值）；需显式配置允许的应用 |
| `broker bootstrap failed` | Broker 未编译：`cd broker && npx tsc` |
| `broker exited during startup` | 检查 Broker 目录与 `scripts/` 是否随包分发 |
| 操作返回 `unavailable` | Broker 未运行或传输失败——**这不是策略拒绝**，两者含义不同 |
| 操作返回 `failed/not-implemented` | 该操作尚未实现（`describe-element`、`wait-for-window`） |
| 写入返回 `verification-failed` | 写入未生效（回读不一致）；**不要**当作成功 |

## 安全事件处置

| 事件 | 处置 |
|---|---|
| 疑似跨账号访问 | 立即撤销远程授权 + 解绑身份；记录任务与审批记录；按发布阻塞级处理 |
| 疑似未授权执行 | 同上；检查 `approvals.json` 是否有非本人 resolvedBy |
| 密钥疑似泄露 | 删除 `companyclaw-ticket-secret` 与模型密钥配置并轮换 |
| 提示词注入迹象 | 检查是否有动作超出域名/应用白名单（应已被拒绝） |

## 日志

- 主进程日志：`console.log` / `console.error`，前缀 `[companyclaw]`
- 安全检查点：`[companyclaw] Security-core IPC registered (owner=…, broker=…)`
- 注册失败：`[companyclaw] Failed to register security-core IPC:` —— **应用仍会启动**，但任务中心会显示"未启用该能力"

## 卸载

```powershell
# 默认：保留用户数据与主机安全配置
.\scripts\windows\uninstall-dependencies.ps1

# 显式清除用户数据（模型密钥、微信绑定、浏览器 Profile、任务历史）
.\scripts\windows\uninstall-dependencies.ps1 -PurgeUserData

# 显式移除 Defender 排除项（需管理员）
.\scripts\windows\uninstall-dependencies.ps1 -RemoveDefenderExclusions
```

## 已知运维限制

- 任务中断恢复：重启后任务可查，但"复核并继续"未实现 → 涉及写入的任务需人工确认状态
- 应用白名单无配置界面（当前仅代码默认值）
- 无自动清理过期任务的定时器（但读取时已强制投影为 `expired`，安全属性不依赖定时器）
