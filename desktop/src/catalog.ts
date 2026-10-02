/**
 * Catálogo cerrado de acciones del compañero de escritorio.
 *
 * CUARTA copia de la misma tabla (mantén los riesgos iguales):
 *   1. `src/lib/devices/catalog.ts` (web)
 *   2. `supabase/functions/_shared/devices.ts` (Edge loki-chat)
 *   3. `device_action_risk()` en `supabase/migrations/20261014000000_devices.sql`
 *   4. este archivo (compañero de escritorio)
 *
 * Sintaxis erasable (sin enums ni namespaces): el núcleo corre con tsc a
 * `dist/` y en desarrollo con `npm run dev` (Node 22+).
 */

export type DeviceAction =
  | "pc_status"
  | "open_app"
  | "open_url"
  | "find_files"
  | "send_file"
  | "screenshot"
  | "lock_screen"
  | "volume_set"
  | "media_control"
  | "run_script"
  | "arbitrary_exec";

export type DeviceRisk = "info" | "normal" | "sensible";

export type DeviceCommandStatus =
  | "pending_confirmation"
  | "queued"
  | "delivered"
  | "running"
  | "done"
  | "error"
  | "rejected"
  | "expired";

export interface DeviceCatalogEntry {
  action: DeviceAction;
  label: string;
  detail: string;
  risk: DeviceRisk;
  needsText: boolean;
}

export const DEVICE_CATALOG: readonly DeviceCatalogEntry[] = [
  { action: "pc_status", label: "Estado del PC", detail: "Batería, uso y encendido.", risk: "info", needsText: false },
  { action: "open_app", label: "Abrir app", detail: "Abre una aplicación instalada.", risk: "normal", needsText: true },
  { action: "open_url", label: "Abrir enlace", detail: "Abre una URL https en el navegador.", risk: "normal", needsText: true },
  { action: "find_files", label: "Buscar archivos", detail: "Busca por nombre solo en carpetas permitidas.", risk: "normal", needsText: true },
  { action: "send_file", label: "Mandar archivo al chat", detail: "Sube un archivo del PC al chat.", risk: "sensible", needsText: true },
  { action: "screenshot", label: "Captura de pantalla", detail: "Toma una captura y la manda al chat.", risk: "normal", needsText: false },
  { action: "lock_screen", label: "Bloquear pantalla", detail: "Bloquea la sesión del PC.", risk: "normal", needsText: false },
  { action: "volume_set", label: "Volumen", detail: "Pone el volumen (0–100) o silencia.", risk: "normal", needsText: false },
  { action: "media_control", label: "Multimedia", detail: "Pausa, reproduce, siguiente o anterior.", risk: "normal", needsText: false },
  { action: "run_script", label: "Correr script", detail: "Ejecuta un script de tu lista registrada en el PC.", risk: "sensible", needsText: true },
  { action: "arbitrary_exec", label: "Comando arbitrario", detail: "Ejecuta texto libre en la terminal (solo si lo habilitaste).", risk: "sensible", needsText: true },
];

export function deviceCatalogEntry(action: string): DeviceCatalogEntry | null {
  for (const entry of DEVICE_CATALOG) {
    if (entry.action === action) return entry;
  }
  return null;
}

export function isDeviceAction(value: string): value is DeviceAction {
  return deviceCatalogEntry(value) !== null;
}

export function deviceRiskOf(action: string): DeviceRisk {
  return deviceCatalogEntry(action)?.risk ?? "sensible";
}

export function deviceLabelOf(action: string): string {
  return deviceCatalogEntry(action)?.label ?? "Acción del PC";
}

/** Lo desconocido siempre es sensible (se rechaza sin confirmación registrada). */
export function validateDeviceParams(
  action: string,
  params: Record<string, unknown>,
): string | null {
  const entry = deviceCatalogEntry(action);
  if (entry === null) return "Esa acción no existe en el catálogo.";
  const text = typeof params["text"] === "string" ? params["text"].trim() : "";
  if (text.length > 2000) return "El texto es demasiado largo.";
  if (params["dir"] !== undefined && typeof params["dir"] !== "string") {
    return "La carpeta no es válida.";
  }
  if (text.includes("..")) return "Esa ruta no está permitida.";
  switch (action) {
    case "open_app":
    case "run_script":
      if (text === "") {
        return action === "open_app" ? "Falta qué abrir." : "Falta qué script correr.";
      }
      if (text.length > 120) return "El nombre es demasiado largo.";
      return null;
    case "open_url":
      if (!/^https:\/\/[^ ]+$/.test(text)) return "Solo URLs https válidas.";
      return null;
    case "find_files":
      if (text === "" || text.length > 120) return "Falta qué buscar.";
      return null;
    case "send_file":
      if (text === "" || text.length > 500) return "Falta el archivo a mandar.";
      return null;
    case "volume_set": {
      const level = params["level"];
      const muted = params["muted"];
      if (muted === true) return null;
      if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 100) {
        return "El volumen va de 0 a 100.";
      }
      return null;
    }
    case "media_control": {
      const op = typeof params["op"] === "string" ? params["op"] : "";
      if (op !== "play" && op !== "pause" && op !== "toggle" && op !== "next" && op !== "prev") {
        return "Esa orden multimedia no existe.";
      }
      return null;
    }
    case "arbitrary_exec":
      if (text === "" || text.length > 2000) return "Falta el comando a ejecutar.";
      return null;
    default:
      return null;
  }
}

export function deviceSummary(action: string, params: Record<string, unknown>): string {
  const label = deviceLabelOf(action);
  const text = typeof params["text"] === "string" ? params["text"].trim() : "";
  if (action === "volume_set") {
    if (params["muted"] === true) return `${label}: silenciar`;
    const level = typeof params["level"] === "number" ? Math.round(params["level"]) : null;
    return level === null ? label : `${label}: ${level}`;
  }
  if (action === "media_control") {
    const op = typeof params["op"] === "string" ? params["op"] : "";
    const opLabel =
      op === "next" ? "siguiente" : op === "prev" ? "anterior" : op === "pause" ? "pausa" : op === "play" ? "reproducir" : "pausa/reproducir";
    return `${label}: ${opLabel}`;
  }
  return text === "" ? label : `${label}: ${text.slice(0, 80)}`;
}
