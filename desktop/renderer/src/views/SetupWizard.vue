<template>
  <div class="setup-overlay">
    <div class="setup-drag-region"></div>
    <div class="setup-content">
      <div class="setup-icon" aria-hidden="true">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="#F59E0B" />
        </svg>
      </div>
      <h2 class="setup-step-title">{{ t("setup.step1Title") }}</h2>
      <p class="setup-desc">{{ t("setup.step1Desc") }}</p>

      <div v-if="healthUnavailable" class="setup-health-unavailable">
        {{ t("setup.step1Unavailable") }}
      </div>
      <div v-else class="setup-health">
        <div v-if="healthChecking" class="setup-health-checking">
          {{ t("setup.step1Checking") }}
        </div>
        <template v-else-if="healthReport">
          <div class="setup-health-headline" :class="`state-${healthReport.overall}`">
            {{
              healthReport.overall === "ok"
                ? t("setup.step1Ready")
                : t(`setup.state.${healthReport.overall}`)
            }}
          </div>
          <ul class="setup-health-items">
            <li v-for="entry in healthReport.items" :key="entry.id">
              <span class="setup-health-tag" :class="`state-${entry.state}`">
                {{ t(`setup.state.${entry.state}`) }}
              </span>
              <span class="setup-health-detail">{{ entry.detail }}</span>
            </li>
          </ul>
        </template>
        <el-button size="small" :loading="healthChecking" @click="refreshEnvironment">
          {{ t("setup.step1Recheck") }}
        </el-button>
      </div>

      <h2 class="setup-step-title">{{ t("setup.step2Title") }}</h2>
      <p class="setup-desc">{{ t("setup.aiDesc") }}</p>

      <el-form label-position="top" class="setup-form">
        <el-form-item :label="t('setup.apiFormat')">
          <el-select v-model="form.apiFormat" style="width: 100%">
            <el-option
              v-for="option in apiFormatOptions"
              :key="option.value"
              :label="t(option.labelKey)"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="Base URL">
          <el-input v-model="form.baseUrl" placeholder="https://api.openai.com/v1" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" type="password" show-password placeholder="sk-..." />
        </el-form-item>
        <el-form-item :label="t('setup.modelName')">
          <el-input v-model="form.modelName" placeholder="gpt-4o" />
        </el-form-item>
        <el-form-item :label="t('setup.reasoningEffort')">
          <el-select v-model="form.reasoningEffort" style="width: 100%">
            <el-option
              v-for="option in reasoningEffortOptions"
              :key="option.value"
              :label="t(option.labelKey)"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
      </el-form>

      <div v-if="probeSummary" class="probe-result">
        <div class="probe-title">{{ t("setup.probeTitle") }}</div>
        <pre class="probe-summary">{{ probeSummary }}</pre>
        <div class="probe-hint">{{ t("setup.probeHint") }}</div>
      </div>

      <el-button
        type="primary"
        size="large"
        class="save-btn"
        :loading="saving"
        :disabled="probing"
        @click="saveAndFinish"
      >
        {{ probing ? t("setup.probeRunning") : t("setup.finishAndEnter") }}
      </el-button>

      <h2 class="setup-step-title">{{ t("setup.step3Title") }}</h2>
      <div class="bind-weixin">
        <el-button link type="primary" @click="goToWeixinBinding">
          {{ t("setup.bindWeixin") }}
        </el-button>
        <span class="bind-weixin-hint">{{ t("setup.bindWeixinHint") }}</span>
      </div>

      <h2 class="setup-step-title">{{ t("setup.step4Title") }}</h2>
      <p class="setup-desc">{{ t("setup.step4Desc") }}</p>
      <div class="setup-remote">
        <div class="setup-remote-state">
          {{ remoteEnabled ? t("setup.step4Enabled") : t("setup.step4DefaultOff") }}
        </div>
        <el-form-item :label="t('setup.step4Ttl')" class="setup-remote-ttl">
          <el-input-number v-model="remoteTtlMinutes" :min="1" :max="10080" size="small" />
        </el-form-item>
        <el-button
          v-if="!remoteEnabled"
          type="primary"
          :disabled="!weixinBound"
          :loading="remoteBusy"
          @click="enableRemote"
        >
          {{ t("setup.step4Enable") }}
        </el-button>
        <el-button v-else :loading="remoteBusy" @click="disableRemote">
          {{ t("setup.step4Disable") }}
        </el-button>
        <div v-if="!weixinBound" class="setup-remote-hint">
          {{ t("setup.step4NeedWeixin") }}
        </div>
        <div v-if="remoteError" class="error-msg">{{ remoteError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { t } from "@/i18n";
import { useCompanyClawStore, type GuardianReportView } from "@/stores/companyclaw";

const router = useRouter();
const companyClaw = useCompanyClawStore();

/**
 * Step 1: the local runtime report, straight from the main process.
 *
 * `healthUnavailable` is a distinct state from a failing report: a missing
 * bridge means "cannot check", never "everything is fine".
 */
const healthReport = ref<GuardianReportView | null>(null);
const healthChecking = ref(false);
const healthUnavailable = ref(false);

async function refreshEnvironment(): Promise<void> {
  healthChecking.value = true;
  try {
    const report = await companyClaw.refreshHealth();
    healthUnavailable.value = report === null;
    healthReport.value = report;
  } finally {
    healthChecking.value = false;
  }
}

/** Step 4: remote operation, off until the owner turns it on. */
const remoteEnabled = ref(false);
const remoteBusy = ref(false);
const remoteError = ref("");
const remoteTtlMinutes = ref(60);
/** Whether this machine already has a bound WeChat identity. */
const weixinBound = ref(false);

async function refreshRemoteState(): Promise<void> {
  try {
    const authorization = await companyClawBridge()?.getRemoteAuthorization();
    remoteEnabled.value = authorization?.state === "enabled";
  } catch {
    remoteEnabled.value = false;
  }
  try {
    const status = await window.openclaw.plugin.weixin.getStatus();
    weixinBound.value = status?.loggedIn === true;
  } catch {
    weixinBound.value = false;
  }
}

/** The CompanyClaw namespace exists only when the desktop bridge did load. */
function companyClawBridge():
  | {
      getRemoteAuthorization: () => Promise<{ state: string }>;
    }
  | undefined {
  return (
    window as unknown as {
      openclaw?: { companyClaw?: { getRemoteAuthorization: () => Promise<{ state: string }> } };
    }
  ).openclaw?.companyClaw;
}

async function enableRemote(): Promise<void> {
  remoteBusy.value = true;
  remoteError.value = "";
  try {
    await companyClaw.enableRemoteOperation({ ttlMinutes: remoteTtlMinutes.value });
    remoteEnabled.value = companyClaw.remoteEnabled;
  } catch (error) {
    remoteError.value = error instanceof Error ? error.message : String(error);
  } finally {
    remoteBusy.value = false;
  }
}

async function disableRemote(): Promise<void> {
  remoteBusy.value = true;
  remoteError.value = "";
  try {
    await companyClaw.revokeRemoteOperation();
    remoteEnabled.value = false;
  } catch (error) {
    remoteError.value = error instanceof Error ? error.message : String(error);
  } finally {
    remoteBusy.value = false;
  }
}
const saving = ref(false);
const errorMsg = ref("");
/** Real capability measurement result; empty until a probe has run. */
const probeSummary = ref("");
const probing = ref(false);

type ApiFormat = "openai-chat" | "openai-responses" | "anthropic";
type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

const apiFormatOptions: Array<{ value: ApiFormat; labelKey: string }> = [
  { value: "openai-chat", labelKey: "setup.apiFormatOpenAIChat" },
  { value: "openai-responses", labelKey: "setup.apiFormatOpenAIResponses" },
  { value: "anthropic", labelKey: "setup.apiFormatAnthropic" },
];

const reasoningEffortOptions: Array<{ value: ReasoningEffort; labelKey: string }> = [
  { value: "off", labelKey: "setup.reasoningOff" },
  { value: "minimal", labelKey: "setup.reasoningMinimal" },
  { value: "low", labelKey: "setup.reasoningLow" },
  { value: "medium", labelKey: "setup.reasoningMedium" },
  { value: "high", labelKey: "setup.reasoningHigh" },
  { value: "xhigh", labelKey: "setup.reasoningXHigh" },
  { value: "adaptive", labelKey: "setup.reasoningAdaptive" },
];

function normalizeApiFormat(value: unknown): ApiFormat {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "anthropic" || normalized === "anthropic-messages") return "anthropic";
  if (normalized === "openai-responses" || normalized === "responses" || normalized === "response")
    return "openai-responses";
  return "openai-chat";
}

function normalizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = "off",
): ReasoningEffort {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "adaptive"
  ) {
    return normalized;
  }
  return fallback;
}

function resolveApiValue(apiFormat: ApiFormat): string {
  if (apiFormat === "anthropic") return "anthropic-messages";
  if (apiFormat === "openai-responses") return "openai-responses";
  return "openai-completions";
}

function resolveProviderId(apiFormat: ApiFormat): string {
  return apiFormat === "anthropic" ? "anthropic" : "custom";
}

function ensureReasoningPreset(): void {
  if (form.apiFormat === "openai-responses" && form.reasoningEffort === "off") {
    form.reasoningEffort = "low";
  }
}

const form = reactive({
  apiFormat: "openai-chat" as ApiFormat,
  apiKey: "",
  baseUrl: "",
  modelName: "",
  reasoningEffort: "off" as ReasoningEffort,
});

watch(
  () => form.apiFormat,
  () => ensureReasoningPreset(),
);

onMounted(async () => {
  // Step 1 and step 4 both read real state; neither blocks the wizard, so a
  // failure leaves the step showing "cannot check" rather than a blank page.
  void refreshEnvironment();
  void refreshRemoteState();
  // Guard: if setup isn't needed, redirect away immediately
  try {
    const needs = await window.openclaw.config.needsSetup();
    if (!needs) {
      router.replace("/chat");
      return;
    }
  } catch {}

  // Pre-fill from .env if values exist
  try {
    const env = await window.openclaw.config.readEnv();
    if (env) {
      const envApiFormat = env.OPENCLAW_MODEL_API_FORMAT || env.MODEL_API_FORMAT;
      const envReasoning =
        env.OPENCLAW_MODEL_REASONING_EFFORT ||
        env.MODEL_REASONING_EFFORT ||
        env.OPENCLAW_MODEL_THINKING ||
        env.MODEL_THINKING;
      if (envApiFormat) form.apiFormat = normalizeApiFormat(envApiFormat);
      if (env.MODEL_BASE_URL) form.baseUrl = env.MODEL_BASE_URL;
      if (env.OPENCLAW_MODEL_API_KEY || env.MODEL_API_KEY)
        form.apiKey = env.OPENCLAW_MODEL_API_KEY || env.MODEL_API_KEY;
      if (env.MODEL_NAME) form.modelName = env.MODEL_NAME;
      if (envReasoning) form.reasoningEffort = normalizeReasoningEffort(envReasoning);
    }
  } catch {}
  // Also try reading existing openclaw.json config
  try {
    const config = await window.openclaw.config.read();
    if (config?.models?.providers) {
      const providers = config.models.providers;
      const modelDefaults = config.agents?.defaults?.models ?? {};
      for (const key of Object.keys(providers)) {
        const p = providers[key];
        if (p.apiKey && !form.apiKey) form.apiKey = p.apiKey;
        if (p.baseUrl && !form.baseUrl) form.baseUrl = p.baseUrl;
        const modelId = p.models?.[0]?.id;
        const apiFormat = normalizeApiFormat(p.api);
        const modelRef = modelId ? `${key}/${modelId}` : undefined;
        const reasoningFallback =
          p.models?.[0]?.reasoning === true || apiFormat === "openai-responses" ? "low" : "off";
        form.apiFormat = apiFormat;
        if (modelId && !form.modelName) form.modelName = modelId;
        if (modelRef) {
          form.reasoningEffort = normalizeReasoningEffort(
            modelDefaults[modelRef]?.params?.thinking,
            reasoningFallback,
          );
        }
        break;
      }
    }
  } catch {}
});

/**
 * Opens the existing WeChat channel page, which already owns the QR login flow
 * (plugin:weixin:login-qr-start / -wait). Nothing is reimplemented here.
 */
function goToWeixinBinding(): void {
  router.push("/settings/channels");
}

/**
 * Measures what the configured model can actually do.
 *
 * The probe exercises a real tool call rather than only checking that the
 * endpoint answers. An unknown verdict is reported as not verified — never as
 * a capability the model has.
 */
async function runCapabilityProbe(input: {
  baseUrl: string;
  modelName: string;
}): Promise<void> {
  const bridge = (window as unknown as {
    openclaw?: {
      companyClaw?: {
        model?: {
          probeCapabilities: (params: {
            baseUrl: string;
            model: string;
            apiFormat: ApiFormat;
            apiKey: string;
          }) => Promise<{ summary: string }>;
        };
      };
    };
  }).openclaw?.companyClaw;
  if (!bridge?.model?.probeCapabilities) return;
  probing.value = true;
  probeSummary.value = "";
  try {
    const result = await bridge.model.probeCapabilities({
      baseUrl: input.baseUrl,
      model: input.modelName,
      apiFormat: form.apiFormat,
      apiKey: form.apiKey,
    });
    probeSummary.value = result.summary;
  } catch (error) {
    // A probe failure is information, not a blocker: the model may still work
    // for chat, but it must never be presented as verified.
    probeSummary.value = `${t("setup.probeFailed")}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    probing.value = false;
  }
}

async function saveAndFinish() {
  errorMsg.value = "";

  if (!form.apiKey.trim()) {
    errorMsg.value = t("setup.enterApiKey");
    return;
  }

  saving.value = true;
  try {
    // Read existing config and merge — don't overwrite installer settings
    const existing = (await window.openclaw.config.read()) || {};

    const apiMapping = resolveApiValue(form.apiFormat);
    const modelId =
      form.modelName.trim() || (form.apiFormat === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o");
    const providerId = resolveProviderId(form.apiFormat);
    const modelRef = `${providerId}/${modelId}`;
    const reasoningEffort = normalizeReasoningEffort(form.reasoningEffort);
    const reasoningEnabled = form.apiFormat === "openai-responses" || reasoningEffort !== "off";

    const providerEntry: Record<string, any> = {
      ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
      apiKey: form.apiKey.trim(),
      api: apiMapping,
      models: [
        {
          id: modelId,
          name: modelId,
          ...(reasoningEnabled ? { reasoning: true } : {}),
          ...(form.apiFormat !== "anthropic" ? { input: ["text", "image"] } : {}),
        },
      ],
    };

    // Merge model provider into existing config
    if (!existing.models) existing.models = { mode: "merge", providers: {} };
    if (!existing.models.providers) existing.models.providers = {};
    existing.models.providers[providerId] = providerEntry;

    // Set default model
    if (!existing.agents) existing.agents = { defaults: {} };
    if (!existing.agents.defaults) existing.agents.defaults = {};
    if (!existing.agents.defaults.model) existing.agents.defaults.model = {};
    existing.agents.defaults.model.primary = `${providerId}/${modelId}`;
    if (form.apiFormat === "openai-responses" || reasoningEffort !== "off") {
      if (!existing.agents.defaults.models) existing.agents.defaults.models = {};
      const existingModelConfig =
        typeof existing.agents.defaults.models[modelRef] === "object" &&
        existing.agents.defaults.models[modelRef]
          ? existing.agents.defaults.models[modelRef]
          : {};
      existing.agents.defaults.models[modelRef] = {
        ...existingModelConfig,
        params: {
          ...(existingModelConfig.params ?? {}),
          thinking: reasoningEffort,
        },
      };
    }

    // Ensure gateway config exists
    if (!existing.gateway) {
      // CSPRNG via Web Crypto — mirrors the installer's secrets.token_hex(24).
      // Math.random() is a deterministic PRNG and not safe for auth tokens.
      const token = crypto.randomUUID().replace(/-/g, "");
      existing.gateway = {
        port: 18789,
        bind: "loopback",
        mode: "local",
        auth: { mode: "token", token },
      };
    }

    await runCapabilityProbe({
      baseUrl: form.baseUrl.trim(),
      modelName: modelId,
    });
    await window.openclaw.config.write(existing);
    window.location.reload();
  } catch (err: any) {
    errorMsg.value = t("setup.saveFailed", { error: err.message || String(err) });
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.probe-result {
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}

.probe-title {
  font-weight: 600;
  margin-bottom: 6px;
}

.probe-summary {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: inherit;
}

.probe-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.bind-weixin {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* Step headings: the wizard shows four numbered steps in one panel. */
.setup-step-title {
  margin: 18px 0 4px;
  font-size: 15px;
}

.setup-step-title:first-of-type {
  margin-top: 4px;
}

.setup-health-unavailable {
  margin-top: 8px;
  font-size: 13px;
  color: var(--el-color-warning);
}

.setup-health-checking {
  margin-top: 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.setup-health-headline {
  margin-top: 8px;
  font-weight: 600;
}

.setup-health-headline.state-ok {
  color: var(--el-color-success);
}

.setup-health-headline.state-degraded {
  color: var(--el-color-warning);
}

.setup-health-headline.state-failed {
  color: var(--el-color-danger);
}

.setup-health-items {
  margin: 8px 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.setup-health-items li {
  display: flex;
  gap: 8px;
  padding: 2px 0;
}

.setup-health-tag {
  flex: 0 0 56px;
  color: var(--el-text-color-secondary);
}

.setup-health-tag.state-ok {
  color: var(--el-color-success);
}

.setup-health-tag.state-failed {
  color: var(--el-color-danger);
}

.setup-health-tag.state-degraded {
  color: var(--el-color-warning);
}

.setup-remote {
  margin-top: 8px;
}

.setup-remote-state {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.setup-remote-ttl {
  margin-bottom: 8px;
}

.setup-remote-hint {
  margin-top: 8px;
  font-size: 13px;
  color: var(--el-color-warning);
}

.bind-weixin-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.setup-overlay {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  overflow-y: auto;
  border-radius: 12px;
}

.setup-drag-region {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 36px;
  -webkit-app-region: drag;
}

.setup-content {
  width: 100%;
  max-width: 440px;
  padding: 36px 28px 28px;
  text-align: center;
}

.setup-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 18px;
  background: #18181b;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 16px rgba(24, 24, 27, 0.25);
}

.setup-content h2 {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 6px;
  letter-spacing: 0.2px;
}

.setup-desc {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 26px;
}

.setup-form {
  text-align: left;
}

.setup-form :deep(.el-form-item__label) {
  font-size: 13px;
  color: var(--text-secondary);
  padding-bottom: 6px;
  font-weight: 500;
}

.setup-form :deep(.el-input__wrapper),
.setup-form :deep(.el-select .el-select__wrapper) {
  border-radius: 12px;
  box-shadow: 0 0 0 1px var(--border) inset;
  padding: 4px 14px;
  min-height: 40px;
  background: var(--bg-secondary);
  transition: box-shadow 0.15s ease;
}

.setup-form :deep(.el-input__wrapper:hover),
.setup-form :deep(.el-select .el-select__wrapper:hover) {
  box-shadow: 0 0 0 1px var(--border-strong, #d0d3da) inset;
}

.setup-form :deep(.el-input.is-focus .el-input__wrapper),
.setup-form :deep(.el-input__wrapper.is-focus),
.setup-form :deep(.el-select .el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 2px #18181b inset;
}

.save-btn {
  width: 100%;
  margin-top: 16px;
  height: 48px;
  font-size: 15px;
  font-weight: 600;
  border-radius: 999px;
  background: #18181b;
  border-color: #18181b;
  color: #fff;
  letter-spacing: 0.3px;
}

.save-btn:hover,
.save-btn:focus {
  background: #27272a !important;
  border-color: #27272a !important;
  color: #fff !important;
}

.save-btn:active {
  background: #09090b !important;
  border-color: #09090b !important;
}

.error-msg {
  color: var(--danger, #f56c6c);
  font-size: 13px;
  margin-top: 8px;
}
</style>
