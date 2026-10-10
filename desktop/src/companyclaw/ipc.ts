import * as fs from "node:fs";
import * as path from "node:path";
import { ipcMain } from "electron";
import { BrokerClient, type BrokerClientStatus } from "./broker-client";
import {
  buildCapabilityProbeRequest,
  interpretCapabilityProbe,
  summarizeCapabilities,
} from "./model/capability-probe";
import { resolveBrokerScriptDir } from "./broker-paths";
import { buildGuardianReport, type GuardianReport } from "./guardian";
import { CompanyClawRuntime, type RuntimePaths } from "./runtime";
import { isPermissionPreset } from "./policy/permission-preset";
import { AGENT_TOOLS } from "./tools/computer-use-tools";

/**
 * Wires the CompanyClaw security core to the renderer.
 *
 * This module owns registration only: every authorization decision stays inside
 * `CompanyClawRuntime`, so widening access still requires changing the core
 * rather than a handler. It never touches AppContainer, MXC or the host's
 * security configuration.
 */

interface CompanyClawIpcOptions {
  userDataDir: string;
  /** Stable per-install secret used to sign approval tickets. */
  ticketSecret: string;
  /** Current Windows user SID; approval ownership is scoped to it. */
  ownerSid: string;
  deviceId: string;
  /**
   * Broker location. Omitted in tests that do not exercise execution; when
   * present the runtime can spawn the broker on first use.
   */
  broker?: { brokerDir: string };
  /**
   * Private Node runtime used to launch the broker. In a packaged build
   * `process.execPath` is CompanyClaw.exe and cannot run the broker entry.
   */
  nodePath?: string;
  /** Chat bound to this installation's owner; artifact sends target it. */
  boundChannelUserId?: string;
  /**
   * Records the model probe verdict so the health report can reflect it; the
   * probe itself is stateless and returns its result to the renderer.
   */
  recordModelCapability?: (verdict: string) => void;
  /** Sends an approval card to the owner; owned by main.ts for the same reason. */
  notifyApprovals?: (message: string) => Promise<void>;
  /** Sends a validated artifact; owned by main.ts so it can reach the plugin. */
  artifactDelivery?: {
    deliver(input: {
      taskId: string;
      ownerSid: string;
      filePath: string;
      boundChannelUserId: string;
      targetChannelUserId: string;
    }): Promise<unknown>;
  };
}

/** Handle returned to `main.ts` so it can stop the broker on quit. */
export interface CompanyClawRuntimeHandle {
  runtime: CompanyClawRuntime;
  broker: { stop(): Promise<void>; getStatus(): BrokerClientStatus } | null;
}

export const COMPANYCLAW_TICKET_SECRET_FILE = "companyclaw-ticket-secret";

export function resolveCompanyClawPaths(userDataDir: string): RuntimePaths {
  const root = path.join(userDataDir, "companyclaw");
  return {
    tasksFile: path.join(root, "tasks.json"),
    approvalsFile: path.join(root, "approvals.json"),
    artifactsRoot: root,
    identityFile: path.join(root, "identity-binding.json"),
    brokerTargetsFile: path.join(root, "broker-targets.json"),
    permissionsFile: path.join(root, "permissions.json"),
    auditFile: path.join(root, "audit.jsonl"),
  };
}

/**
 * Reads (or creates) the per-install signing secret with owner-only
 * permissions. The value never leaves the main process.
 */
export function loadOrCreateTicketSecret(userDataDir: string, createSecret: () => string): string {
  const filePath = path.join(userDataDir, "companyclaw", COMPANYCLAW_TICKET_SECRET_FILE);
  try {
    const existing = fs.readFileSync(filePath, "utf-8").trim();
    if (existing) return existing;
  } catch {
    // fall through to creation
  }
  const secret = createSecret();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${secret}\n`, { encoding: "utf-8", mode: 0o600 });
  return secret;
}

export function createCompanyClawRuntime(options: CompanyClawIpcOptions): CompanyClawRuntimeHandle {
  const paths = resolveCompanyClawPaths(options.userDataDir);
  fs.mkdirSync(path.dirname(paths.tasksFile), { recursive: true, mode: 0o700 });
  const broker = options.broker
    ? new BrokerClient({
        brokerDir: options.broker.brokerDir,
        scriptDir: resolveBrokerScriptDir(options.broker.brokerDir),
        ...(options.nodePath ? { nodePath: options.nodePath } : {}),
        ownerSid: options.ownerSid,
        deviceId: options.deviceId,
        ticketSecret: options.ticketSecret,
        allowedProcesses: [],
        allowedWindowTitles: [],
      })
    : null;
  const runtime = new CompanyClawRuntime({
    paths,
    ownerSid: options.ownerSid,
    ticketSecret: options.ticketSecret,
    existsFile: (filePath) => fs.existsSync(filePath),
    readFile: (filePath) => fs.readFileSync(filePath, "utf-8"),
    writeFile: async (filePath, contents) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, contents, { encoding: "utf-8", mode: 0o600 });
      await fs.promises.rename(temporary, filePath);
    },
    // One JSON line per decision, appended; a partial last line is the expected
    // shape of a crash and does not invalidate the entries before it.
    appendAudit: async (filePath, line) => {
      await fs.promises.appendFile(filePath, line, { encoding: "utf-8", mode: 0o600 });
    },
    // An unusable permission file is preserved beside itself instead of being
    // overwritten: the employee may need to see what was there.
    backupFile: (filePath, stamp) => {
      const target = `${filePath}.corrupt.${stamp}.bak`;
      try {
        fs.copyFileSync(filePath, target);
      } catch {
        // Nothing to preserve if the file cannot be copied.
      }
      return target;
    },
  });
  if (broker) {
    // The allow list lives in the runtime; hand the broker its current value and
    // let later changes restart it with the new list.
    void runtime.setBrokerTargetsApplier(async (targets) => {
      await broker.updateTargets(targets);
    });
    const current = runtime.getBrokerTargets();
    broker.updateTargets(current).catch(() => undefined);
  }
  return { runtime, broker };
}

export function registerCompanyClawIpcHandlers(
  runtime: CompanyClawRuntime,
  options: CompanyClawIpcOptions,
  broker?: { getStatus(): BrokerClientStatus } | null,
  healthReport: () => GuardianReport = () => buildGuardianReport({}),
): void {
  const artifactDelivery = options.artifactDelivery ?? null;
  const notifyApprovals = options.notifyApprovals ?? null;
  const recordModelCapability = options.recordModelCapability ?? null;
  // Without a broker the honest answer is "not running", never "fine".
  const brokerStatus = (): BrokerClientStatus =>
    broker?.getStatus() ?? {
      running: false,
      nodePath: options.nodePath ?? null,
      lastSuccessfulCallAt: null,
      lastFailureReason: null,
      restarts: 0,
    };

  ipcMain.handle("companyclaw:get-remote-authorization", () => runtime.getRemoteAuthorization());

  ipcMain.handle(
    "companyclaw:set-remote-authorization",
    (
      _event,
      input: {
        enabled: boolean;
        ttlMinutes?: number;
        channelUserId?: string;
      },
    ) => {
      // The renderer cannot choose its own ownership: the main process supplies
      // the SID, the device and the paired channel user the grant is bound to.
      const channelUserId =
        input?.channelUserId || runtime.getIdentityBinding()?.channelUserId || "";
      if (input?.enabled === true && !channelUserId) {
        throw new Error("微信身份未绑定：请先在「微信连接」完成扫码登录，再开启远程操作。");
      }
      return runtime.setRemoteAuthorization({
        enabled: input?.enabled === true,
        ownerSid: options.ownerSid,
        deviceId: options.deviceId,
        channelUserId,
        ttlMinutes: input?.ttlMinutes,
      });
    },
  );

  ipcMain.handle("companyclaw:tasks:list", (_event, input?: { state?: string }) =>
    runtime.listTasks({
      ownerSid: options.ownerSid,
      state: input?.state as never,
    }),
  );

  ipcMain.handle("companyclaw:tasks:get", (_event, input: { taskId: string }) =>
    runtime.getTask(input?.taskId ?? "", options.ownerSid),
  );

  ipcMain.handle(
    "companyclaw:tasks:control",
    (
      _event,
      input: {
        taskId: string;
        control: "pause" | "resume" | "cancel" | "emergency-stop";
        reason?: string;
      },
    ) =>
      runtime.controlTask({
        taskId: input?.taskId ?? "",
        ownerSid: options.ownerSid,
        control: input?.control,
        reason: input?.reason,
      }),
  );

  ipcMain.handle("companyclaw:approvals:list-pending", () =>
    runtime.listPendingApprovals(options.ownerSid),
  );

  // Model capability probe. The API key is supplied per call and never stored
  // here; only the verdict is returned.
  ipcMain.handle(
    "companyclaw:model:probe-capabilities",
    async (
      _event,
      input: {
        baseUrl: string;
        model: string;
        apiFormat: "openai-chat" | "openai-responses" | "anthropic";
        apiKey: string;
      },
    ) => {
      const request = buildCapabilityProbeRequest({
        baseUrl: input?.baseUrl ?? "",
        model: input?.model ?? "",
        apiFormat: input?.apiFormat ?? "openai-chat",
      });
      try {
        const response = await fetch(request.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(input?.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
          },
          body: request.body,
        });
        const body = await response.text();
        const capabilities = interpretCapabilityProbe({ status: response.status, body });
        recordModelCapability?.(capabilities.toolCalls);
        return { capabilities, summary: summarizeCapabilities(capabilities) };
      } catch (error) {
        // A transport failure tells us nothing about the model.
        const capabilities = interpretCapabilityProbe({ status: 0, body: "" });
        // A transport failure says nothing about the model, so the verdict is
        // recorded as unknown rather than as unsupported.
        recordModelCapability?.(capabilities.toolCalls);
        return {
          capabilities: {
            ...capabilities,
            error: "network-error",
            errorDetail: error instanceof Error ? error.message : String(error),
          },
          summary: summarizeCapabilities({
            ...capabilities,
            error: "network-error",
            errorDetail: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    },
  );

  ipcMain.handle("companyclaw:broker:get-targets", () => runtime.getBrokerTargets());

  // Liveness is not the same as controllability: the desktop needs to tell the
  // user whether UI Automation actually worked last time.
  ipcMain.handle("companyclaw:broker:get-status", () => brokerStatus());

  ipcMain.handle(
    "companyclaw:broker:set-targets",
    (_event, input: { allowedProcesses?: string[]; allowedWindowTitles?: string[] }) =>
      runtime.setBrokerTargets({
        allowedProcesses: Array.isArray(input?.allowedProcesses) ? input.allowedProcesses : [],
        allowedWindowTitles: Array.isArray(input?.allowedWindowTitles)
          ? input.allowedWindowTitles
          : [],
      }),
  );

  ipcMain.handle("companyclaw:browser:get-policy", () => runtime.describeBrowserPolicy());

  ipcMain.handle(
    "companyclaw:browser:set-policy",
    (
      _event,
      input: { allowedDomains?: string[]; allowDownloads?: boolean; allowUploads?: boolean },
    ) => {
      runtime.configureBrowser({
        allowedDomains: Array.isArray(input?.allowedDomains) ? input.allowedDomains : [],
        allowDownloads: input?.allowDownloads === true,
        allowUploads: input?.allowUploads === true,
      });
      return runtime.describeBrowserPolicy();
    },
  );

  // ── Permission policy ────────────────────────────────────────────────

  ipcMain.handle("companyclaw:permission:get-policy", () => {
    const policy = runtime.getPermissionPolicy();
    return {
      preset: policy.preset,
      policyVersion: policy.policyVersion,
      presetChangedAt: policy.presetChangedAt,
      remote: policy.remote,
      vision: policy.vision,
      warning: runtime.getPermissionWarning(),
      counts: {
        trustedApps: policy.trustedApps.length,
        trustedSites: policy.trustedSites.length,
        workFolders: policy.workFolders.length,
        taskGrants: policy.taskGrants.length,
      },
    };
  });

  ipcMain.handle(
    "companyclaw:permission:set-preset",
    (_event, input: { preset?: string; acknowledged?: boolean }) => {
      if (!isPermissionPreset(input?.preset)) {
        throw new Error("无效的权限档位");
      }
      // The renderer cannot enable the daily preset without the explicit
      // acknowledgement the UI collects; the core re-asserts it here so a
      // forgotten dialog cannot silently widen access.
      return runtime.setPreset({
        preset: input.preset,
        acknowledged: input?.acknowledged === true,
      });
    },
  );

  ipcMain.handle("companyclaw:permission:list-trusted-apps", () =>
    runtime.getPermissionPolicy().trustedApps,
  );

  ipcMain.handle("companyclaw:permission:trust-app", (_event, input: {
    processName?: string;
    displayName?: string;
    scope?: string;
  }) =>
    runtime.trustApp({
      processName: input?.processName ?? "",
      ...(input?.displayName ? { displayName: input.displayName } : {}),
      scope: input?.scope === "remote" || input?.scope === "both" ? input.scope : "local",
    }),
  );

  ipcMain.handle("companyclaw:permission:revoke-trusted-app", (_event, input: { processName?: string }) =>
    runtime.revokeTrustedApp(input?.processName ?? ""),
  );

  ipcMain.handle("companyclaw:permission:list-trusted-sites", () => runtime.listEffectiveTrustedSites());

  ipcMain.handle("companyclaw:permission:trust-current-site", (_event, input: { domain?: string }) =>
    runtime.trustSite({ domain: input?.domain ?? "" }),
  );

  ipcMain.handle("companyclaw:permission:revoke-trusted-site", (_event, input: { domain?: string }) =>
    runtime.revokeTrustedSite(input?.domain ?? ""),
  );

  ipcMain.handle("companyclaw:permission:list-task-grants", () =>
    runtime.listTaskGrants(options.ownerSid),
  );

  ipcMain.handle("companyclaw:permission:revoke-task-grant", (_event, input: { taskId?: string }) =>
    runtime.revokeTaskGrant(input?.taskId ?? ""),
  );

  // ── Cloud vision authorization ────────────────────────────────────────

  ipcMain.handle("companyclaw:vision:get", () => runtime.getPermissionPolicy().vision);

  ipcMain.handle(
    "companyclaw:vision:set",
    (
      _event,
      input: {
        origin?: string;
        provider?: string;
        baseUrl?: string;
        model?: string;
        captureScope?: string;
        ttlMinutes?: number;
      },
    ) =>
      runtime.authorizeVision({
        origin: input?.origin === "remote" ? "remote" : "local",
        provider: input?.provider ?? "",
        baseUrl: input?.baseUrl ?? "",
        model: input?.model ?? "",
        ...(input?.captureScope ? { captureScope: input.captureScope } : {}),
        ...(typeof input?.ttlMinutes === "number" ? { ttlMs: input.ttlMinutes * 60_000 } : {}),
      }),
  );

  ipcMain.handle("companyclaw:vision:revoke", (_event, input: { origin?: string }) =>
    runtime.revokeVision(input?.origin === "remote" ? "remote" : "local"),
  );

  // ── Restore safe defaults ────────────────────────────────────────────

  ipcMain.handle("companyclaw:recovery:preview", () => runtime.previewSafeDefaultsReset());

  ipcMain.handle("companyclaw:recovery:apply", (_event, input: { token?: string }) =>
    runtime.restoreSafeDefaults({ token: input?.token ?? "" }),
  );

  // ── Audit and tool surface ───────────────────────────────────────────

  ipcMain.handle(
    "companyclaw:audit:query",
    async (
      _event,
      input?: { taskId?: string; decision?: string; from?: string; to?: string; limit?: number },
    ) =>
      await runtime.listAuditEntries({
        ...(input?.taskId ? { taskId: input.taskId } : {}),
        ...(input?.decision ? { decision: input.decision as never } : {}),
        ...(input?.from ? { from: input.from } : {}),
        ...(input?.to ? { to: input.to } : {}),
        limit: typeof input?.limit === "number" ? Math.min(Math.max(input.limit, 1), 500) : 200,
      }),
  );

  ipcMain.handle("companyclaw:tools:list", () =>
    AGENT_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      capability: tool.capability,
      mutating: tool.mutating,
    })),
  );

  ipcMain.handle("companyclaw:identity:get", () => runtime.getIdentityBinding());

  ipcMain.handle(
    "companyclaw:identity:bind",
    (_event, input: { channelType: string; channelUserId: string }) =>
      runtime.bindIdentity({
        channelType: input?.channelType ?? "",
        channelUserId: input?.channelUserId ?? "",
        deviceId: options.deviceId,
      }),
  );

  ipcMain.handle("companyclaw:identity:unbind", () => runtime.unbindIdentity());

  // Health is reported per component rather than as one flag: the wizard has to
  // tell the user which part of the installation is at fault.
  ipcMain.handle("companyclaw:health:report", () => healthReport());

  ipcMain.handle("companyclaw:artifacts:resolve", (_event, input: { taskId: string }) =>
    runtime.resolveArtifactDir({
      taskId: input?.taskId ?? "",
      ownerSid: options.ownerSid,
    }),
  );

  // Delivers a produced artifact to the owner's bound chat. The owner comes
  // from the main-process options, never from the renderer, and the recipient
  // is checked against the task's own binding inside ArtifactDelivery.
  ipcMain.handle(
    "companyclaw:artifacts:deliver",
    async (_event, input: { taskId: string; filePath: string }) => {
      if (!artifactDelivery) return { outcome: "failed", reason: "delivery-unavailable" };
      return await artifactDelivery.deliver({
        taskId: input?.taskId ?? "",
        ownerSid: options.ownerSid,
        filePath: input?.filePath ?? "",
        boundChannelUserId: options.boundChannelUserId ?? "",
        targetChannelUserId: options.boundChannelUserId ?? "",
      });
    },
  );

  // Sends the pending-approval card to the owner's bound chat. The card text is
  // built by the security core, so what the owner reads is exactly the change
  // the approval describes.
  ipcMain.handle("companyclaw:approvals:notify", async () => {
    if (!notifyApprovals) return { sent: false, reason: "notify-unavailable" };
    const message = runtime.buildApprovalMessage(options.ownerSid);
    if (!message) return { sent: false, reason: "nothing-pending" };
    await notifyApprovals(message);
    return { sent: true };
  });

  ipcMain.handle(
    "companyclaw:approvals:resolve",
    (_event, input: { approvalId: string; decision: "approved" | "denied" }) =>
      runtime.resolveApproval({
        approvalId: input?.approvalId ?? "",
        decision: input?.decision,
        resolvedBy: options.ownerSid,
      }),
  );
}
