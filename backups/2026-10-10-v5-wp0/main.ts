import { BrokerPolicyConfig } from "./policy";
import { startBrokerServer } from "./server";

/**
 * Broker process entry point.
 *
 * Configuration arrives through the environment, never through argv: the
 * execution token must not be visible in the process list. The chosen port is
 * printed as a single JSON line on stdout so the parent can connect without
 * guessing, and the process exits when its stdin closes — that closes the
 * lifetime with the owning app instead of leaking an orphan listener.
 */

export interface BrokerBootstrap {
  token: string;
  ownerSid: string;
  deviceId: string;
  allowedProcesses: string[];
  allowedWindowTitles: string[];
  scriptDir: string;
}

export type BootstrapParseResult =
  | { ok: true; value: BrokerBootstrap }
  | { ok: false; reason: string };

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseBootstrap(env: NodeJS.ProcessEnv): BootstrapParseResult {
  const token = env.COMPANYCLAW_BROKER_TOKEN;
  const ownerSid = env.COMPANYCLAW_BROKER_OWNER_SID;
  const deviceId = env.COMPANYCLAW_BROKER_DEVICE_ID;
  const scriptDir = env.COMPANYCLAW_BROKER_SCRIPT_DIR;

  if (!token || token.length < 16) return { ok: false, reason: "missing-or-weak-token" };
  if (!ownerSid) return { ok: false, reason: "missing-owner-sid" };
  if (!deviceId) return { ok: false, reason: "missing-device-id" };
  if (!scriptDir) return { ok: false, reason: "missing-script-dir" };

  return {
    ok: true,
    value: {
      token,
      ownerSid,
      deviceId,
      allowedProcesses: splitList(env.COMPANYCLAW_BROKER_ALLOWED_PROCESSES),
      allowedWindowTitles: splitList(env.COMPANYCLAW_BROKER_ALLOWED_WINDOW_TITLES),
      scriptDir,
    },
  };
}

export function toPolicyConfig(bootstrap: BrokerBootstrap): BrokerPolicyConfig {
  return {
    ownerSid: bootstrap.ownerSid,
    deviceId: bootstrap.deviceId,
    allowedProcesses: bootstrap.allowedProcesses,
    allowedWindowTitles: bootstrap.allowedWindowTitles,
    requireApprovalForMutations: true,
  };
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<number> {
  const parsed = parseBootstrap(env);
  if (!parsed.ok) {
    // Report the reason but never echo the secret-bearing environment.
    stdout.write(`${JSON.stringify({ error: parsed.reason })}\n`);
    return 2;
  }

  const handle = await startBrokerServer({
    policyConfig: toPolicyConfig(parsed.value),
    scriptDir: parsed.value.scriptDir,
    token: parsed.value.token,
  });

  stdout.write(`${JSON.stringify({ port: handle.port })}\n`);

  // Patch-time ticket verification is supplied by the owning app for now; until
  // then every mutation is refused by the policy's default verifier.
  await new Promise<void>((resolve) => {
    stdin.once("end", resolve);
    stdin.once("close", resolve);
    stdin.resume();
  });

  await handle.close();
  return 0;
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
