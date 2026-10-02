/**
 * RLS del compañero de escritorio (etapa 3): user_devices, device_pair_codes,
 * device_commands y device_audit_log.
 *
 * - El dueño ve y gestiona lo suyo; nadie más ve filas (lectura denegada =
 *   lista vacía, como en el resto de la casa).
 * - `credential_hash` tiene REVOKE a nivel de columna: ni el dueño lo lee.
 * - Todo el ciclo pasa por RPC (sin escrituras directas): pedir, confirmar,
 *   reclamar y reportar. Un usuario no pide ni confirma en PCs ajenos; un
 *   dispositivo solo ve y mueve sus propios comandos.
 * - Revocar bloquea al instante (el dispositivo deja de verlo todo).
 * - Ritmo: 10 comandos/min por PC.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { createClient } from "@supabase/supabase-js";

import {
  RUN_ID,
  adminClient,
  anonClient,
  assertAllowed,
  assertNoRows,
  createTestUser,
  localEnv,
  purgeTestData,
} from "./_helpers.mjs";

const DEVICE_COLUMNS =
  "id, owner_id, name, platform, app_version, allowed_actions, readable_dirs, can_send_files, allow_arbitrary, revoked_at, last_seen_at, created_at, updated_at";
const COMMAND_COLUMNS =
  "id, device_id, status, action, risk, result_text, created_at";

const FAKE_HASH =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

async function makeDeviceUser(tag, password) {
  const admin = adminClient();
  const email = `rls-loki-test-device-${RUN_ID}-${tag}@loki.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email} falló: ${error.message}`);
  return { id: data.user.id, email, password };
}

async function signInAs(email, password) {
  const { url, anonKey } = localEnv();
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn ${email} falló: ${error.message}`);
  await client.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  return client;
}

async function makeDevice(admin, ownerId, authUserId, name = "PC de prueba") {
  const { data, error } = await admin
    .from("user_devices")
    .insert({
      owner_id: ownerId,
      name,
      platform: "linux",
      app_version: "0.0.1",
      credential_hash: FAKE_HASH,
    })
    .select("id")
    .single();
  if (error) throw error;
  const { error: mapError } = await admin
    .from("device_auth_users")
    .insert({ device_id: data.id, auth_user_id: authUserId });
  if (mapError) throw mapError;
  return data.id;
}

describe("compañero de escritorio (RLS)", () => {
  let owner;
  let outsider;
  let admin;
  let deviceId;
  let otherDeviceId;
  let deviceClient;
  let otherDeviceClient;

  before(async () => {
    await purgeTestData();
    owner = await createTestUser("dev-owner", "Dueña PC");
    outsider = await createTestUser("dev-out", "Ajeno");
    admin = adminClient();

    const d1 = await makeDeviceUser("d1", "PC-secreto-largo-01");
    const d2 = await makeDeviceUser("d2", "PC-secreto-largo-02");
    deviceId = await makeDevice(admin, owner.id, d1.id, "PC de la dueña");
    otherDeviceId = await makeDevice(admin, owner.id, d2.id, "Segundo PC");
    deviceClient = await signInAs(d1.email, d1.password);
    otherDeviceClient = await signInAs(d2.email, d2.password);
  });

  after(async () => {
    await purgeTestData();
  });

  it("el dueño ve sus PCs y nadie más", async () => {
    const mine = await owner.client
      .from("user_devices")
      .select(DEVICE_COLUMNS)
      .eq("id", deviceId);
    assertAllowed(mine, "leer PC propio");
    assert.equal(mine.data.length, 1, "el dueño ve su PC");

    const foreign = await outsider.client
      .from("user_devices")
      .select(DEVICE_COLUMNS)
      .eq("id", deviceId);
    assertNoRows(foreign.data, "el ajeno no ve PCs ajenos");

    const anon = await anonClient().from("user_devices").select(DEVICE_COLUMNS);
    assertNoRows(anon.data, "sin sesión no se ve nada");
  });

  it("el dispositivo ve su ficha y nadie más la suya", async () => {
    const mine = await deviceClient
      .from("user_devices")
      .select(DEVICE_COLUMNS)
      .eq("id", deviceId);
    assertAllowed(mine, "el PC ve su ficha");
    assert.equal(mine.data.length, 1, "el PC ve su ficha");

    const foreign = await deviceClient
      .from("user_devices")
      .select(DEVICE_COLUMNS)
      .eq("id", otherDeviceId);
    assertNoRows(foreign.data, "el PC no ve otros PCs");
  });

  it("el hash del secreto nunca vuelve al cliente", async () => {
    const leaked = await owner.client
      .from("user_devices")
      .select("id, credential_hash")
      .eq("id", deviceId);
    assert.ok(
      leaked.error,
      "leer credential_hash debe fallar por REVOKE de columna",
    );
  });

  it("códigos de vinculación: solo el dueño ve los suyos", async () => {
    const code = await owner.client.rpc("create_device_pair_code", { p_name: "PC" });
    assertAllowed(code, "crear código propio");
    assert.match(code.data, /^[A-Z2-9]{6}$/, "código corto de 6");

    const mine = await owner.client.from("device_pair_codes").select("id, code");
    assert.ok((mine.data ?? []).length >= 1, "el dueño ve sus códigos");

    const foreign = await outsider.client
      .from("device_pair_codes")
      .select("id, code")
      .eq("code", code.data);
    assertNoRows(foreign.data, "el ajeno no ve códigos ajenos");
  });

  it("pedir: el dueño sí, el ajeno no", async () => {
    const ok = await owner.client.rpc("request_device_command", {
      p_device_id: deviceId,
      p_action: "pc_status",
      p_params: {},
      p_workspace_id: null,
      p_chat_id: "",
      p_message_id: null,
    });
    assertAllowed(ok, "pedir estado al PC propio");
    assert.equal(ok.data.status, "queued", "pc_status va directo (info)");

    const sensible = await owner.client.rpc("request_device_command", {
      p_device_id: deviceId,
      p_action: "send_file",
      p_params: { text: "informe.pdf", dir: "" },
      p_workspace_id: null,
      p_chat_id: "",
      p_message_id: null,
    });
    assertAllowed(sensible, "pedir envío de archivo");
    assert.equal(
      sensible.data.status,
      "pending_confirmation",
      "lo sensible espera aprobación",
    );

    const foreign = await outsider.client.rpc("request_device_command", {
      p_device_id: deviceId,
      p_action: "pc_status",
      p_params: {},
      p_workspace_id: null,
      p_chat_id: "",
      p_message_id: null,
    });
    assert.ok(foreign.error, "el ajeno no ordena PCs ajenos");
  });

  it("confirmar: solo el dueño y dentro del plazo", async () => {
    const pending = await owner.client.rpc("request_device_command", {
      p_device_id: deviceId,
      p_action: "run_script",
      p_params: { text: "respaldo" },
      p_workspace_id: null,
      p_chat_id: "",
      p_message_id: null,
    });
    assertAllowed(pending, "pedir script");
    const cmdId = pending.data.id;

    const foreign = await outsider.client.rpc("confirm_device_command", {
      p_command_id: cmdId,
      p_ok: true,
    });
    assert.ok(foreign.error, "el ajeno no confirma");

    const approved = await owner.client.rpc("confirm_device_command", {
      p_command_id: cmdId,
      p_ok: true,
    });
    assertAllowed(approved, "el dueño aprueba");
    assert.equal(approved.data, true, "aprobado");

    const again = await owner.client
      .from("device_commands")
      .select(COMMAND_COLUMNS)
      .eq("id", cmdId)
      .single();
    assert.equal(again.data.status, "queued", "aprobado vuelve a la cola");
  });

  it("el dispositivo reclama y reporta lo suyo (doble control)", async () => {
    const pending = await owner.client.rpc("request_device_command", {
      p_device_id: deviceId,
      p_action: "screenshot",
      p_params: {},
      p_workspace_id: null,
      p_chat_id: "",
      p_message_id: null,
    });
    const cmdId = pending.data.id;

    // Sin reclamar confirmación pendiente: el PC no la toma.
    const unconfirmed = await owner.client.rpc("request_device_command", {
      p_device_id: deviceId,
      p_action: "send_file",
      p_params: { text: "a.pdf", dir: "" },
      p_workspace_id: null,
      p_chat_id: "",
      p_message_id: null,
    });
    const unconfirmedClaim = await deviceClient.rpc("device_claim_command", {
      p_command_id: unconfirmed.data.id,
    });
    assert.ok(unconfirmedClaim.error, "sin confirmación el PC no ejecuta");

    const claimed = await deviceClient.rpc("device_claim_command", {
      p_command_id: cmdId,
    });
    assertAllowed(claimed, "el PC reclama lo suyo");
    assert.equal(claimed.data.action, "screenshot", "recibe qué ejecutar");

    const foreignClaim = await otherDeviceClient.rpc("device_claim_command", {
      p_command_id: cmdId,
    });
    assert.ok(foreignClaim.error, "otro PC no reclama lo ajeno");

    const reported = await deviceClient.rpc("device_report_result", {
      p_command_id: cmdId,
      p_ok: true,
      p_result_text: "Listo.",
      p_result_path: null,
      p_result_mime: "",
    });
    assertAllowed(reported, "el PC reporta");

    const seen = await owner.client
      .from("device_commands")
      .select(COMMAND_COLUMNS)
      .eq("id", cmdId)
      .single();
    assert.equal(seen.data.status, "done", "el dueño ve el resultado");
  });

  it("el dispositivo solo ve sus comandos y no escribe directo", async () => {
    const mine = await deviceClient
      .from("device_commands")
      .select(COMMAND_COLUMNS)
      .eq("device_id", deviceId);
    assertAllowed(mine, "el PC lee sus comandos");
    assert.ok((mine.data ?? []).length >= 1, "ve los suyos");

    const direct = await deviceClient.from("device_commands").insert({
      device_id: deviceId,
      owner_id: owner.id,
      action: "pc_status",
      params: {},
      risk: "info",
    });
    assert.ok(direct.error, "sin escrituras directas ni del PC");
  });

  it("ritmo: más de 10 por minuto se rechaza", async () => {
    // Limpia comandos recientes del otro PC para medir solo este.
    for (let i = 0; i < 10; i += 1) {
      await otherDeviceClient.rpc("device_heartbeat", {
        p_device_id: otherDeviceId,
        p_app_version: "0.0.1",
        p_platform: "linux",
      });
      const res = await owner.client.rpc("request_device_command", {
        p_device_id: otherDeviceId,
        p_action: "pc_status",
        p_params: {},
        p_workspace_id: null,
        p_chat_id: "",
        p_message_id: null,
      });
      if (res.error) break;
    }
    const extra = await owner.client.rpc("request_device_command", {
      p_device_id: otherDeviceId,
      p_action: "pc_status",
      p_params: {},
      p_workspace_id: null,
      p_chat_id: "",
      p_message_id: null,
    });
    assert.ok(extra.error, "el comando 11 en un minuto se rechaza");
  });

  it("auditoría: el dueño lee, nadie escribe ni ve lo ajeno", async () => {
    const mine = await owner.client
      .from("device_audit_log")
      .select("id, action, detail, created_at")
      .eq("device_id", deviceId)
      .limit(5);
    assertAllowed(mine, "el dueño lee su auditoría");
    assert.ok((mine.data ?? []).length >= 1, "hay movimientos registrados");

    const foreign = await outsider.client
      .from("device_audit_log")
      .select("id")
      .eq("device_id", deviceId);
    assertNoRows(foreign.data, "el ajeno no ve auditoría ajena");

    const written = await owner.client.from("device_audit_log").insert({
      device_id: deviceId,
      owner_id: owner.id,
      action: "done",
      detail: "truco",
    });
    assert.ok(written.error, "auditoría inmutable: sin escrituras directas");
  });

  it("tipo device: la notificación de aprobación existe y avisa", async () => {
    const { error } = await admin.from("notifications").insert({
      user_id: owner.id,
      type: "device",
      title: "Tu PC necesita tu aprobación",
      body: "Abre Loki para revisar la orden.",
      link: "/dispositivos/aprobar?cmd=x",
    });
    assert.equal(error, null, "el tipo device pasa el CHECK");
    const { error: bad } = await admin.from("notifications").insert({
      user_id: owner.id,
      type: "nave",
      title: "x",
      body: "x",
    });
    assert.ok(bad, "tipos inventados siguen rechazados");
  });

  it("revocar bloquea al instante", async () => {
    const revoked = await owner.client.rpc("revoke_device", {
      p_device_id: deviceId,
    });
    assertAllowed(revoked, "revocar lo propio");

    const blind = await deviceClient
      .from("device_commands")
      .select(COMMAND_COLUMNS)
      .eq("device_id", deviceId);
    assertNoRows(blind.data, "revocado: el PC ya no ve nada");

    const beat = await deviceClient.rpc("device_heartbeat", {
      p_device_id: deviceId,
      p_app_version: "0.0.1",
      p_platform: "linux",
    });
    assert.ok(beat.error, "revocado: el latido se rechaza");
  });
});
