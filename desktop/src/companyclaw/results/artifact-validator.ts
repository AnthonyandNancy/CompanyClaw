import { open, stat } from "node:fs/promises";
import * as path from "node:path";

export const DEFAULT_ALLOWED_EXTENSIONS = [
  ".xlsx",
  ".xls",
  ".csv",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".pdf",
  ".txt",
  ".md",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
] as const;

export type ArtifactRejectionReason =
  | "not-found"
  | "not-a-file"
  | "empty"
  | "too-large"
  | "extension-not-allowed"
  | "mime-mismatch"
  | "not-a-zip-container"
  | "unreadable";

export type ArtifactValidation =
  | { ok: true; size: number; detectedMime: string }
  | { ok: false; reason: ArtifactRejectionReason };

const ZIP_EXTENSIONS = new Set([".xlsx", ".docx", ".pptx"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);

/** Magic-number detection. Reads bytes, never trusts the extension. */
export async function detectMime(read: (length: number) => Promise<Buffer>): Promise<string> {
  const head = await read(8);
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) {
    return "application/pdf";
  }
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return "application/zip-container";
  }
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (head.length >= 3 && head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("ascii") === "GIF8") {
    return "image/gif";
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("ascii") === "RIFF") {
    return "application/riff";
  }
  if (head.length >= 2 && head.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))) {
    return "application/x-msdownload";
  }
  return "application/octet-stream";
}

export interface ArtifactValidationInput {
  filePath: string;
  allowedExtensions?: readonly string[];
  maxBytes?: number;
}

export async function validateArtifact(
  input: ArtifactValidationInput,
): Promise<ArtifactValidation> {
  const allowed = input.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  const extension = path.extname(input.filePath).toLowerCase();

  // Existence and file-vs-directory are checked before the extension so a
  // missing path or a directory reports the real problem.
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(input.filePath);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  if (!info.isFile()) return { ok: false, reason: "not-a-file" };

  if (!allowed.includes(extension)) {
    return { ok: false, reason: "extension-not-allowed" };
  }
  if (info.size === 0) return { ok: false, reason: "empty" };
  if (input.maxBytes !== undefined && info.size > input.maxBytes) {
    return { ok: false, reason: "too-large" };
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(input.filePath, "r");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const detectedMime = await detectMime(async (length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    });

    if (ZIP_EXTENSIONS.has(extension) && detectedMime !== "application/zip-container") {
      // An .xlsx/.docx/.pptx that is not a ZIP container cannot be a workbook
      // or document, whatever the extension claims.
      return { ok: false, reason: "mime-mismatch" };
    }
    if (extension === ".pdf" && detectedMime !== "application/pdf") {
      return { ok: false, reason: "mime-mismatch" };
    }
    if (IMAGE_EXTENSIONS.has(extension) && !detectedMime.startsWith("image/")) {
      return { ok: false, reason: "mime-mismatch" };
    }
    return { ok: true, size: info.size, detectedMime };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close();
  }
}
