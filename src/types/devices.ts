import type { Timestamp } from "@/lib/timestamp";
import type {
  DeviceAction,
  DeviceCommandStatus,
  DeviceRisk,
} from "@/lib/devices/catalog";

export type { DeviceAction, DeviceCommandStatus, DeviceRisk };

export type DevicePlatform = "windows" | "linux" | "macos" | "other";

export interface DeviceDoc {
  id: string;
  ownerId: string;
  name: string;
  platform: DevicePlatform;
  appVersion: string;
  allowedActions: DeviceAction[];
  readableDirs: string[];
  canSendFiles: boolean;
  allowArbitrary: boolean;
  revokedAt: Timestamp | null;
  lastSeenAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** ¿En línea? (latido hace menos de 2 minutos). */
export function isDeviceOnline(device: DeviceDoc, now = Date.now()): boolean {
  if (device.revokedAt !== null || device.lastSeenAt === null) return false;
  return now - device.lastSeenAt.toDate().getTime() < 2 * 60 * 1000;
}

export interface DeviceCommandDoc {
  id: string;
  deviceId: string;
  ownerId: string;
  workspaceId: string | null;
  chatId: string;
  messageId: string | null;
  requestedBy: string | null;
  action: DeviceAction;
  params: Record<string, unknown>;
  risk: DeviceRisk;
  status: DeviceCommandStatus;
  resultText: string;
  resultPath: string | null;
  resultMime: string;
  confirmedBy: string | null;
  confirmedAt: Timestamp | null;
  deliveredAt: Timestamp | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  expiresAt: Timestamp;
  error: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DeviceAuditDoc {
  id: string;
  deviceId: string;
  ownerId: string;
  commandId: string | null;
  actorId: string | null;
  action:
    | "paired"
    | "revoked"
    | "requested"
    | "confirmed"
    | "rejected"
    | "claimed"
    | "delivered"
    | "done"
    | "error"
    | "expired"
    | "settings";
  detail: string;
  createdAt: Timestamp;
}

export interface DeviceSettingsPatch {
  name?: string;
  allowedActions?: DeviceAction[];
  readableDirs?: string[];
  canSendFiles?: boolean;
  allowArbitrary?: boolean;
}

export type DeviceCommandFilter = {
  action?: DeviceAction | "all";
  status?: DeviceCommandStatus | "all";
};
