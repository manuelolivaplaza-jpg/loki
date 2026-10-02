/**
 * Contrato del ícono de bandeja (lo implementa el shell Tauri; el núcleo
 * expone el estado por `status --json`).
 *
 * Estados: vincular (sin credencial) · conectado (socket vivo, en reposo) ·
 * ejecutando (un comando en curso) · pausado (no acepta comandos) ·
 * desconectado (sin red o con backoff).
 */

import type { DeviceAction } from "./catalog.js";
import { DEVICE_CATALOG } from "./catalog.js";

export type TrayState =
  | "vincular"
  | "conectado"
  | "desconectado"
  | "ejecutando"
  | "pausado";

export interface TrayMenuItem {
  id: string;
  label: string;
  enabled: boolean;
}

export function trayStateLabel(state: TrayState): string {
  switch (state) {
    case "vincular":
      return "Sin vincular";
    case "conectado":
      return "Conectado";
    case "desconectado":
      return "Desconectado";
    case "ejecutando":
      return "Ejecutando…";
    case "pausado":
      return "Pausado";
  }
}

/** Menú de la bandeja (español): pausar, actividad, permisos, desvincular, salir. */
export function buildTrayMenu(state: TrayState, paused: boolean): TrayMenuItem[] {
  const linked = state !== "vincular";
  return [
    { id: "status", label: `Loki: ${trayStateLabel(state)}`, enabled: false },
    {
      id: paused ? "resume" : "pause",
      label: paused ? "Reanudar (aceptar comandos)" : "Pausar (no aceptar comandos)",
      enabled: linked,
    },
    { id: "recent", label: "Actividad reciente", enabled: linked },
    { id: "permissions", label: "Permisos de este PC", enabled: linked },
    { id: "unlink", label: "Desvincular este PC", enabled: linked },
    { id: "quit", label: "Salir", enabled: true },
  ];
}

export interface LocalPermissions {
  /** Acciones que este PC acepta (Loki ∩ local). */
  effectiveActions: DeviceAction[];
  /** Apagadas aquí (gana lo más restrictivo). */
  localOff: DeviceAction[];
  /** Apagadas en Loki para este PC. */
  serverOff: DeviceAction[];
  readableDirs: string[];
  canSendFiles: boolean;
  allowArbitrary: boolean;
  paused: boolean;
}

/** Intersección Loki ∩ local: siempre gana lo más restrictivo. */
export function effectivePermissions(
  serverActions: DeviceAction[],
  serverDirs: string[],
  serverCanSend: boolean,
  serverArbitrary: boolean,
  localOff: DeviceAction[],
  localArbitrary: boolean,
  paused: boolean,
): LocalPermissions {
  const serverSet = new Set(serverActions);
  const effectiveActions = DEVICE_CATALOG.map((e) => e.action).filter(
    (a) => serverSet.has(a) && !localOff.includes(a) && (a !== "arbitrary_exec" || (serverArbitrary && localArbitrary)),
  );
  const serverOff = DEVICE_CATALOG.map((e) => e.action).filter((a) => !serverSet.has(a));
  return {
    effectiveActions,
    localOff: [...localOff],
    serverOff,
    readableDirs: [...serverDirs],
    canSendFiles: serverCanSend,
    allowArbitrary: serverArbitrary && localArbitrary,
    paused,
  };
}
