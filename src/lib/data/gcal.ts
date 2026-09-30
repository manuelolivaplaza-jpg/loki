"use client";

/**
 * Cliente de la Edge Function `google-calendar` (sincronización
 * bidireccional con Google Calendar).
 *
 * Todas las llamadas mandan el JWT de la sesión; la Edge valida al usuario
 * y nunca expone tokens al cliente. Errores en español vía `GcalError`.
 * Sin conexión, el llamador no debe romper: estas funciones lanzan y es el
 * hook / diálogo quien las trata como no-op discreto.
 */

import { getSupabaseClient } from "@/lib/supabase/client";
import { edgeHeaders } from "@/lib/edge";

export const GCAL_FUNCTION_PATH = "google-calendar";

export type GcalStatus = {
  connected: boolean;
  email: string;
  lastPullAt: string | null;
  syncEnabled: boolean;
  calendarId: string;
};

export type GcalPullResult = {
  imported: number;
  updated: number;
  removed: number;
  /** Eventos que Google devolvió en la ventana (diagnóstico). */
  fetched: number;
};

/** Error con mensaje ya en español para pintar en la UI. */
export class GcalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GcalError";
    this.code = code;
  }
}

function functionUrl(): string | null {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (base === "") return null;
  return `${base.replace(/\/+$/, "")}/functions/v1/${GCAL_FUNCTION_PATH}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

async function authToken(): Promise<string> {
  const { data } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token ?? "";
  if (token === "") {
    throw new GcalError("no_session", "Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  return token;
}

function friendlyError(status: number, body: unknown): GcalError {
  const code = isRecord(body) && typeof body["code"] === "string"
    ? (body["code"] as string)
    : "failed";
  const serverMessage = isRecord(body) && typeof body["message"] === "string"
    ? (body["message"] as string)
    : null;
  if (status === 503 || code === "not_configured") {
    return new GcalError(
      code,
      serverMessage ?? "Google Calendar sin configurar. Pide al administrador que ponga los secretos de Google.",
    );
  }
  if (status === 429) {
    return new GcalError(code, serverMessage ?? "Demasiadas peticiones. Espera un minuto e inténtalo de nuevo.");
  }
  if (status === 401) {
    return new GcalError("no_session", "Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  if (code === "not_connected") {
    return new GcalError(code, "No hay conexión con Google. Conecta tu calendario primero.");
  }
  return new GcalError(code, serverMessage ?? "No se pudo hablar con Google. Inténtalo de nuevo.");
}

async function callGcal(action: string, extra?: Record<string, string>): Promise<Record<string, unknown>> {
  const url = functionUrl();
  if (url === null) {
    throw new GcalError("no_config", "Falta la configuración de Supabase.");
  }
  const token = await authToken();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: edgeHeaders(token),
      body: JSON.stringify({ action, ...(extra ?? {}) }),
    });
  } catch {
    throw new GcalError("network", "Error de red. Revisa tu conexión e inténtalo de nuevo.");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw friendlyError(res.status, body);
  return isRecord(body) ? body : {};
}

/** Estado de la conexión (nunca expone tokens). Sin función: no conectado. */
export async function statusGcal(): Promise<GcalStatus> {
  const offline: GcalStatus = {
    connected: false,
    email: "",
    lastPullAt: null,
    syncEnabled: false,
    calendarId: "primary",
  };
  const url = functionUrl();
  if (url === null) return offline;
  try {
    const body = await callGcal("status");
    return {
      connected: body["connected"] === true,
      email: typeof body["email"] === "string" ? body["email"] : "",
      lastPullAt: typeof body["lastPullAt"] === "string" ? body["lastPullAt"] : null,
      syncEnabled: body["syncEnabled"] !== false,
      calendarId: typeof body["calendarId"] === "string" && body["calendarId"] !== ""
        ? (body["calendarId"] as string)
        : "primary",
    };
  } catch (err: unknown) {
    // Sin conexión o sin configurar: el calendario sigue funcionando solo.
    if (err instanceof GcalError && (err.code === "not_configured" || err.code === "no_config")) {
      return offline;
    }
    throw err;
  }
}

/** URL de consentimiento OAuth de Google (redirige fuera de la app). */
export async function authUrlGcal(): Promise<string> {
  const body = await callGcal("auth-url");
  const url = typeof body["url"] === "string" ? body["url"] : null;
  if (url === null) {
    throw new GcalError("no_url", "Google no devolvió la URL de conexión.");
  }
  return url;
}

/** Intercambia el ?code= de vuelta de Google por la conexión guardada. */
export async function exchangeGcal(code: string): Promise<string> {
  const clean = code.trim();
  if (clean === "") {
    throw new GcalError("bad_code", "Falta el código de Google. Vuelve a conectar.");
  }
  const body = await callGcal("exchange", { code: clean });
  return typeof body["email"] === "string" ? body["email"] : "";
}

/** Desconecta Google (borra la conexión del usuario). */
export async function disconnectGcal(): Promise<void> {
  await callGcal("disconnect");
}

/** Importa de Google al espacio actual (próximos 30 días). */
export async function pullGcal(): Promise<GcalPullResult> {
  const body = await callGcal("pull");
  return {
    imported: asCount(body["imported"]),
    updated: asCount(body["updated"]),
    removed: asCount(body["removed"]),
    fetched: asCount(body["fetched"]),
  };
}

/** Sube un evento Loki a Google (crea o actualiza el espejo). No-op si falla. */
export async function pushGcal(eventId: string): Promise<string | null> {
  if (eventId.trim() === "") return null;
  const body = await callGcal("push", { eventId });
  return typeof body["externalId"] === "string" ? body["externalId"] : null;
}

/** Borra el espejo en Google al borrar en Loki. Nunca lanza. */
export async function unpushGcal(externalId: string): Promise<void> {
  if (externalId.trim() === "") return;
  try {
    await callGcal("unpush", { externalId });
  } catch {
    // Best effort: el borrado local ya ocurrió; Google se limpia en el
    // próximo pull si quedó huérfano.
  }
}
