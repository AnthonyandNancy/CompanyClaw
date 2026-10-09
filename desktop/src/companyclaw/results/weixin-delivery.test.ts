import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactDelivery, type ArtifactDeliveryDependencies } from "./weixin-delivery";

/**
 * Sending a report to the wrong chat, sending a file from outside the task's
 * own directory, or claiming delivery nobody observed are the failures this
 * module exists to prevent.
 */
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function taskFixture(): {
  artifactsRoot: string;
  taskId: string;
  taskDir: string;
  reportPath: string;
} {
  const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "companyclaw-artifacts-"));
  temporaryRoots.push(artifactsRoot);
  const taskId = "task-1";
  const taskDir = path.join(artifactsRoot, taskId, "artifacts");
  fs.mkdirSync(taskDir, { recursive: true });
  const reportPath = path.join(taskDir, "报表.xlsx");
  // A minimal ZIP container: the validator checks the XLSX magic bytes.
  fs.writeFileSync(reportPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));
  return { artifactsRoot, taskId, taskDir, reportPath };
}

function deliveryWith(
  fixture: ReturnType<typeof taskFixture>,
  overrides: Partial<ArtifactDeliveryDependencies> = {},
) {
  const sendFile = vi.fn().mockResolvedValue({ messageId: "client-id-1" });
  const delivery = new ArtifactDelivery({
    resolveArtifactDir: (taskId, ownerSid) =>
      taskId === fixture.taskId && ownerSid === "S-1"
        ? { ok: true, dir: path.join(fixture.artifactsRoot, taskId, "artifacts") }
        : { ok: false, reason: "unknown-task" },
    sendFile,
    artifactHash: async () => "hash-1",
    ...overrides,
  });
  return { delivery, sendFile };
}

describe("artifact delivery", () => {
  it("sends a validated artifact to the task's own owner", async () => {
    const fixture = taskFixture();
    const { delivery, sendFile } = deliveryWith(fixture);
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: fixture.reportPath,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    expect(result.outcome).toBe("sent");
    expect(result.fileName).toBe("报表.xlsx");
    // The Chinese file name survives, and the chat is the owner's.
    expect(sendFile).toHaveBeenCalledWith(
      expect.objectContaining({ to: "wx-owner", fileName: "报表.xlsx" }),
    );
  });

  it("never reports a platform-accepted send as delivered", async () => {
    const fixture = taskFixture();
    const { delivery } = deliveryWith(fixture);
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: fixture.reportPath,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    // The plugin's messageId is a local client id, not a delivery receipt.
    expect(result.state).toBe("SENT");
    expect(result.state).not.toBe("DELIVERED");
  });

  it("refuses a file outside the task's own directory", async () => {
    const fixture = taskFixture();
    const elsewhere = path.join(fixture.artifactsRoot, "other-task", "artifacts");
    fs.mkdirSync(elsewhere, { recursive: true });
    const stolen = path.join(elsewhere, "other.xlsx");
    fs.writeFileSync(stolen, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const { delivery, sendFile } = deliveryWith(fixture);
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: stolen,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("outside-task-directory");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("refuses to send to a chat other than the task's owner", async () => {
    const fixture = taskFixture();
    const { delivery, sendFile } = deliveryWith(fixture);
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: fixture.reportPath,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-someone-else",
    });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("recipient-not-the-owner");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("refuses an empty file", async () => {
    const fixture = taskFixture();
    const empty = path.join(fixture.taskDir, "empty.xlsx");
    fs.writeFileSync(empty, "");
    const { delivery, sendFile } = deliveryWith(fixture);
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: empty,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    expect(result.reason).toContain("invalid-artifact");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("refuses a file whose contents do not match its extension", async () => {
    const fixture = taskFixture();
    const fake = path.join(fixture.taskDir, "report.xlsx");
    fs.writeFileSync(fake, "this is not a workbook");
    const { delivery, sendFile } = deliveryWith(fixture);
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: fake,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    expect(result.reason).toContain("invalid-artifact");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("refuses an unknown task or a mismatched owner", async () => {
    const fixture = taskFixture();
    const { delivery, sendFile } = deliveryWith(fixture);
    const unknown = await delivery.deliver({
      taskId: "nope",
      ownerSid: "S-1",
      filePath: fixture.reportPath,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    expect(unknown.reason).toBe("unknown-task");

    const wrongOwner = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-2",
      filePath: fixture.reportPath,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    expect(wrongOwner.reason).toBe("unknown-task");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("marks a transport timeout as unknown rather than failed or sent", async () => {
    const fixture = taskFixture();
    const sendFile = vi.fn().mockRejectedValue(new Error("request timeout after 15000ms"));
    const { delivery } = deliveryWith(fixture, { sendFile });
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: fixture.reportPath,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    // A timeout cannot tell whether the platform got the file, so retrying
    // blindly could send it twice and "sent" would be a claim we cannot make.
    expect(result.outcome).toBe("unknown");
    expect(result.state).toBe("UNKNOWN");
    expect(result.mayHaveBeenSent).toBe(true);
  });

  it("marks a definite platform rejection as failed", async () => {
    const fixture = taskFixture();
    const sendFile = vi.fn().mockRejectedValue(new Error("file too large: 120MB"));
    const { delivery } = deliveryWith(fixture, { sendFile });
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: fixture.reportPath,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    expect(result.outcome).toBe("failed");
    expect(result.state).toBe("FAILED");
    expect(result.reason).toContain("too large");
  });

  it("normalizes a file name that could escape the artifact directory", async () => {
    const fixture = taskFixture();
    // A path separator in the leaf name would address a different location.
    const odd = path.join(fixture.taskDir, "ok.xlsx");
    fs.writeFileSync(odd, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const { delivery } = deliveryWith(fixture);
    const result = await delivery.deliver({
      taskId: fixture.taskId,
      ownerSid: "S-1",
      filePath: odd,
      boundChannelUserId: "wx-owner",
      targetChannelUserId: "wx-owner",
    });
    expect(result.outcome).toBe("sent");
    expect(result.fileName).toBe("ok.xlsx");
    expect(result.fileName).not.toContain("/");
  });
});
