/**
 * Configuración local del compañero (nunca viaja a la base).
 *
 * Vive en el directorio de datos del sistema:
 *   Windows: %APPDATA%/loki-desktop/
 *   macOS:   ~/Library/Application Support/loki-desktop/
 *   Linux:   ~/.config/loki-desktop/
 *
 * El secreto del dispositivo NO vive aquí (ver `secure-store.ts`). Aquí solo
 * hay preferencias locales y el `deviceId` (que no es secreto).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { DeviceAction } from "./catalog.js";

export const DESKTOP_VERSION = "0.1.0";

export interface LocalConfig {
  supabaseUrl: string;
  anonKey: string;
  deviceId: string | null;
  deviceName: string;
  /** Pausado desde la bandeja: no acepta comandos (se dejan vencer solos). */
  paused: boolean;
  /** Acciones apagadas AQUÍ (gana lo más restrictivo contra Loki). */
  localActionsOff: DeviceAction[];
  /** Comandos arbitrarios: exige true AQUÍ y `allow_arbitrary` en Loki. */
  localAllowArbitrary: boolean;
  /** Carpeta base de la que nunca se sale (por defecto ~/Loki). */
  baseDir: string;
}

export interface RecentEntry {
  at: string;
  action: string;
  summary: string;
  ok: boolean;
}

export function dataDir(): string {
  const appdata = process.env["APPDATA"];
  if (process.platform === "win32" && appdata !== undefined && appdata !== "") {
    return join(appdata, "loki-desktop");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "loki-desktop");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "loki-desktop");
  return join(homedir(), ".config", "loki-desktop");
}

function configPath(): string {
  return join(dataDir(), "config.json");
}

function recentPath(): string {
  return join(dataDir(), "recent.json");
}

export function defaultBaseDir(): string {
  return join(homedir(), "Loki");
}

export function defaultConfig(): LocalConfig {
  return {
    supabaseUrl: "http://127.0.0.1:54321",
    anonKey: "",
    deviceId: null,
    deviceName: "Mi PC",
    paused: false,
    localActionsOff: [],
    localAllowArbitrary: false,
    baseDir: defaultBaseDir(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function loadLocalConfig(): LocalConfig {
  const fallback = defaultConfig();
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;
  const get = (key: string): unknown => parsed[key];
  const str = (key: string, def: string): string => {
    const v = get(key);
    return typeof v === "string" && v !== "" ? v : def;
  };
  const actionsOff: DeviceAction[] = Array.isArray(get("localActionsOff"))
    ? (get("localActionsOff") as unknown[]).filter(
        (a): a is DeviceAction => typeof a === "string",
      )
    : [];
  const deviceId = get("deviceId");
  return {
    supabaseUrl: str("supabaseUrl", fallback.supabaseUrl),
    anonKey: str("anonKey", ""),
    deviceId: typeof deviceId === "string" && deviceId !== "" ? deviceId : null,
    deviceName: str("deviceName", "Mi PC").slice(0, 60),
    paused: get("paused") === true,
    localActionsOff: actionsOff,
    localAllowArbitrary: get("localAllowArbitrary") === true,
    baseDir: str("baseDir", defaultBaseDir()),
  };
}

export function saveLocalConfig(patch: Partial<LocalConfig>): LocalConfig {
  const current = loadLocalConfig();
  const next: LocalConfig = { ...current, ...patch };
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function loadRecent(): RecentEntry[] {
  try {
    const raw = readFileSync(recentPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RecentEntry[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      const { at, action, summary, ok } = item;
      if (typeof at !== "string" || typeof action !== "string" || typeof summary !== "string") continue;
      if (typeof ok !== "boolean") continue;
      out.push({ at, action, summary, ok });
    }
    return out.slice(0, 20);
  } catch {
    return [];
  }
}

export function pushRecent(entry: RecentEntry): void {
  const next = [entry, ...loadRecent()].slice(0, 20);
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(recentPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // El historial local nunca rompe la ejecución.
  }
}

export function clearLocalData(): void {
  saveLocalConfig({ ...defaultConfig(), supabaseUrl: loadLocalConfig().supabaseUrl });
}
