/**
 * The fixed mapping WeChat identity -> device -> Windows user SID.
 *
 * Requirement V1.1 requires a stable mapping so that "only the approved user on
 * this machine can trigger tools" is enforceable, and so unbinding immediately
 * ends that user's authority.
 *
 * Fail-closed rules: an unreadable, malformed or foreign-versioned file is
 * treated as *unbound*, never as bound. Records are replaced atomically rather
 * than appended, so an old binding cannot linger after a re-bind.
 */

export const COMPANYCLAW_IDENTITY_CONTRACT = "companyclaw.identity-binding.v1";
export const COMPANYCLAW_IDENTITY_SCHEMA = 1;

export interface IdentityBinding {
  ownerSid: string;
  deviceId: string;
  channelType: string;
  channelUserId: string;
  boundAt: string;
}

export interface IdentityBindingInspection {
  binding: IdentityBinding | null;
  warning: string | null;
}

interface IdentityEnvelope {
  contract: typeof COMPANYCLAW_IDENTITY_CONTRACT;
  schemaVersion: typeof COMPANYCLAW_IDENTITY_SCHEMA;
  binding: IdentityBinding | null;
}

interface IdentityStoreDependencies {
  now?: () => Date;
  existsFile?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, contents: string) => Promise<void>;
}

export class IdentityBindingStore {
  private readonly now: () => Date;
  private readonly existsFile: (filePath: string) => boolean;
  private readonly readFile: (filePath: string) => string;
  private readonly writeFile: (filePath: string, contents: string) => Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    dependencies: IdentityStoreDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.existsFile = dependencies.existsFile ?? (() => false);
    this.readFile = dependencies.readFile ?? (() => "");
    this.writeFile = dependencies.writeFile ?? (async () => undefined);
  }

  inspect(): IdentityBindingInspection {
    let raw: string;
    try {
      if (!this.existsFile(this.filePath)) return { binding: null, warning: null };
      raw = this.readFile(this.filePath);
    } catch {
      return { binding: null, warning: "Identity storage could not be read; unbound" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { binding: null, warning: "Identity storage is malformed; unbound" };
    }
    const envelope = parsed as IdentityEnvelope;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      envelope.contract !== COMPANYCLAW_IDENTITY_CONTRACT
    ) {
      return { binding: null, warning: "Legacy or foreign identity storage; unbound" };
    }
    if (!isCurrentBinding(envelope.binding)) {
      return { binding: null, warning: "Identity binding is incomplete; unbound" };
    }
    return { binding: envelope.binding, warning: null };
  }

  get(): IdentityBinding | null {
    return this.inspect().binding;
  }

  /** True only for the exact channel user that is currently bound. */
  isAuthorized(channelType: string, channelUserId: string): boolean {
    const binding = this.get();
    if (!binding) return false;
    return binding.channelType === channelType && binding.channelUserId === channelUserId;
  }

  /** The SID and device a bound channel user maps to, or null. */
  resolveOwner(
    channelType: string,
    channelUserId: string,
  ): { ownerSid: string; deviceId: string } | null {
    if (!this.isAuthorized(channelType, channelUserId)) return null;
    const binding = this.get();
    if (!binding) return null;
    return { ownerSid: binding.ownerSid, deviceId: binding.deviceId };
  }

  async bind(binding: IdentityBinding): Promise<IdentityBinding> {
    if (!binding.channelType.trim()) throw new Error("channelType is required");
    if (!binding.channelUserId.trim()) throw new Error("channelUserId is required");
    if (!binding.ownerSid.trim()) throw new Error("ownerSid is required");
    const record: IdentityBinding = {
      ...binding,
      boundAt: binding.boundAt || this.now().toISOString(),
    };
    await this.enqueueWrite(record);
    return record;
  }

  async unbind(): Promise<void> {
    await this.enqueueWrite(null);
  }

  private async enqueueWrite(binding: IdentityBinding | null): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const envelope: IdentityEnvelope = {
        contract: COMPANYCLAW_IDENTITY_CONTRACT,
        schemaVersion: COMPANYCLAW_IDENTITY_SCHEMA,
        binding,
      };
      await this.writeFile(this.filePath, JSON.stringify(envelope, null, 2));
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}

function isCurrentBinding(value: unknown): value is IdentityBinding {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as IdentityBinding;
  return (
    typeof binding.ownerSid === "string" &&
    binding.ownerSid.length > 0 &&
    typeof binding.deviceId === "string" &&
    typeof binding.channelType === "string" &&
    binding.channelType.length > 0 &&
    typeof binding.channelUserId === "string" &&
    binding.channelUserId.length > 0
  );
}
