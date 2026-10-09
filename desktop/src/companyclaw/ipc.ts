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
import { CompanyClawRuntime, type RuntimePaths } from "./runtime";

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

export function createCompanyClawRuntime(
  options: CompanyClawIpcOptions,
): CompanyClawRuntimeHandle {
  const paths = resolveCompanyClawPaths(options.userDataDir);
  fs.mkdirSync(path.dirname(paths.tasksFile), { recursive: true, mode: 0o700 });
  const broker = options.broker
    ? new BrokerClient({
        brokerDir: options.broker.brokerDir,
        scriptDir: resolveBrokerScriptDir(options.broker.brokerDir),
        ...(options.nodePath ? { nodePath: options.nodePath } : {}),
        ownerSid: options.ownerSid,
        deviceId: options.deviceId,
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
): void {
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
      // the SID and device the grant is bound to.
      return runtime.setRemoteAuthorization({
        enabled: input?.enabled === true,
        ownerSid: options.ownerSid,
        deviceId: options.deviceId,
        channelUserId: input?.channelUserId ?? "",
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
      input: { taskId: string; control: "pause" | "resume" | "cancel" | "emergency-stop"; reason?: string },
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
        return { capabilities, summary: summarizeCapabilities(capabilities) };
      } catch (error) {
        // A transport failure tells us nothing about the model.
        const capabilities = interpretCapabilityProbe({ status: 0, body: "" });
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

  ipcMain.handle(
    "companyclaw:artifacts:resolve",
    (_event, input: { taskId: string }) =>
      runtime.resolveArtifactDir({
        taskId: input?.taskId ?? "",
        ownerSid: options.ownerSid,
      }),
  );

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
