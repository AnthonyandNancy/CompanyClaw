<script setup lang="ts">
/**
 * "电脑操作权限" — the one page that turns the permission model into something an
 * employee can use.
 *
 * Requirement V5 §4.4 asks for three plain choices, an explicit acknowledgement
 * the first time the daily preset is enabled, separate cloud-vision switches,
 * the ability to see and revoke what is currently allowed, and a reset that
 * states its blast radius before it runs. Ruling Q6/Q-D adds that the reset must
 * not be a display-only change.
 *
 * Every value here comes from the main process. The component never derives a
 * decision locally and never treats a missing bridge as "allowed".
 */
import { computed, onMounted, ref } from "vue";
import { useCompanyClawStore } from "@/stores/companyclaw";

const store = useCompanyClawStore();

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const presets = ref<
  {
    preset: "BASIC" | "FULL_DAILY" | "CUSTOM";
    policyVersion: number;
    presetChangedAt: string | null;
    counts: { trustedApps: number; trustedSites: number; workFolders: number; taskGrants: number };
    warning: string | null;
  } | null
>(null);

const presetCards: {
  id: "BASIC" | "FULL_DAILY" | "CUSTOM";
  title: string;
  detail: string;
  confirmations: string;
  recommended?: boolean;
}[] = [
  {
    id: "BASIC",
    title: "基础权限",
    detail: "在已授权范围内查询、查看、受控浏览器阅读与只读任务",
    confirmations: "对新应用操作、文件修改、业务写入仍会请求你确认",
  },
  {
    id: "FULL_DAILY",
    title: "全面日常操作",
    detail: "允许正常打开已安装应用与网站、切换窗口、查找控件、普通导航与输入、整理授权任务内的文件",
    confirmations: "重大业务提交、对外发消息、敏感文件外发、删除、付款与提权仍需要你确认",
    recommended: true,
  },
  {
    id: "CUSTOM",
    title: "高级自定义",
    detail: "逐项管理应用、网站、文件目录与特殊业务权限，保留原有沙箱与隔离控制",
    confirmations: "超出自定义范围或属于业务高风险时仍会请求你确认",
  },
];

const vision = ref<Record<string, { enabled: boolean; provider: string; baseUrl: string; model: string; expiresAt: string | null }>>({});
const taskGrants = ref<{ taskId: string; targets: string[]; expiresAt: string }[]>([]);
const trustedApps = ref<{ processName: string; displayName: string; scope: string; legacy: boolean }[]>([]);
const trustedSites = ref<{ domain: string; kind: string }[]>([]);
const recoveryPreview = ref<{
  token: string;
  counts: {
    trustedApps: number;
    trustedSites: number;
    workFolders: number;
    taskGrants: number;
    activeTasks: number;
    pendingApprovals: number;
    legacyGrants: number;
  };
  retained: string[];
} | null>(null);
const showRecovery = ref(false);
const recoveryResult = ref<string | null>(null);
const acknowledgeDialog = ref(false);
const pendingPreset = ref<"FULL_DAILY" | null>(null);

const bridgeAvailable = computed(() => typeof window !== "undefined" && Boolean(window.openclaw?.companyClaw?.permissions));

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const api = window.openclaw?.companyClaw;
    if (!api?.permissions) {
      error.value = "当前环境不支持权限设置（应用未完成初始化）";
      return;
    }
    const policy = await api.permissions.getPolicy();
    presets.value = policy;
    vision.value = policy.vision ?? {};
    taskGrants.value = (await api.permissions.listTaskGrants()) as typeof taskGrants.value;
    trustedApps.value = (await api.permissions.listTrustedApps()) as typeof trustedApps.value;
    trustedSites.value = (await api.permissions.listTrustedSites()) as typeof trustedSites.value;
  } catch (err) {
    // An unreachable bridge is reported as unavailable, never as "allowed".
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function selectPreset(preset: "BASIC" | "FULL_DAILY" | "CUSTOM") {
  const api = window.openclaw?.companyClaw;
  if (!api?.permissions) return;
  if (preset === "FULL_DAILY" && presets.value?.preset !== "FULL_DAILY") {
    pendingPreset.value = "FULL_DAILY";
    acknowledgeDialog.value = true;
    return;
  }
  await applyPreset(preset, true);
}

async function applyPreset(preset: "BASIC" | "FULL_DAILY" | "CUSTOM", acknowledged: boolean) {
  const api = window.openclaw?.companyClaw;
  if (!api?.permissions) return;
  saving.value = true;
  error.value = null;
  try {
    await api.permissions.setPreset({ preset, acknowledged });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

function confirmAcknowledge() {
  acknowledgeDialog.value = false;
  if (pendingPreset.value) void applyPreset(pendingPreset.value, true);
  pendingPreset.value = null;
}

function cancelAcknowledge() {
  acknowledgeDialog.value = false;
  pendingPreset.value = null;
}

async function revokeApp(processName: string) {
  await window.openclaw?.companyClaw?.permissions?.revokeTrustedApp({ processName });
  await load();
}

async function revokeSite(domain: string) {
  await window.openclaw?.companyClaw?.permissions?.revokeTrustedSite({ domain });
  await load();
}

async function revokeGrant(taskId: string) {
  await window.openclaw?.companyClaw?.permissions?.revokeTaskGrant({ taskId });
  await load();
}

async function toggleVision(origin: "local" | "remote", enabled: boolean) {
  const api = window.openclaw?.companyClaw;
  if (!api?.vision) return;
  saving.value = true;
  error.value = null;
  try {
    if (!enabled) {
      await api.vision.revoke({ origin });
    } else {
      const current = vision.value[origin];
      if (!current?.provider || !current?.model) {
        // Authorization must name the provider; without it the employee cannot
        // be told who receives the image.
        error.value = "请先在模型设置中配置服务商与模型，再授权云端视觉识别";
        return;
      }
      await api.vision.set({
        origin,
        provider: current.provider,
        baseUrl: current.baseUrl,
        model: current.model,
      });
    }
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

async function openRecovery() {
  const api = window.openclaw?.companyClaw;
  if (!api?.recovery) return;
  recoveryResult.value = null;
  recoveryPreview.value = (await api.recovery.preview()) as typeof recoveryPreview.value;
  showRecovery.value = true;
}

async function applyRecovery() {
  const api = window.openclaw?.companyClaw;
  if (!api?.recovery || !recoveryPreview.value) return;
  saving.value = true;
  try {
    const result = await api.recovery.apply({ token: recoveryPreview.value.token });
    recoveryResult.value = result.applied
      ? `已恢复安全默认值（暂停任务 ${result.pausedTasks ?? 0} 个，作废审批 ${result.invalidatedApprovals ?? 0} 个）`
      : `未执行：${result.reason ?? "状态已变化，请重新查看影响范围"}`;
    showRecovery.value = false;
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

onMounted(load);

defineExpose({ load });
</script>

<template>
  <div class="section">
    <div class="section-header">
      <span class="section-title">电脑操作权限</span>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </div>

    <div v-if="loading" class="card-group">
      <div class="card-row"><span class="row-label">正在读取权限设置…</span></div>
    </div>

    <div v-else-if="error" class="card-group">
      <div class="card-row no-border">
        <span class="row-label">权限设置不可用</span>
        <span class="row-sub">{{ error }}</span>
      </div>
    </div>

    <template v-else>
      <div v-if="presets?.warning" class="card-group">
        <div class="card-row no-border">
          <span class="row-sub">{{ presets.warning }}</span>
        </div>
      </div>

      <div class="card-group">
        <div
          v-for="card in presetCards"
          :key="card.id"
          class="card-row"
          :class="{ 'no-border': card.id === 'CUSTOM' }"
        >
          <label class="preset-option">
            <input
              type="radio"
              name="companyclaw-preset"
              :value="card.id"
              :checked="presets?.preset === card.id"
              :disabled="saving"
              @change="selectPreset(card.id)"
            />
            <span class="row-label">
              {{ card.title }}<span v-if="card.recommended">（推荐）</span>
              <span v-if="presets?.preset === card.id" class="preset-badge">已启用</span>
            </span>
          </label>
          <span class="row-sub">{{ card.detail }}</span>
          <span class="row-sub">{{ card.confirmations }}</span>
          <span v-if="card.id === 'FULL_DAILY'" class="row-sub">
            与 Windows 管理员权限无关；不会获得系统级管理能力。
          </span>
        </div>
      </div>

      <div class="card-group">
        <div class="card-row">
          <span class="row-label">正在允许的任务</span>
          <span class="row-sub">这些任务范围内的普通步骤不再重复询问；可单独撤销。</span>
        </div>
        <div v-if="taskGrants.length === 0" class="card-row">
          <span class="row-sub">当前没有任务级授权。直接下指令即可，系统会在需要时询问一次。</span>
        </div>
        <div v-for="grant in taskGrants" :key="grant.taskId" class="card-row">
          <span class="row-label">{{ grant.targets.join("、") || "（未命名目标）" }}</span>
          <span class="row-sub">到期：{{ formatTime(grant.expiresAt) }}</span>
          <el-button size="small" :disabled="saving" @click="revokeGrant(grant.taskId)">撤销</el-button>
        </div>
      </div>

      <div class="card-group">
        <div class="card-row">
          <span class="row-label">云端视觉识别</span>
          <span class="row-sub">
            本机截图默认可用；把屏幕内容发送给你配置的模型服务商默认关闭，需要单独授权。
          </span>
        </div>
        <div class="card-row">
          <span class="row-label">允许本地 AI 使用云端视觉</span>
          <el-switch
            :model-value="vision.local?.enabled === true"
            :disabled="saving"
            @change="(v: boolean) => toggleVision('local', v)"
          />
        </div>
        <div class="card-row">
          <span class="row-label">允许微信远程 AI 使用云端视觉</span>
          <el-switch
            :model-value="vision.remote?.enabled === true"
            :disabled="saving"
            @change="(v: boolean) => toggleVision('remote', v)"
          />
        </div>
        <div v-if="vision.local?.enabled || vision.remote?.enabled" class="card-row no-border">
          <span class="row-sub">
            服务商：{{ vision.local?.provider || vision.remote?.provider || "—" }}；
            有效期至：{{ formatTime(vision.local?.expiresAt || vision.remote?.expiresAt || null) }}。
            更换模型或服务商后需要重新授权；已发送出去的内容无法撤回。
          </span>
        </div>
      </div>

      <div class="card-group">
        <div class="card-row">
          <span class="row-label">高级设置</span>
          <span class="row-sub">
            已记住 {{ presets?.counts.trustedApps ?? 0 }} 个应用、{{ presets?.counts.trustedSites ?? 0 }} 个网站、
            {{ presets?.counts.workFolders ?? 0 }} 个工作目录。切换档位不会删除它们。
          </span>
        </div>
        <div v-for="app in trustedApps" :key="app.processName" class="card-row">
          <span class="row-label">
            {{ app.displayName }}（{{ app.processName }}）
            <span v-if="app.legacy" class="preset-badge">旧版授权</span>
          </span>
          <span class="row-sub">
            作用范围：{{ app.scope === "both" ? "本机与微信" : app.scope === "remote" ? "仅微信远程" : "仅本机" }}
          </span>
          <el-button size="small" :disabled="saving" @click="revokeApp(app.processName)">移除</el-button>
        </div>
        <div v-for="site in trustedSites" :key="site.domain" class="card-row">
          <span class="row-label">{{ site.domain }}</span>
          <span class="row-sub">{{ site.kind === "user-trusted" ? "你信任的站点" : site.kind }}</span>
          <el-button size="small" :disabled="saving" @click="revokeSite(site.domain)">移除</el-button>
        </div>
      </div>

      <div class="card-group">
        <div class="card-row no-border">
          <el-button :disabled="saving || !bridgeAvailable" @click="openRecovery">
            一键恢复安全默认值
          </el-button>
          <span v-if="recoveryResult" class="row-sub">{{ recoveryResult }}</span>
        </div>
      </div>
    </template>

    <el-dialog v-model="acknowledgeDialog" title="启用「全面日常操作」" width="480">
      <p>启用后，公司电脑上的普通操作将不再逐项询问：</p>
      <ul class="preset-list">
        <li>正常打开已安装的应用与网站</li>
        <li>切换窗口、查找控件、普通导航与输入</li>
        <li>读取屏幕与界面信息（用于定位，不代表会上传）</li>
      </ul>
      <p>以下操作仍然需要你确认：</p>
      <ul class="preset-list">
        <li>重大业务提交、对外发送消息、敏感文件外发</li>
        <li>删除、付款、提升权限等不可逆操作</li>
      </ul>
      <p class="row-sub">这与 Windows 管理员权限无关，也不会关闭系统的安全机制。</p>
      <template #footer>
        <el-button @click="cancelAcknowledge">取消</el-button>
        <el-button type="primary" @click="confirmAcknowledge">确认启用</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showRecovery" title="恢复安全默认值" width="520">
      <template v-if="recoveryPreview">
        <p>以下内容将被清除或撤销：</p>
        <ul class="preset-list">
          <li>权限档位恢复为「基础权限」</li>
          <li>关闭本机与微信远程的云端视觉授权</li>
          <li>撤销当前的微信远程操作授权</li>
          <li>清除已记住的应用信任 {{ recoveryPreview.counts.trustedApps }} 项、网站信任 {{ recoveryPreview.counts.trustedSites }} 项</li>
          <li>清除工作目录授权 {{ recoveryPreview.counts.workFolders }} 项、任务级授权 {{ recoveryPreview.counts.taskGrants }} 项</li>
          <li>作废尚未处理的审批 {{ recoveryPreview.counts.pendingApprovals }} 条</li>
          <li>暂停正在执行的任务 {{ recoveryPreview.counts.activeTasks }} 个（本机与微信远程都包含，不会关闭你正在用的软件）</li>
        </ul>
        <p>以下内容会保留：</p>
        <ul class="preset-list">
          <li v-for="item in recoveryPreview.retained" :key="item">{{ item }}</li>
        </ul>
      </template>
      <template #footer>
        <el-button @click="showRecovery = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="applyRecovery">确认恢复</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.preset-option {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.preset-badge {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}
.preset-list {
  margin: 4px 0 12px 18px;
  padding: 0;
  font-size: 13px;
  line-height: 1.7;
}
</style>
