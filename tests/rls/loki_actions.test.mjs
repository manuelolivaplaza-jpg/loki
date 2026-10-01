/**
 * RLS de acciones de Loki: Bandeja del espacio y anti-spam.
 *
 * - ensure_inbox_project(): idempotente, solo miembros.
 * - La Bandeja no se borra ni se archiva (ni los admins); renombrar, admins.
 * - log_loki_action(): tope por hora y destinatario.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import {
  addMember,
  adminClient,
  assertAllowed,
  assertDenied,
  createTestUser,
  createWorkspaceWith,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

describe("RLS: acciones de Loki (Bandeja)", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  let ws;
  let inbox;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("inbox-owner", "Owner");
    member = await createTestUser("inbox-member", "Member");
    stranger = await createTestUser("inbox-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Bandeja"));
    await addMember(admin, ws, member.id, "member", "Member");
  });

  after(async () => {
    await purgeTestData();
  });

  it("ensure_inbox_project es idempotente y solo para miembros", async () => {
    const first = await member.client.rpc("ensure_inbox_project", {
      p_workspace_id: ws,
    });
    assert.equal(first.error, null, "un miembro abre la Bandeja");
    inbox = first.data;
    assert.ok(typeof inbox === "string" && inbox !== "", "devuelve el id");
    const second = await owner.client.rpc("ensure_inbox_project", {
      p_workspace_id: ws,
    });
    assert.equal(second.error, null, "el owner también la pide");
    assert.equal(second.data, inbox, "idempotente: el mismo id");
    const foreign = await stranger.client.rpc("ensure_inbox_project", {
      p_workspace_id: ws,
    });
    assert.ok(foreign.error, "un ajeno no abre Bandeja");
  });

  it("la Bandeja sale primera y no se borra ni se archiva", async () => {
    const { data: listed } = await member.client
      .from("projects")
      .select("id, is_system")
      .eq("workspace_id", ws)
      .order("is_system", { ascending: false })
      .order("created_at", { ascending: true });
    assert.ok((listed ?? []).length >= 1, "hay proyectos");
    assert.equal(listed[0].is_system, true, "la Bandeja va primera");
    assert.equal(listed[0].id, inbox, "es la Bandeja abierta");

    const del = await owner.client.from("projects").delete().eq("id", inbox).select("id");
    assert.equal((del.data ?? []).length, 0, "ni el owner la borra");

    const arch = await owner.client
      .from("projects")
      .update({ status: "archived" })
      .eq("id", inbox)
      .select("id");
    assert.equal((arch.data ?? []).length, 0, "ni el owner la archiva");

    assertAllowed(
      await owner.client.from("projects").update({ name: "Bandeja XL" }).eq("id", inbox),
      "un admin la renombra",
    );
    assertDenied(
      await member.client.from("projects").update({ name: "Otra" }).eq("id", inbox),
      "un miembro no la renombra",
    );
  });

  it("log_loki_action topa por hora y destinatario", async () => {
    for (let i = 0; i < 10; i += 1) {
      const { data, error } = await admin.rpc("log_loki_action", {
        p_workspace_id: ws,
        p_actor_id: owner.id,
        p_target_id: member.id,
        p_action: "remind_other",
        p_limit_hour: 10,
      });
      assert.equal(error, null, `aviso ${i + 1} sin error`);
      assert.equal(data, true, `aviso ${i + 1} permitido`);
    }
    const { data: blocked, error } = await admin.rpc("log_loki_action", {
      p_workspace_id: ws,
      p_actor_id: owner.id,
      p_target_id: member.id,
      p_action: "remind_other",
      p_limit_hour: 10,
    });
    assert.equal(error, null, "el tope no es error SQL");
    assert.equal(blocked, false, "el aviso 11 se bloquea");
  });
});
