import type { RemoteAuthorizationState } from "../policy/risk-classifier";

export const COMPANYCLAW_REMOTE_AUTH_CONTRACT = "companyclaw.remote-authorization.v1";

export interface RemoteAuthorizationRecord {
  contract: typeof COMPANYCLAW_REMOTE_AUTH_CONTRACT;
  enabled: boolean;
  ownerSid: string;
  deviceId: string;
  channelUserId: string;
  grantedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface SessionSource {
  channelType: string;
  userId: string;
  messageId?: string;
  deviceId?: string;
}

export interface SetEnabledInput {
  ownerSid: string;
  deviceId: string;
  channelUserId: string;
  ttlMs: number;
}

interface RemoteAuthorizationDependencies {
  now?: () => Date;
  write?: (record: RemoteAuthorizationRecord) => Promise<void>;
}

export class RemoteAuthorization {
  private readonly now: () => Date;
  private readonly write: (record: RemoteAuthorizationRecord) => Promise<void>;
  private record: RemoteAuthorizationRecord;

  constructor(dependencies: RemoteAuthorizationDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.write = dependencies.write ?? (async () => undefined);
    this.record = {
      contract: COMPANYCLAW_REMOTE_AUTH_CONTRACT,
      enabled: false,
      ownerSid: "",
      deviceId: "",
      channelUserId: "",
      grantedAt: null,
      expiresAt: null,
      revokedAt: null,
    };
  }

  snapshot(): RemoteAuthorizationRecord {
    return { ...this.record };
  }

  state(at: Date = this.now()): RemoteAuthorizationState {
    if (this.record.revokedAt) return "revoked";
    if (!this.record.enabled || !this.record.expiresAt) return "disabled";
    if (Date.parse(this.record.expiresAt) <= at.getTime()) return "expired";
    return "enabled";
  }

  setEnabled(input: SetEnabledInput): RemoteAuthorizationRecord {
    const now = this.now();
    this.record = {
      ...this.record,
      enabled: true,
      ownerSid: input.ownerSid,
      deviceId: input.deviceId,
      channelUserId: input.channelUserId,
      grantedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      revokedAt: null,
    };
    void this.write(this.record);
    return this.snapshot();
  }

  revoke(): RemoteAuthorizationRecord {
    this.record = {
      ...this.record,
      enabled: false,
      revokedAt: this.now().toISOString(),
    };
    void this.write(this.record);
    return this.snapshot();
  }
}

/**
 * Session provenance must come from trusted channel metadata. A source is only
 * accepted when the transport itself supplied both a non-local channel type and
 * a user id; user-authored text can never declare its own provenance.
 */
export function bindSessionSource(
  raw: {
    channelType?: string;
    userId?: string;
    messageId?: string;
    deviceId?: string;
    declaredBy?: string;
  } | null,
): SessionSource | null {
  if (!raw) return null;
  if (raw.declaredBy === "user-text") return null;
  const channelType = (raw.channelType ?? "").trim();
  const userId = (raw.userId ?? "").trim();
  if (!channelType || channelType === "local") return null;
  if (!userId) return null;
  return {
    channelType,
    userId,
    ...(raw.messageId ? { messageId: raw.messageId } : {}),
    ...(raw.deviceId ? { deviceId: raw.deviceId } : {}),
  };
}
