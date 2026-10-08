<template>
  <div class="cc-task-centre">
    <div class="view-header">
      <h2>{{ t("cc.tasksTitle") }}</h2>
      <p class="view-desc">{{ t("cc.tasksDesc") }}</p>
      <el-button size="small" :loading="store.loading" @click="store.refresh()">
        {{ t("cc.tasksRefresh") }}
      </el-button>
    </div>

    <!-- The security core registers its IPC handlers independently of startup;
         when it is absent the feature reports itself unavailable instead of
         showing an empty list that would read as "no tasks". -->
    <el-alert v-if="!store.available" type="info" :closable="false" class="cc-alert">
      {{ t("cc.remoteUnavailable") }}
    </el-alert>

    <template v-else>
      <el-alert v-if="store.error" type="error" :closable="false" class="cc-alert">
        {{ store.error }}
      </el-alert>

      <!-- Remote operation authorization -->
      <section class="cc-card">
        <div class="cc-card-head">
          <div>
            <div class="cc-card-title">{{ t("cc.remoteTitle") }}</div>
            <div class="cc-card-desc">{{ t("cc.remoteDesc") }}</div>
          </div>
          <el-tag :type="remoteTagType" size="small">{{ remoteStateLabel }}</el-tag>
        </div>
        <div class="cc-card-body">
          <div class="cc-row">
            <span class="cc-label">{{ t("cc.remoteState") }}</span>
            <span class="cc-value">{{ remoteStateLabel }}</span>
          </div>
          <div class="cc-row">
            <span class="cc-label">{{ t("cc.remoteExpiresAt") }}</span>
            <span class="cc-value">{{ formattedExpiry }}</span>
          </div>
          <div class="cc-actions">
            <el-select v-model="ttlMinutes" size="small" :disabled="store.remoteEnabled">
              <el-option :label="t('cc.remoteTtl15')" :value="15" />
              <el-option :label="t('cc.remoteTtl60')" :value="60" />
              <el-option :label="t('cc.remoteTtl480')" :value="480" />
            </el-select>
            <el-button
              type="primary"
              size="small"
              :loading="store.loading"
              :disabled="store.remoteEnabled"
              @click="store.enableRemoteOperation({ ttlMinutes })"
            >
              {{ t("cc.remoteEnable") }}
            </el-button>
            <el-button
              type="danger"
              size="small"
              :disabled="!store.remoteEnabled"
              @click="store.revokeRemoteOperation()"
            >
              {{ t("cc.remoteRevoke") }}
            </el-button>
          </div>
        </div>
      </section>

      <!-- Application allow list: the broker refuses every process until one
           is allowed here, so this is the switch that makes automation possible
           at all. -->
      <section class="cc-card">
        <div class="cc-card-head">
          <div>
            <div class="cc-card-title">{{ t("cc.brokerTitle") }}</div>
            <div class="cc-card-desc">{{ t("cc.brokerDesc") }}</div>
          </div>
          <el-tag :type="store.brokerTargets.allowedProcesses.length > 0 ? 'success' : 'info'" size="small">
            {{ store.brokerTargets.allowedProcesses.length }}
          </el-tag>
        </div>
        <div class="cc-card-body">
          <div v-if="store.brokerTargets.allowedProcesses.length === 0" class="cc-alert-inline">
            {{ t("cc.brokerEmpty") }}
          </div>
          <div class="cc-tag-list">
            <el-tag
              v-for="name in store.brokerTargets.allowedProcesses"
              :key="name"
              closable
              size="small"
              @close="removeProcess(name)"
            >
              {{ name }}
            </el-tag>
          </div>
          <div class="cc-actions">
            <el-input
              v-model="newProcess"
              size="small"
              :placeholder="t('cc.brokerPlaceholder')"
              style="max-width: 220px"
              @keyup.enter="addProcess"
            />
            <el-button size="small" @click="addProcess">{{ t("cc.brokerAdd") }}</el-button>
          </div>
        </div>
      </section>

      <!-- Pending approvals come first: they block a running task. -->
      <section class="cc-card">
        <div class="cc-card-head">
          <div class="cc-card-title">{{ t("cc.approvalsTitle") }}</div>
          <span class="cc-count">{{ store.pendingApprovals.length }}</span>
        </div>
        <div class="cc-card-desc cc-card-desc--inset">{{ t("cc.approvalsDesc") }}</div>
        <div v-if="store.pendingApprovals.length === 0" class="cc-empty">
          {{ t("cc.approvalsEmpty") }}
        </div>
        <div v-else class="cc-approval-list">
          <div
            v-for="approval in store.pendingApprovals"
            :key="approval.approvalId"
            class="cc-approval"
          >
            <div class="cc-approval-grid">
              <div>
                <span class="cc-label">{{ t("cc.approvalTarget") }}</span>
                <span class="cc-value">{{ approval.targetSystem || "—" }}</span>
              </div>
              <div>
                <span class="cc-label">{{ t("cc.approvalRecord") }}</span>
                <span class="cc-value">{{ approval.recordId || "—" }}</span>
              </div>
              <div>
                <span class="cc-label">{{ t("cc.approvalField") }}</span>
                <span class="cc-value">{{ approval.field || "—" }}</span>
              </div>
              <div>
                <span class="cc-label">{{ t("cc.approvalChange") }}</span>
                <span class="cc-value">
                  {{ approval.oldValue ?? "—" }} → {{ approval.newValue ?? "—" }}
                </span>
              </div>
              <div>
                <span class="cc-label">{{ t("cc.approvalExpiresAt") }}</span>
                <span class="cc-value">{{ formatTime(approval.expiresAt) }}</span>
              </div>
            </div>
            <div class="cc-approval-actions">
              <el-button
                type="primary"
                size="small"
                @click="store.resolveApproval(approval.approvalId, 'approved')"
              >
                {{ t("cc.approvalApprove") }}
              </el-button>
              <el-button size="small" @click="store.resolveApproval(approval.approvalId, 'denied')">
                {{ t("cc.approvalDeny") }}
              </el-button>
            </div>
          </div>
        </div>
      </section>

      <!-- Task list -->
      <section class="cc-card">
        <div class="cc-card-head">
          <div class="cc-card-title">{{ t("cc.tasksTitle") }}</div>
          <span class="cc-count">{{ store.tasks.length }}</span>
        </div>
        <div v-if="store.loading && store.tasks.length === 0" class="cc-empty">
          {{ t("cc.loading") }}
        </div>
        <div v-else-if="store.tasks.length === 0" class="cc-empty">
          <div>{{ t("cc.tasksEmpty") }}</div>
          <div class="cc-empty-desc">{{ t("cc.tasksEmptyDesc") }}</div>
        </div>
        <el-table v-else :data="store.tasks" style="width: 100%" size="small">
          <el-table-column :label="t('cc.tasksColObjective')" min-width="240">
            <template #default="{ row }">
              <span class="cc-objective">{{ row.objective || "—" }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('cc.tasksColState')" width="140">
            <template #default="{ row }">
              <el-tag :type="stateTagType(row.state)" size="small">
                {{ stateLabel(row.state) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('cc.tasksColChannel')" width="150">
            <template #default="{ row }">{{ row.channel || "—" }}</template>
          </el-table-column>
          <el-table-column :label="t('cc.tasksColUpdated')" width="170">
            <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column :label="t('cc.tasksColActions')" width="300">
            <template #default="{ row }">
              <span v-if="isTerminal(row.state)" class="cc-terminal">
                {{ t("cc.tasksTerminal") }}
              </span>
              <template v-else>
                <el-button
                  v-if="row.state === 'PAUSED'"
                  size="small"
                  @click="store.controlTask(row.taskId, 'resume')"
                >
                  {{ t("cc.tasksResume") }}
                </el-button>
                <el-button
                  v-else
                  size="small"
                  :disabled="row.state === 'PAUSE_REQUESTED'"
                  @click="store.controlTask(row.taskId, 'pause')"
                >
                  {{ t("cc.tasksPause") }}
                </el-button>
                <el-button size="small" @click="store.controlTask(row.taskId, 'cancel')">
                  {{ t("cc.tasksCancel") }}
                </el-button>
                <el-button
                  type="danger"
                  size="small"
                  @click="store.controlTask(row.taskId, 'emergency-stop')"
                >
                  {{ t("cc.tasksStop") }}
                </el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from "vue";
import { locale, t } from "@/i18n";
import { useCompanyClawStore } from "@/stores/companyclaw";

const store = useCompanyClawStore();
const ttlMinutes = ref(60);
const newProcess = ref("");

/** Adds one executable base name to the allow list. */
async function addProcess(): Promise<void> {
  const candidate = newProcess.value.trim();
  if (!candidate) return;
  const next = [...new Set([...store.brokerTargets.allowedProcesses, candidate.toLowerCase().replace(/\.exe$/i, "")])];
  newProcess.value = "";
  await store.setBrokerTargets({
    allowedProcesses: next,
    allowedWindowTitles: store.brokerTargets.allowedWindowTitles,
  });
}

async function removeProcess(name: string): Promise<void> {
  await store.setBrokerTargets({
    allowedProcesses: store.brokerTargets.allowedProcesses.filter((entry) => entry !== name),
    allowedWindowTitles: store.brokerTargets.allowedWindowTitles,
  });
}

const TERMINAL_STATES = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "EXPIRED"]);

function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

function stateLabel(state: string): string {
  const key = `cc.state.${state}`;
  const label = t(key);
  return label === key ? state : label;
}

function stateTagType(state: string): "success" | "warning" | "danger" | "info" | "primary" {
  if (state === "COMPLETED") return "success";
  if (state === "FAILED" || state === "CANCELLED") return "danger";
  if (state === "PARTIAL" || state === "EXPIRED") return "warning";
  if (state === "AWAITING_APPROVAL" || state === "PAUSED" || state === "PAUSE_REQUESTED") {
    return "warning";
  }
  if (state === "RUNNING" || state === "VERIFYING") return "primary";
  return "info";
}

const remoteStateLabel = computed(() => {
  switch (store.authorization?.state) {
    case "enabled":
      return t("cc.remoteStateEnabled");
    case "expired":
      return t("cc.remoteStateExpired");
    case "revoked":
      return t("cc.remoteStateRevoked");
    default:
      return t("cc.remoteStateDisabled");
  }
});

const remoteTagType = computed<"success" | "warning" | "danger" | "info">(() => {
  switch (store.authorization?.state) {
    case "enabled":
      return "success";
    case "expired":
      return "warning";
    case "revoked":
      return "danger";
    default:
      return "info";
  }
});

const formattedExpiry = computed(() => {
  const expiresAt = store.authorization?.expiresAt;
  return expiresAt ? formatTime(expiresAt) : "—";
});

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString(locale.value ?? undefined);
}

onMounted(() => {
  void store.refresh();
});

onActivated(() => {
  void store.refresh();
});
</script>

<style scoped>
.cc-task-centre {
  height: 100%;
  overflow-y: auto;
  padding: 24px 32px;
}

.view-header {
  margin-bottom: 20px;
}

.view-header h2 {
  font-size: 20px;
  font-weight: 600;
}

.view-desc {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 4px 0 8px;
}

.cc-alert {
  margin-bottom: 16px;
}

.cc-card {
  border: 1px solid var(--border-color, #e5e5ea);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 16px;
  background: var(--bg-secondary, #fafafa);
}

.cc-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.cc-card-title {
  font-size: 15px;
  font-weight: 600;
}

.cc-card-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
  max-width: 620px;
  line-height: 1.5;
}

.cc-card-desc--inset {
  margin-bottom: 12px;
}

.cc-card-body {
  margin-top: 12px;
}

.cc-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.cc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

.cc-label {
  color: var(--text-secondary);
  font-size: 12px;
  min-width: 84px;
  display: inline-block;
}

.cc-value {
  font-size: 13px;
}

.cc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.cc-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.cc-empty-desc {
  margin-top: 6px;
  font-size: 12px;
}

.cc-alert-inline {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 10px;
}

.cc-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.cc-approval {
  border: 1px solid var(--border-color, #e5e5ea);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
  background: var(--bg-primary, #fff);
}

.cc-approval-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
}

.cc-approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.cc-objective {
  font-size: 13px;
  word-break: break-word;
}

.cc-terminal {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
