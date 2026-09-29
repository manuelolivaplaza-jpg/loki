/**
 * Utilidades compartidas por los tests de RLS (tests/rls/*.test.mjs).
 *
 * Reglas de la casa:
 *   · Los usuarios se crean de VERDAD con `auth.signUp` contra el Auth local
 *     (no se falsea el JWT): así se prueba el camino real que usa la app.
 *   · El cliente con service role solo prepara y limpia datos: sembrar mensajes
 *     que el cliente no podría crear (por ejemplo type 'ai') y limpiar entre
 *     corridas. Nunca se usa para "simular" un permiso que debería tener un
 *     usuario.
 *   · Cada corrida usa emails únicos (LOKI_TEST_RUN_ID, lo pasa
 *     scripts/test-rls.mjs) para poder repetir tests sin arrastrar usuarios.
 */

import assert from "node:assert";
import { createClient } from "@supabase/supabase-js";

import { supabaseStatusEnv } from "../../scripts/supabase.mjs";

/** Prefijo de los correos de prueba: permite purgarlos entre corridas. */
export const EMAIL_PREFIX = "rls-loki-test";

/** Prefijo de los espacios de prueba: permite purgarlos en cascada. */
export const WORKSPACE_PREFIX = "RLS Test";

/**
 * Identificador de corrida. Lo inyecta scripts/test-rls.mjs para que los
 * distintos archivos (que corren en procesos separados) no se pisen los correos.
 */
export const RUN_ID =
  process.env.LOKI_TEST_RUN_ID ??
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const PASSWORD = "Loki-Rls-1234";

let cachedEnv = null;

/** Lee URL, anon key y service_role key de `supabase status -o env`. */
export function localEnv() {
  if (cachedEnv) return cachedEnv;
  const env = supabaseStatusEnv();
  // scripts/test-rls.mjs ya las dejo en el entorno; si se ejecuta un archivo
  // suelto (node --test tests/rls/x.test.mjs) se leen del CLI.
  const url = process.env.LOKI_SUPABASE_URL ?? env.API_URL ?? "http://127.0.0.1:54321";
  const anonKey =
    process.env.LOKI_SUPABASE_ANON_KEY ?? env.ANON_KEY ?? env.PUBLISHABLE_KEY;
  const serviceKey =
    process.env.LOKI_SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY ?? env.SECRET_KEY;
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      "Faltan claves del Supabase local. Arranca con `npm run sb:start` y mira `npm run sb:status -o env`.",
    );
  }
  cachedEnv = { url, anonKey, serviceKey };
  return cachedEnv;
}

function baseClient(key) {
  const { url } = localEnv();
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Cliente sin sesión (rol `anon` de PostgREST). */
export function anonClient() {
  return baseClient(localEnv().anonKey);
}

/** Cliente con service role: ignora RLS. Solo para sembrar y limpiar. */
export function adminClient() {
  return baseClient(localEnv().serviceKey);
}

/**
 * Crea un usuario real con signUp y devuelve su cliente ya autenticado.
 * `displayName` va en raw_user_meta_data, que es de donde el trigger
 * `handle_new_user` saca el display_name del perfil.
 */
export async function createTestUser(tag, displayName) {
  const email = `${EMAIL_PREFIX}-${RUN_ID}-${tag}@loki.test`;
  const client = anonClient();
  const { data, error } = await client.auth.signUp({
    email,
    password: PASSWORD,
    options: { data: { display_name: displayName ?? `Usuario ${tag}` } },
  });
  if (error) {
    throw new Error(`signUp de ${email} fallo: ${error.message}`);
  }
  if (!data.session) {
    throw new Error(
      `signUp de ${email} no devolvio sesion. Revisa [auth.email] enable_confirmations=false en supabase/config.toml.`,
    );
  }
  return { id: data.user.id, email, password: PASSWORD, client, user: data.user };
}

/**
 * Borra lo que dejaron corridas anteriores: usuarios de prueba (y en cascada
 * sus perfiles, membresías, chats de IA y tokens) y espacios de prueba (que se
 * llevan chats, mensajes, reacciones y leídos).
 */
export async function purgeTestData() {
  const admin = adminClient();

  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const stale = data.users.filter((user) => (user.email ?? "").startsWith(EMAIL_PREFIX));
    for (const user of stale) {
      const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
      if (deleteError) throw deleteError;
    }
    if (data.users.length < 200) break;
  }

  const { error: workspaceError } = await admin
    .from("workspaces")
    .delete()
    .like("name", `${WORKSPACE_PREFIX}%`);
  if (workspaceError) throw workspaceError;
}

/** Nombre de espacio de prueba (siempre dentro del límite de 40 caracteres). */
export function workspaceName(suffix) {
  return `${WORKSPACE_PREFIX} ${suffix}`;
}

/** Crea un espacio con la RPC y devuelve su id (o propaga el error). */
export async function createWorkspaceWith(client, name, emoji = "🏠") {
  const { data, error } = await client.rpc("create_workspace", {
    p_name: name,
    p_emoji: emoji,
  });
  if (error) throw new Error(`create_workspace fallo: ${error.message}`);
  return data;
}

/** Da de alta a un usuario como miembro con la service role. */
export async function addMember(admin, workspaceId, userId, role = "member", displayName = "Miembro") {
  const { error } = await admin
    .from("workspace_members")
    .insert({ workspace_id: workspaceId, user_id: userId, role, display_name: displayName });
  if (error) throw error;
}

/** Payload de mensaje equivalente al que usa la app hoy. */
export function messagePayload(overrides = {}) {
  return {
    text: "hola",
    type: "user",
    mentions: [],
    reply_to: null,
    thread_parent_id: null,
    thread_count: 0,
    last_reply_at: null,
    attachments: [],
    edited_at: null,
    deleted: false,
    ...overrides,
  };
}

// --- aserciones -------------------------------------------------------------

/** Una escritura denegada por RLS llega como `error`, no como excepción. */
export function assertDenied(result, message) {
  assert.ok(
    result.error,
    `${message}: se esperaba un error de RLS pero la escritura paso (data=${JSON.stringify(result.data)})`,
  );
}

/** Una escritura permitida llega sin `error`. */
export function assertAllowed(result, message) {
  assert.equal(
    result.error,
    null,
    `${message}: se esperaba exito pero llego error "${result.error?.message ?? ""}"`,
  );
}

/**
 * En RLS una lectura denegada no da error: PostgREST devuelve la lista vacía.
 * Es la diferencia clave con las reglas de Firestore.
 */
export function assertNoRows(data, message) {
  assert.equal((data ?? []).length, 0, `${message}: se esperaba 0 filas visibles`);
}

/**
 * UPDATE y DELETE sobre filas que la RLS no deja ver NO dan error: affected 0.
 * Por eso "el otro no puede tocar esto" se comprueba por el numero de filas
 * afectadas (con `.select()`) y no por un error.
 * En cambio, un INSERT que viola la WITH CHECK sí devuelve 42501: eso es
 * `assertDenied`.
 */
export function assertNoRowsAffected(result, message) {
  assert.equal(
    result.error,
    null,
    `${message}: se esperaba que la escritura no afectara a nadie, pero hubo error "${result.error?.message ?? ""}"`,
  );
  assert.equal(
    (result.data ?? []).length,
    0,
    `${message}: se esperaba 0 filas afectadas pero se afectaron ${(result.data ?? []).length}`,
  );
}
