/**
 * RLS de agentes en el chat (prompt 13: @handle, tarjeta y continuaciones).
 *
 * - Mensajes tipo `agent`: solo la service role (el cliente recibe denegado).
 * - agent_runs con message_id: se pide con la mención (idempotency
 *   `msg:<messageId>:<connectionId>`), se lee con las columnas nuevas.
 * - agent_continue_run: solo quien invocó (o el dueño) continúa un
 *   needs_input; el resto recibe error y un estado distinto no continúa.
 * - expire_agent_runs: interna de pg_cron (sin EXECUTE para authenticated).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";

import {
  addMember,
  adminClient,
  assertAllowed,
  assertDenied,
  assertNoRows,
  createTestUser,
  createWorkspaceWith,
  messagePayload,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

describe("agentes en el chat (RLS)", () => {
  let owner;
  let member;
  let outsider;
  let wsId;
  let connectionId;
  let messageId;

  before(async () => {
    await purgeTestData();
    owner = await createTestUser("agchat-owner", "Dueña Bot");
    member = await createTestUser("agchat-member", "Miembro");
    outsider = await createTestUser("agchat-out", "Ajeno");
    wsId = await createWorkspaceWith(owner.client, workspaceName("agents chat"));
    const admin = adminClient();
    await addMember(admin, wsId, member.id, "member", "Miembro");

    const created = await owner.client
      .from("agent_connections")
      .insert({
        owner_id: owner.id,
        provider: "generic_webhook",
        name: "Bot de mi-bot",
        handle: "mi-bot",
        description: "agente de prueba",
        avatar_emoji: "🤖",
        config: {},
        status: "active",
      })
      .select("id")
      .single();
    assert.equal(created.error, null, "crear conexión de prueba");
    connectionId = created.data.id;

    const grant = await owner.client
      .from("agent_space_grants")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        allowed_callers: "space_members",
      })
      .select("id")
      .single();
    assert.equal(grant.error, null, "grant abierto a miembros");

    const message = await member.client
      .from("messages")
      .insert({
        workspace_id: wsId,
        chat_id: "general",
        author_id: member.id,
        author_name: "Miembro",
        ...messagePayload({ text: "@mi-bot revisa el presupuesto" }),
      })
      .select("id")
      .single();
    assert.equal(message.error, null, "mensaje que invoca al bot");
    messageId = message.data.id;
  });

  after(async () => {
    await purgeTestData();
  });

  it("el cliente no escribe mensajes tipo agent", async () => {
    const forged = await member.client
      .from("messages")
      .insert({
        workspace_id: wsId,
        chat_id: "general",
        author_id: member.id,
        author_name: "Miembro",
        ...messagePayload({ text: "falso", type: "agent" }),
      })
      .select("id");
    assertDenied(forged, "type agent solo service role");
  });

  it("la ejecución lleva message_id y no se duplica por mensaje", async () => {
    const run = await member.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "revisa el presupuesto",
        idempotency_key: `msg:${messageId}:${connectionId}`,
        message_id: messageId,
      })
      .select("id, message_id")
      .single();
    assertAllowed(run, "pedir con message_id");
    assert.equal(run.data.message_id, messageId, "vínculo mensaje ↔ ejecución");

    const dupe = await member.client
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "revisa el presupuesto",
        idempotency_key: `msg:${messageId}:${connectionId}`,
        message_id: messageId,
      })
      .select("id");
    assertDenied(dupe, "una mención no despierta dos veces");
  });

  it("continuar un needs_input: solo quien invocó (o el dueño)", async () => {
    const admin = adminClient();
    const seeded = await admin
      .from("agent_runs")
      .insert({
        connection_id: connectionId,
        workspace_id: wsId,
        chat_id: "general",
        requested_by: member.id,
        kind: "task",
        instruction: "pendiente de aclaración",
        status: "needs_input",
        history: [{ from: "agent", text: "¿qué presupuesto?", at: new Date().toISOString() }],
        idempotency_key: `task:needs-input:1`,
        message_id: messageId,
      })
      .select("id")
      .single();
    assert.equal(seeded.error, null, "sembrar needs_input con service role");
    const runId = seeded.data.id;

    const outsiderContinue = await outsider.client.rpc("agent_continue_run", {
      p_run_id: runId,
      p_text: "el de enero",
    });
    assert.ok(outsiderContinue.error, "ajeno no continúa");

    const mine = await member.client.rpc("agent_continue_run", {
      p_run_id: runId,
      p_text: "el de enero",
    });
    assertAllowed(mine, "quien invocó continúa");
    assert.equal(mine.data, true, "continuación efectiva");

    const again = await member.client.rpc("agent_continue_run", {
      p_run_id: runId,
      p_text: "otra respuesta",
    });
    assertAllowed(again, "segunda llamada permitida (0 filas)");
    assert.equal(again.data, false, "ya no está en needs_input");
  });

  it("expire_agent_runs es interna (sin EXECUTE de cliente)", async () => {
    const call = await member.client.rpc("expire_agent_runs", {});
    assert.ok(call.error, "pg_cron interno: el cliente no la llama");
  });

  it("el ajeno no lee ejecuciones del chat", async () => {
    const read = await outsider.client
      .from("agent_runs")
      .select("id, status, message_id")
      .eq("message_id", messageId);
    assertAllowed(read, "select de ajeno permitido (0 filas)");
    assertNoRows(read.data, "ajeno no ve ejecuciones");
  });
});
