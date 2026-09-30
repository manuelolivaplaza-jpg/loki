/**
 * Cliente de Supabase para el navegador (T20).
 *
 * Es el único punto donde se crea el cliente. Supabase Auth guarda la sesión
 * en `localStorage` y la refresca sola, así que el mismo objeto sirve para la
 * web, para el export estático de Capacitor y para el WebView nativo: no hay
 * cookies de servidor, ni `@supabase/ssr`, ni nada que rompa `output: "export"`.
 *
 * Configuración en `.env.local` (gitignored), con las claves de
 * `npm run sb:status`:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY de sb:status>
 *
 * Solo va la clave pública. El aislamiento lo pone la RLS del servidor; la
 * `service_role` nunca se manda al cliente.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

/** Nombres de las variables que createClient necesita. */
export const SUPABASE_ENV_KEYS = {
  url: "NEXT_PUBLIC_SUPABASE_URL",
  anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
} as const;

/** Mensaje que ve Manu si falta la configuración. */
export const SUPABASE_CONFIG_ERROR =
  "Falta la configuración de Supabase. Copia NEXT_PUBLIC_SUPABASE_URL y " +
  "NEXT_PUBLIC_SUPABASE_ANON_KEY de `npm run sb:status` a .env.local y reinicia.";

type SupabaseGlobal = typeof globalThis & {
  __loki_supabase_client__?: SupabaseClient<Database>;
};

function globalFlags(): SupabaseGlobal {
  return globalThis as SupabaseGlobal;
}

/**
 * ¿Hay URL y clave pública? Lo consulta `AuthListener` para poder avisar en
 * pantalla en vez de reventar el arranque con un error de módulo.
 */
export function isSupabaseConfigured(): boolean {
  return (
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim() !== "" &&
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim() !== ""
  );
}

/**
 * Cliente único de Supabase con los tipos del esquema.
 *
 * Lanza un error en español y legible si faltan las variables de entorno: es
 * mejor que fallar al importar el módulo (lo dejaría como "cannot read
 * properties of undefined createClient" en mitad del render).
 */
export function getSupabaseClient(): SupabaseClient<Database> {
  const flags = globalFlags();
  if (flags.__loki_supabase_client__ !== undefined) {
    return flags.__loki_supabase_client__;
  }

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  const missing: string[] = [];
  if (url === "") missing.push(SUPABASE_ENV_KEYS.url);
  if (anonKey === "") missing.push(SUPABASE_ENV_KEYS.anonKey);
  if (missing.length > 0) {
    throw new Error(
      `Falta la configuración de Supabase en .env.local: ${missing.join(", ")}. ` +
        "Sácala de `npm run sb:status` (solo URL y clave pública) y reinicia.",
    );
  }

  // Se guarda en globalThis para que el hot reload de `next dev` no abra
  // un cliente nuevo (y con ella, un lock de auth distinto) en cada cambio.
  flags.__loki_supabase_client__ = createClient<Database>(url, anonKey, {
    auth: {
      // Sesión en localStorage: sobrevive a recargas y al WebView de
      // Capacitor, que no tiene cookies de servidor.
      persistSession: true,
      autoRefreshToken: true,
      // Recoge el token de la vuelta de Google (hash o query) al volver.
      detectSessionInUrl: true,
    },
  });
  return flags.__loki_supabase_client__;
}

/**
 * Forma de `/auth/v1/settings`. Según la versión de GoTrue cada proveedor
 * aparece como un booleano (`"google": false`) o como un objeto con `enabled`,
 * así que se aceptan las dos.
 */
type AuthSettings = {
  external?: Record<string, boolean | { enabled?: boolean } | undefined>;
};

/**
 * ¿Está habilitado un proveedor externo (Google) en este entorno?
 *
 * `signInWithOAuth` devuelve la URL del proveedor aunque el proveedor esté
 * apagado: el 400 "Unsupported provider" solo aparece al seguir esa URL, y
 * para entonces la persona ya ha salido de la app a un JSON de error.
 * Consultando `/auth/v1/settings` antes, el botón puede avisar en pantalla y
 * quedarse dentro.
 *
 * Si la consulta falla se asume que SÍ está habilitado: es mejor intentar el
 * acceso que bloquear a alguien por un problema de red pasajero.
 */
export async function isExternalProviderEnabled(
  provider: "google",
): Promise<boolean> {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  if (url === "" || anonKey === "") return false;
  try {
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: anonKey },
    });
    if (!res.ok) return true;
    const settings = (await res.json()) as AuthSettings;
    const entry = settings.external?.[provider];
    if (entry === undefined) return true;
    return typeof entry === "boolean" ? entry : entry.enabled !== false;
  } catch {
    return true;
  }
}
