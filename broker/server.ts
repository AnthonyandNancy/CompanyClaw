import { createServer, type Server, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerPolicy, type BrokerPolicyConfig } from "./policy";
import {
  buildBrokerResponse,
  parseBrokerRequest,
  type BrokerRequest,
  type BrokerOutcome,
} from "./protocol";
import { runListWindows, type WindowDescriptor } from "./uia";

/**
 * Broker IPC server.
 *
 * Transport is a loopback-only TCP socket bound to 127.0.0.1 with a per-run
 * token. It never listens on a public interface, and every request is
 * re-authorized by BrokerPolicy before any UIA call happens. This is the
 * "narrowing proxy" the architecture decision requires: the agent reaches UIA
 * only through this gate.
 */

export const BROKER_DEFAULT_PORT = 0;

export interface BrokerServerOptions {
  policyConfig: BrokerPolicyConfig;
  /** Directory holding the PowerShell probe scripts. */
  scriptDir: string;
  /** Execution token; the client must present it or the connection is dropped. */
  token: string;
  now?: () => Date;
  verifyTicket?: (request: BrokerRequest) => boolean;
  listWindows?: (options: { scriptDir: string }) => Promise<
    { ok: true; value: WindowDescriptor[] } | { ok: false; reason: string }
  >;
}

export interface BrokerServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** One line in, one line out. Oversized input is rejected, not buffered. */
const MAX_FRAME_BYTES = 256 * 1024;

interface BrokerFrame {
  token?: string;
  request?: unknown;
}

export function resolveDefaultScriptDir(baseDir: string): string {
  return path.join(baseDir, "scripts");
}

export function defaultScriptDir(): string {
  // dist/main.js -> repo/broker/scripts
  return path.join(__dirname, "scripts");
}

export async function startBrokerServer(
  options: BrokerServerOptions,
): Promise<BrokerServerHandle> {
  const now = options.now ?? (() => new Date());
  const policy = new BrokerPolicy(options.policyConfig, {
    now,
    verifyTicket: options.verifyTicket,
  });
  const listWindows = options.listWindows ?? ((opts) => runListWindows({ scriptDir: opts.scriptDir }));

  const server: Server = createServer((socket) => {
    handleConnection(socket, {
      policy,
      scriptDir: options.scriptDir,
      token: options.token,
      now,
      listWindows,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only: never 0.0.0.0, and never a LAN-reachable interface.
    server.listen(BROKER_DEFAULT_PORT, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface ConnectionContext {
  policy: BrokerPolicy;
  scriptDir: string;
  token: string;
  now: () => Date;
  listWindows: (options: { scriptDir: string }) => Promise<
    { ok: true; value: WindowDescriptor[] } | { ok: false; reason: string }
  >;
}

function handleConnection(socket: Socket, context: ConnectionContext): void {
  let buffer = "";
  socket.setEncoding("utf8");

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      void respondToLine(socket, line, context);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  socket.on("error", () => {
    socket.destroy();
  });
}

async function respondToLine(
  socket: Socket,
  line: string,
  context: ConnectionContext,
): Promise<void> {
  const outcome = await handleLine(line, context);
  socket.write(`${JSON.stringify(outcome)}\n`);
}

async function handleLine(line: string, context: ConnectionContext): Promise<unknown> {
  let frame: BrokerFrame;
  try {
    frame = JSON.parse(line) as BrokerFrame;
  } catch {
    return buildBrokerResponse({
      requestId: "unknown",
      outcome: { status: "rejected", reason: "malformed-frame" },
      now: context.now,
    });
  }

  if (typeof frame?.token !== "string" || frame.token !== context.token) {
    return buildBrokerResponse({
      requestId: "unknown",
      outcome: { status: "rejected", reason: "bad-token" },
      now: context.now,
    });
  }

  const parsed = parseBrokerRequest(frame.request);
  if (!parsed.ok) {
    return buildBrokerResponse({
      requestId: "unknown",
      outcome: { status: "rejected", reason: parsed.reason },
      now: context.now,
    });
  }

  const request = parsed.request;
  const authorization = context.policy.authorize(request);
  if (!authorization.allowed) {
    return buildBrokerResponse({
      requestId: request.requestId,
      outcome: { status: "rejected", reason: authorization.reason },
      now: context.now,
    });
  }

  const outcome = await executeAuthorized(request, context);
  return buildBrokerResponse({ requestId: request.requestId, outcome, now: context.now });
}

/**
 * Only read-only operations are implemented here. Mutating operations parse and
 * authorize today but report `not-implemented` rather than pretending to work —
 * a fake success would be exactly the "misreport as done" failure the
 * requirements forbid.
 */
export async function executeAuthorized(
  request: BrokerRequest,
  context: Pick<ConnectionContext, "scriptDir" | "listWindows">,
): Promise<BrokerOutcome> {
  switch (request.operation) {
    case "list-windows": {
      const result = await context.listWindows({ scriptDir: context.scriptDir });
      if (!result.ok) return { status: "failed", reason: result.reason };
      const processName = request.target?.processName;
      const windows = processName
        ? result.value.filter((window) => filterByProcessPlaceholder(window, processName))
        : result.value;
      return { status: "ok", data: { windows } };
    }
    case "describe-element":
    case "find-elements":
    case "read-value":
    case "wait-for-window":
    case "invoke-pattern":
    case "set-value":
    case "send-keys":
      return { status: "failed", reason: "not-implemented" };
    default:
      return { status: "rejected", reason: "unsupported-operation" };
  }
}

/**
 * Window titles are not process names, so a title filter only narrows by the
 * text the OS reported. The real process binding happens in the caller's
 * allow-list check (BrokerPolicy); this keeps the read path honest about what
 * it can actually prove.
 */
function filterByProcessPlaceholder(window: WindowDescriptor, processName: string): boolean {
  return window.name.toLowerCase().includes(processName.toLowerCase());
}

export function describeHost(): { hostname: string; platform: NodeJS.Platform } {
  return { hostname: os.hostname(), platform: process.platform };
}
