import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BrokerClient } from "./broker-client";

/**
 * In a packaged build `process.execPath` is CompanyClaw.exe, which cannot
 * execute the broker's JavaScript entry point. The broker has to run on the
 * bundled private Node runtime instead, resolved by resolveNodePath().
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

function clientWith(nodePath: string | undefined) {
  const calls: SpawnCall[] = [];
  const child = new FakeChild();
  const brokerDir = path.join("C:", "app", "resources", "companyclaw-broker");
  const client = new BrokerClient({
    brokerDir,
    scriptDir: path.join(brokerDir, "scripts"),
    ...(nodePath ? { nodePath } : {}),
    ownerSid: "S-1-5-21-0",
    deviceId: "device-1",
    allowedProcesses: [],
    allowedWindowTitles: [],
    spawnProcess: ((
      command: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      calls.push({ command, args, env: options.env });
      setImmediate(() => child.stdout.write('{"port":41234}\n'));
      return child;
    }) as unknown as typeof spawn,
  });
  return { client, calls, brokerDir };
}

describe("broker production startup", () => {
  it("launches the broker on the configured private Node runtime", async () => {
    const nodePath = path.join("C:", "app", "resources", "node.exe");
    const { client, calls, brokerDir } = clientWith(nodePath);
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
    const { client, calls } = clientWith(path.join("C:", "app", "resources", "node.exe"));
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
    const nodePath = path.join("C:", "程序 文件", "CompanyClaw", "node.exe");
    const { client, calls } = clientWith(nodePath);
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
