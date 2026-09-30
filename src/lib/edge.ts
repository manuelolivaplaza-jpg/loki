"use client";

/**
 * Cabeceras para las Edge Functions de Supabase.
 *
 * Los proyectos nuevos exigen JWT en el gateway (`401` sin credencial),
 * así que todo llamado a `/functions/v1/*` manda la publishable key
 * (pública por diseño; el aislamiento lo pone la RLS + el JWT de sesión).
 */

/** Publishable key pública del cliente (vacía si falta el env). */
export function edgeApiKey(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
}

/** Cabeceras base + `authorization` solo si hay token de sesión. */
export function edgeHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    apikey: edgeApiKey(),
  };
  if (token !== undefined && token !== "") {
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}
