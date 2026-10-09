import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerClient } from "./broker-client";

/**
 * In a packaged build `process.execPath` is CompanyClaw.exe, which cannot
 * execute the broker's JavaScript entry point. The broker has to run on the
 * bundled private Node runtime instead, resolved by resolveNodePath().
 *
 * The client verifies both the runtime and the entry point before spawning, so
 * the fixture lays out the real shape (a runtime file and
 * `companyclaw-broker/dist/main.js`) in a temporary directory rather than
 * asserting on paths that could never exist.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  constructor() {
    super();
    // The real broker exits when its stdin closes; modelling that here keeps
    // stop() from waiting for the kill timer.
    this.stdin.on("finish", () => this.emit("exit", 0));
    this.stdin.on("close", () => this.emit("exit", 0));
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companyclaw-broker-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Lays out a resources directory holding the runtime and the broker entry. */
function stagedInstallation(
  root: string,
  nodeFileName = "node.exe",
): {
  resourcesPath: string;
  nodePath: string;
  brokerDir: string;
} {
  const resourcesPath = path.join(root, "resources");
  const brokerDir = path.join(resourcesPath, "companyclaw-broker");
  fs.mkdirSync(path.join(brokerDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(brokerDir, "dist", "main.js"), "// broker\n", "utf8");
  const nodePath = path.join(resourcesPath, nodeFileName);
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(nodePath, "binary\n", "utf8");
  return { resourcesPath, nodePath, brokerDir };
}

function clientWith(nodePath: string | undefined, installationRoot?: string) {
  const calls: SpawnCall[] = [];
  const child = new FakeChild();
  const root = installationRoot ?? temporaryRoot();
  const { brokerDir } = stagedInstallation(root);
  const client = new BrokerClient({
    brokerDir,
    scriptDir: path.join(brokerDir, "scripts"),
    ...(nodePath ? { nodePath } : {}),
    ownerSid: "S-1-5-21-0",
    deviceId: "device-1",
    allowedProcesses: [],
    allowedWindowTitles: [],
    spawnProcess: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      setImmediate(() => child.stdout.write('{"port":41234}\n'));
      return child;
    }) as unknown as typeof spawn,
  });
  return { client, calls, brokerDir };
}

describe("broker production startup", () => {
  it("launches the broker on the configured private Node runtime", async () => {
    const root = temporaryRoot();
    const { nodePath, brokerDir } = stagedInstallation(root);
    const { client, calls } = clientWith(nodePath, root);
    try {
      await client.start();
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe(nodePath);
      expect(calls[0].args).toEqual([path.join(brokerDir, "dist", "main.js")]);
    } finally {
      await client.stop();
    }
  });

  it("never puts the execution token on the command line", async () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root);
    const { client, calls } = clientWith(nodePath, root);
    try {
      await client.start();
      // The token travels in the environment so it cannot be read out of a
      // process listing.
      expect(JSON.stringify(calls[0].args)).not.toContain(client.getToken());
      expect(calls[0].env.COMPANYCLAW_BROKER_TOKEN).toBe(client.getToken());
    } finally {
      await client.stop();
    }
  });

  it("honours a node path containing spaces and non-ASCII characters", async () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root, path.join("程序 文件", "node.exe"));
    const { client, calls } = clientWith(nodePath, root);
    try {
      await client.start();
      expect(calls[0].command).toBe(nodePath);
    } finally {
      await client.stop();
    }
  });

  it("falls back to process.execPath when no node path was supplied", async () => {
    const { client, calls } = clientWith(undefined);
    try {
      await client.start();
      expect(calls[0].command).toBe(process.execPath);
    } finally {
      await client.stop();
    }
  });

  it("refuses to spawn without a runtime, naming the missing component", async () => {
    const root = temporaryRoot();
    const { nodePath, brokerDir } = stagedInstallation(root);
    fs.rmSync(nodePath);
    const calls: SpawnCall[] = [];
    const client = new BrokerClient({
      brokerDir,
      scriptDir: path.join(brokerDir, "scripts"),
      nodePath,
      ownerSid: "S-1-5-21-0",
      deviceId: "device-1",
      allowedProcesses: [],
      allowedWindowTitles: [],
      spawnProcess: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, env: options.env });
        return new FakeChild();
      }) as unknown as typeof spawn,
    });

    await expect(client.start()).rejects.toThrow(/BROKER_RUNTIME_NOT_FOUND/);
    // Nothing may be spawned: an unknown interpreter must not be tried.
    expect(calls).toHaveLength(0);
    expect(client.getStatus().lastFailureReason).toMatch(/BROKER_RUNTIME_NOT_FOUND/);
  });

  it("refuses to spawn without the broker entry point", async () => {
    const root = temporaryRoot();
    const { nodePath, brokerDir } = stagedInstallation(root);
    fs.rmSync(path.join(brokerDir, "dist", "main.js"));
    const calls: SpawnCall[] = [];
    const client = new BrokerClient({
      brokerDir,
      scriptDir: path.join(brokerDir, "scripts"),
      nodePath,
      ownerSid: "S-1-5-21-0",
      deviceId: "device-1",
      allowedProcesses: [],
      allowedWindowTitles: [],
      spawnProcess: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, env: options.env });
        return new FakeChild();
      }) as unknown as typeof spawn,
    });

    await expect(client.start()).rejects.toThrow(/BROKER_ENTRY_INVALID/);
    expect(calls).toHaveLength(0);
    expect(client.getStatus().lastFailureReason).toMatch(/BROKER_ENTRY_INVALID/);
  });
});

describe("broker node runtime wiring", () => {
  const srcDir = path.resolve(__dirname, "..");

  it("passes a resolved node path from main into the broker client", () => {
    const ipcSource = readFileSync(path.join(srcDir, "companyclaw", "ipc.ts"), "utf-8");
    const mainSource = readFileSync(path.join(srcDir, "main.ts"), "utf-8");
    expect(ipcSource).toContain("options.nodePath");
    expect(mainSource).toContain("nodePath: resolveNodePath()");
  });
});

describe("broker status reporting", () => {
  it("starts with no successful call and no failure recorded", async () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root);
    const { client } = clientWith(nodePath, root);
    const status = client.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastSuccessfulCallAt).toBeNull();
    expect(status.lastFailureReason).toBeNull();
    expect(status.restarts).toBe(0);
    client.getToken();
  });

  it("reports the configured node runtime so diagnostics can name it", () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root);
    const { client } = clientWith(nodePath, root);
    expect(client.getStatus().nodePath).toBe(nodePath);
  });

  it("records a failure reason when the broker is unreachable", async () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root);
    const { client } = clientWith(nodePath, root);
    const result = await client.call({
      operation: "list-windows",
      taskId: "t1",
      stepId: "s1",
      payloadHash: "0".repeat(64),
      timeoutMs: 40,
    });
    expect(result.ok).toBe(false);
    // A transport failure must be visible in the status, not silently retried.
    expect(client.getStatus().lastFailureReason).toBeTruthy();
    await client.stop();
  });
});

describe("broker lifecycle", () => {
  /** Client whose broker process dies as soon as it announced a port. */
  function clientWithExitingBroker(root: string, nodePath: string) {
    const { brokerDir } = stagedInstallation(root, path.basename(nodePath));
    const children: FakeChild[] = [];
    const client = new BrokerClient({
      brokerDir,
      scriptDir: path.join(brokerDir, "scripts"),
      nodePath,
      ownerSid: "S-1-5-21-0",
      deviceId: "device-1",
      allowedProcesses: [],
      allowedWindowTitles: [],
      spawnProcess: (() => {
        const child = new FakeChild();
        children.push(child);
        setImmediate(() => child.stdout.write('{"port":41234}\n'));
        return child;
      }) as unknown as typeof spawn,
    });
    return { client, children };
  }

  function killBroker(child: FakeChild): void {
    child.emit("exit", 1);
  }

  it("stops reporting running once the process has died", async () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root);
    const { client, children } = clientWithExitingBroker(root, nodePath);
    await client.start();
    expect(client.isRunning()).toBe(true);

    killBroker(children[0]);

    // A dead process must not keep looking alive, or every later call is sent
    // to a socket nobody is listening on.
    expect(client.isRunning()).toBe(false);
    expect(client.getStatus().lastFailureReason).toMatch(/broker exited/);
  });

  it("does not treat a deliberate stop as a failure", async () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root);
    const { client } = clientWithExitingBroker(root, nodePath);
    await client.start();
    await client.stop();
    expect(client.getStatus().lastFailureReason).toBeNull();
    expect(client.getStatus().restarts).toBe(0);
  });

  it("gives up instead of restarting a crash loop forever", async () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root);
    const { client, children } = clientWithExitingBroker(root, nodePath);
    await client.start();

    // Every attempt starts a process that then dies without answering.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      killBroker(children[children.length - 1]);
      await client.call({
        operation: "list-windows",
        taskId: "t1",
        stepId: `s${attempt}`,
        payloadHash: "0".repeat(64),
        timeoutMs: 30,
      });
    }

    const result = await client.call({
      operation: "list-windows",
      taskId: "t1",
      stepId: "final",
      payloadHash: "0".repeat(64),
      timeoutMs: 30,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("broker-restart-limit");
  });

  it("lets an allow-list change restart the broker without spending the budget", async () => {
    const root = temporaryRoot();
    const { nodePath } = stagedInstallation(root);
    const { client, children } = clientWithExitingBroker(root, nodePath);
    await client.start();

    for (let edit = 0; edit < 3; edit += 1) {
      await client.updateTargets({ allowedProcesses: ["notepad"], allowedWindowTitles: [] });
      await client.start();
    }

    // A user editing the allow list must not lock themselves out of the broker.
    expect(client.getStatus().restarts).toBe(0);
    expect(children.length).toBe(4);
  });
});

describe("weixin approval bridge wiring", () => {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const srcDir = path.resolve(__dirname, "..");

  it("answers every approval-reply request so the plugin is never left waiting", () => {
    const mainSource = readFileSync(path.join(srcDir, "main.ts"), "utf-8");
    expect(mainSource).toContain('msg?.type === "approval-reply-request"');
    expect(mainSource).toContain('type: "approval-reply-response"');
    // The decision stays behind the runtime: no approval is granted here.
    expect(mainSource).toContain("isRemoteCallerAuthorized");
    expect(mainSource).toContain("applyApprovalReply");
  });

  it("keeps the plugin's inbound branch additive and behind the desktop verdict", () => {
    const pluginSource = readFileSync(
      path.join(
        repositoryRoot,
        "plugins",
        "openclaw-weixin",
        "src",
        "messaging",
        "process-message.ts",
      ),
      "utf-8",
    );
    expect(pluginSource).toContain("publishSessionSource");
    expect(pluginSource).toContain("forwardApprovalReply");
    // A handled reply returns early; anything else falls through to the AI.
    expect(pluginSource).toMatch(/if \(await forwardApprovalReply\([\s\S]*?\)\) \{[\s\S]*?return;/);
  });
});
