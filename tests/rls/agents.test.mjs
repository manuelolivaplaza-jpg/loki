/**
 * RLS de agentes personales (agent_connections, agent_space_grants,
 * agent_runs, agent_run_events).
 *
 * - Conexiones: el dueño ve y gestiona lo suyo; nadie más ve filas. Los
 *   secretos (secret_enc, inbound_token_hash) tienen REVOKE a nivel de
 *   columna: ni el dueño puede seleccionarlos ni escribirlos por RLS
 *   directa (solo las Edge con service_role).
 * - Habilitados en mis espacios: los miembros ven lo básico (sin secretos).
 * - Grants: el dueño gestiona; los miembros leen; el admin desactiva vía RPC
 *   sin poder leer ni cambiar la conexión.
 * - Handles: validate_agent_handle rechaza reservados (@Loki), miembros y
 *   agentes ya habilitados en el espacio.
 * - Ejecuciones: pide quien puede invocar (según el grant), siempre a nombre
 *   propio. Lee quien pidió, el dueño, o miembros si el resultado es
 *   público. Sin update/delete de cliente: cancelar es por RPC.
 * - Eventos: se leen con su ejecución; el cliente no escribe.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import {
  addMember,
  adminClient,
  assertAllowed,
  assertDenied,
  assertNoRows,
  assertNoRowsAffected,
  createTestUser,
  createWorkspaceWith,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

const CONNECTION_COLUMNS =
  "id, provider, name, handle, description, avatar_emoji, config, status, last_error, last_used_at, created_at";

async function createConnection(client, { uid, handle, provider = "generic_webhook" }) {
  return client
    .from("agent_connections")
    .insert({
      owner_id: uid,
      provider,
      name: `Bot de ${handle}`,
      handle,
      description: "agente de prueba",
      avatar_emoji: "🤖",
      config: {},
      status: "active",
    })
    .select("id")
    .single();
}

describe("agentes personales (RLS)", () => {
  let owner;
  let member;
  let outsider;
  let wsId;
  let connectionId;
  let grantId;

  before(async () => {
    await purgeTestData();
    owner = await createTestUser("agent-owner", "Dueña Bot");
    member = await createTestUser("agent-member", "Miembro");
    outsider = await createTestUser("agent-out", "Ajeno");
    wsId = await createWorkspaceWith(owner.client, workspaceName("agents"));
    const admin = adminClient();
    await addMember(admin, wsId, member.id, "member", "Miembro");
  });

  after(async () => {
    await purgeTestData();
  });

  it("el dueño crea su conexión y la lee sin secretos", async () => {
    const created = await createConnection(owner.client, {
      uid: owner.id,
      handle: "mi-bot",
    });
    assertAllowed(created, "crear conexión propia");
    connectionId = created.data.id;

    const read = await owner.client
      .from("agent_connections")
      .select(CONNECTION_COLUMNS)
      .eq("id", connectionId);
    assertAllowed(read, "leer conexión propia");
    assert.equal(read.data.length, 1, "el dueño ve su conexión");

    // Ni el dueño puede seleccionar los secretos (REVOKE a nivel de columna).
    const secrets = await owner.client
      .from("agent_connections")
      .select("id, secret_enc, inbound_token_hash")
      .eq("id", connectionId);
    assert.ok(
      secrets.error,
      "leer secret_enc/inbound_token_hash debe fallar incluso al dueño",
    );
  });

  it("nadie crea conexiones a nombre de otro", async () => {
    const forged = await createConnection(member.client, {
      uid: owner.id,
      handle: "bot-falso",
    });
    assertDenied(forged, "crear conexión con otro owner_id");
  });

  it("un miembro no ve la conexión ajena sin grant", async () => {
    const read = await member.client
      .from("agent_connections")
      .select(CONNECTION_COLUMNS)
      .eq("id", connectionId);
    assertAllowed(read, "select permitido por RLS (0 filas)");
    assertNoRows(read.data, "miembro sin grant no ve la conexión");
  });

  it("un miembro no edita ni borra lo ajeno", async () => {
    const updated = await member.client
      .from("agent_connections")
      .update({ name: "hack" })
      .eq("id", connectionId)
      .select("id");
    assertNoRowsAffected(updated, "miembro no edita conexión ajena");

    const deleted = await member.client
      .from("agent_connections")
      .delete()
      .eq("id", connectionId)
      .select("id");
    assertNoRowsAffected(deleted, "miembro no borra conexión ajena");
  });

  it("el dueño no escribe secretos por RLS directa", async () => {
    const updated = await owner.client
      .from("agent_connections")
      .update({ secret_enc: "claro" })
      .eq("id", connectionId);
    assert.ok(updated.error, "escribir secret_enc debe fallar (sin GRANT)");
  });

  it("validate_agent_handle cuida @Loki, miembros y duplicados", async () => {
    async function check(client, handle, ignore = null) {
      const { data, error } = await client.rpc("validate_agent_handle", {
        p_workspace_id: wsId,
        p_handle: handle,
        p_ignore_connection_id: ignore,
      });
      assert.equal(error, null, `validate_agent_handle(${handle}) sin error`);
      return data;
    }
    assert.equal(await check(owner.client, "loki"), false, "@Loki reservado");
    assert.equal(await check(owner.client, "@Loki"), false, "@Loki con arroba");
    assert.equal(
      await check(owner.client, "Miembro"),
      false,
      "choca con un miembro del espacio",
    );

    // Sin grant, el handle está libre (aún no habilitado en el espacio).
    assert.equal(await check(owner.client, "mi-bot"), true, "handle libre sin grant");

    // El dueño habilita su agente solo para él.
    const grant = await owner.client
      .from("agent_space_grants")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        allowed_callers: "owner_only",
      })
      .select("id")
      .single();
    assertAllowed(grant, "crear grant propio");
    grantId = grant.data.id;

    assert.equal(
      await check(owner.client, "mi-bot"),
      false,
      "duplicado en el mismo espacio",
    );
    assert.equal(
      await check(owner.client, "mi-bot", connectionId),
      true,
      "mi propia conexión no choca al editar",
    );
  });

  it("grants: el dueño gestiona, los miembros solo leen", async () => {
    const read = await member.client
      .from("agent_space_grants")
      .select("id, allowed_callers")
      .eq("workspace_id", wsId);
    assertAllowed(read, "miembro lee grants de su espacio");
    assert.equal(read.data.length, 1, "ve el grant habilitado");

    const forged = await member.client
      .from("agent_space_grants")
      .insert({ connection_id: connectionId, workspace_id: wsId });
    assertDenied(forged, "miembro no crea grants ajenos");

    const out = await outsider.client
      .from("agent_space_grants")
      .select("id")
      .eq("workspace_id", wsId);
    assertAllowed(out, "select de ajeno permitido (0 filas)");
    assertNoRows(out.data, "ajeno no ve grants");
  });

  it("ejecuciones: pide quien puede invocar, a nombre propio", async () => {
    // owner_only: el miembro no puede pedir.
    const denied = await member.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "hola bot",
      })
      .select("id");
    assertDenied(denied, "miembro sin permiso no pide ejecuciones");

    // A nombre de otro, tampoco el dueño.
    const forged = await owner.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "hola bot",
      })
      .select("id");
    assertDenied(forged, "no se pide a nombre de otro");

    // El dueño sí (ping de prueba).
    const ping = await owner.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: owner.id,
        kind: "ping",
        idempotency_key: `ping:${connectionId}:1`,
      })
      .select("id");
    assertAllowed(ping, "el dueño prueba su agente");
  });

  it("ejecuciones: al abrir el grant, el miembro pide y lee; el ajeno no", async () => {
    const opened = await owner.client
      .from("agent_space_grants")
      .update({ allowed_callers: "space_members" })
      .eq("id", grantId);
    assertAllowed(opened, "abrir el grant a miembros");

    const run = await member.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "revísame esto",
        idempotency_key: `task:${connectionId}:m1`,
      })
      .select("id")
      .single();
    assertAllowed(run, "miembro con permiso pide ejecución");
    const runId = run.data.id;

    // run_token_hash nunca se selecciona (REVOKE de columna).
    const hashed = await member.client
      .from("agent_runs")
      .select("id, run_token_hash")
      .eq("id", runId);
    assert.ok(hashed.error, "run_token_hash no se selecciona");

    // El ajeno no pide ni lee.
    const outRun = await outsider.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: outsider.id,
        kind: "task",
        instruction: "hola",
      })
      .select("id");
    assertDenied(outRun, "ajeno no pide ejecuciones");

    const outRead = await outsider.client
      .from("agent_runs")
      .select("id, status")
      .eq("id", runId);
    assertAllowed(outRead, "select de ajeno permitido (0 filas)");
    assertNoRows(outRead.data, "ajeno no lee ejecuciones");
  });

  it("resultados privados: solo quien pidió y el dueño", async () => {
    const closed = await owner.client
      .from("agent_space_grants")
      .update({ allow_publish: false })
      .eq("id", grantId);
    assertAllowed(closed, "resultado privado");

    const run = await member.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "privado",
        idempotency_key: `task:${connectionId}:m2`,
      })
      .select("id")
      .single();
    assertAllowed(run, "pedir en modo privado");
    const runId = run.data.id;

    const mine = await member.client
      .from("agent_runs")
      .select("id, status")
      .eq("id", runId);
    assert.equal(mine.data.length, 1, "quien pidió lee su ejecución privada");

    const other = await createTestUser("agent-other", "Otro");
    const admin = adminClient();
    await addMember(admin, wsId, other.id, "member", "Otro");
    const otherRead = await other.client
      .from("agent_runs")
      .select("id, status")
      .eq("id", runId);
    assertAllowed(otherRead, "select permitido (0 filas)");
    assertNoRows(otherRead.data, "otro miembro no lee lo privado");

    const ownerRead = await owner.client
      .from("agent_runs")
      .select("id, status")
      .eq("id", runId);
    assert.equal(ownerRead.data.length, 1, "el dueño sí lee lo privado");

    // Se reabre para los tests siguientes.
    await owner.client
      .from("agent_space_grants")
      .update({ allow_publish: true })
      .eq("id", grantId);
  });

  it("eventos: se leen con su ejecución; el cliente no escribe", async () => {
    const admin = adminClient();
    const run = await admin
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "con eventos",
        status: "running",
        idempotency_key: `task:${connectionId}:m3`,
      })
      .select("id")
      .single();
    assert.equal(run.error, null, "sembrar ejecución con service role");
    const runId = run.data.id;
    const seeded = await admin.from("agent_run_events").insert({
      run_id: runId,
      seq: 0,
      type: "progress",
      text: "trabajando",
    });
    assert.equal(seeded.error, null, "sembrar evento con service role");

    const seen = await member.client
      .from("agent_run_events")
      .select("id, type, text")
      .eq("run_id", runId);
    assertAllowed(seen, "miembro lee eventos públicos");
    assert.equal(seen.data.length, 1, "ve el progreso en vivo");

    const written = await member.client.from("agent_run_events").insert({
      run_id: runId,
      seq: 1,
      type: "progress",
      text: "falso",
    });
    assertDenied(written, "el cliente no escribe eventos");

    // agent_runs no tiene GRANT UPDATE para el cliente (ni update ni delete:
    // el ciclo lo mueven las Edges y cancelar es por RPC), así que el UPDATE
    // se deniega con error en vez de afectar 0 filas.
    const moved = await member.client
      .from("agent_runs")
      .update({ status: "done" })
      .eq("id", runId)
      .select("id");
    assertDenied(moved, "el cliente no mueve estados");
  });

  it("cancelar: quien pidió o el dueño; el resto no", async () => {
    const run = await member.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "cancélame",
        idempotency_key: `task:${connectionId}:m4`,
      })
      .select("id")
      .single();
    assertAllowed(run, "pedir para cancelar");
    const runId = run.data.id;

    const outsiderCancel = await outsider.client.rpc("request_agent_run_cancel", {
      p_run_id: runId,
    });
    assert.ok(outsiderCancel.error, "ajeno no cancela");

    const ownerCancel = await owner.client.rpc("request_agent_run_cancel", {
      p_run_id: runId,
    });
    assertAllowed(ownerCancel, "el dueño cancela");
    assert.equal(ownerCancel.data, true, "cancelación efectiva");
  });

  it("gobernanza: el admin desactiva sin ver ni tocar la conexión", async () => {
    const admin = adminClient();
    const promoted = await admin
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", wsId)
      .eq("user_id", member.id);
    assert.equal(promoted.error, null, "promover a admin con service role");

    const disabled = await member.client.rpc("set_agent_grant_admin_disabled", {
      p_grant_id: grantId,
      p_disabled: true,
    });
    assertAllowed(disabled, "admin desactiva el grant");
    assert.equal(disabled.data, true, "desactivación efectiva");

    // Desactivado: ni el dueño invoca en ese espacio (vuelve a habilitar
    // después para no afectar otros tests).
    const blocked = await owner.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: owner.id,
        kind: "task",
        instruction: "bloqueado",
      })
      .select("id");
    assertDenied(blocked, "con grant desactivado nadie invoca");

    // Pero el admin no lee ni edita la conexión.
    const read = await member.client
      .from("agent_connections")
      .select(CONNECTION_COLUMNS)
      .eq("id", connectionId);
    assertAllowed(read, "select permitido (0 filas)");
    assertNoRows(read.data, "admin no lee la conexión ajena");

    const touched = await member.client
      .from("agent_connections")
      .update({ name: "hack admin" })
      .eq("id", connectionId)
      .select("id");
    assertNoRowsAffected(touched, "admin no edita la conexión ajena");

    const back = await member.client.rpc("set_agent_grant_admin_disabled", {
      p_grant_id: grantId,
      p_disabled: false,
    });
    assertAllowed(back, "admin reactiva el grant");
  });
});
