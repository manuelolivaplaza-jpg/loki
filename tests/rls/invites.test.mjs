/**
 * RLS de invitaciones y `accept_invite(code)`: solo admins crean, cualquiera
 * con el código se une, con caducidad, usos y revocación.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import {
  addMember,
  adminClient,
  assertAllowed,
  assertDenied,
  assertNoRows,
  createTestUser,
  createWorkspaceWith,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

describe("RLS: invitaciones", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  let ws;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("inv-owner", "Owner");
    member = await createTestUser("inv-member", "Member");
    stranger = await createTestUser("inv-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Invites"));
    await addMember(admin, ws, member.id, "member", "Member");
  });

  after(async () => {
    await purgeTestData();
  });

  it("solo admins crean invitaciones; el espacio las lista", async () => {
    const { data: invites, error } = await owner.client
      .from("invites")
      .insert({ workspace_id: ws, created_by: owner.id, role: "member" })
      .select("id, code");
    assert.equal(error, null, `crear invite: ${error?.message ?? ""}`);
    assert.match(invites[0].code, /^[A-Z2-9]{8}$/, "código de 8 sin 0/O/1/I");

    assertDenied(
      await member.client.from("invites").insert({ workspace_id: ws, created_by: member.id }),
      "un miembro raso no crea invitaciones",
    );
    const { data: mine } = await member.client.from("invites").select("id, code");
    assert.ok((mine ?? []).length >= 1, "el espacio lista sus invitaciones");
    const { data: foreign } = await stranger.client.from("invites").select("id");
    assertNoRows(foreign, "un ajeno no ve invitaciones");
  });

  it("unirse con código da membresía y avisa al invitador", async () => {
    const newcomer = await createTestUser("inv-new", "Nuevo");
    const { data: invites } = await owner.client
      .from("invites")
      .insert({ workspace_id: ws, created_by: owner.id, max_uses: 5 })
      .select("code");
    const code = invites[0].code;

    const before = await owner.client.from("notifications").select("id", { count: "exact" });
    const { data, error } = await newcomer.client.rpc("accept_invite", { p_code: code });
    assert.equal(error, null, `accept_invite: ${error?.message ?? ""}`);
    assert.equal(data.workspace_id, ws, "devuelve el espacio");
    assert.ok((data.workspace_name ?? "") !== "", "devuelve el nombre");
    assert.equal(data.joined, true, "recién unido");

    const { data: membership } = await newcomer.client
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", ws)
      .eq("user_id", newcomer.id)
      .maybeSingle();
    assert.equal(membership?.role, "member", "membresía de miembro");

    const after = await owner.client.from("notifications").select("id", { count: "exact" });
    assert.equal((after.count ?? 0) - (before.count ?? 0), 1, "aviso al invitador");

    // Repetir siendo miembro: éxito idempotente sin consumir uso.
    const again = await newcomer.client.rpc("accept_invite", { p_code: code });
    assert.equal(again.error, null, `repetir: ${again.error?.message ?? ""}`);
    assert.equal(again.data.joined, false, "ya era miembro");
  });

  it("código inexistente, caducado o agotado, denegados", async () => {
    const probe = await createTestUser("inv-probe", "Probe");

    const bad = await probe.client.rpc("accept_invite", { p_code: "ZZZZZZZZ" });
    assert.ok(bad.error, "código inexistente da error");

    const { data: expired } = await owner.client
      .from("invites")
      .insert({
        workspace_id: ws,
        created_by: owner.id,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      })
      .select("code");
    const expiredRes = await probe.client.rpc("accept_invite", { p_code: expired[0].code });
    assert.ok(expiredRes.error, "código caducado da error");

    const { data: single } = await owner.client
      .from("invites")
      .insert({ workspace_id: ws, created_by: owner.id, max_uses: 1 })
      .select("code");
    const first = await createTestUser("inv-first", "Primero");
    assert.equal(
      (await first.client.rpc("accept_invite", { p_code: single[0].code })).error,
      null,
      "primer uso pasa",
    );
    const second = await createTestUser("inv-second", "Segundo");
    const used = await second.client.rpc("accept_invite", { p_code: single[0].code });
    assert.ok(used.error, "segundo uso agotado da error");
  });

  it("revocar bloquea y el rol de la invitación se respeta", async () => {
    const { data: invites } = await owner.client
      .from("invites")
      .insert({ workspace_id: ws, created_by: owner.id, role: "admin" })
      .select("id, code");
    const { id, code } = invites[0];

    assertAllowed(
      await owner.client.from("invites").update({ revoked_at: new Date().toISOString() }).eq("id", id),
      "revocar",
    );
    const late = await createTestUser("inv-late", "Tarde");
    const revoked = await late.client.rpc("accept_invite", { p_code: code });
    assert.ok(revoked.error, "revocada da error");

    const { data: adminInvites } = await owner.client
      .from("invites")
      .insert({ workspace_id: ws, created_by: owner.id, role: "admin" })
      .select("code");
    const future = await createTestUser("inv-future", "Futuro");
    assert.equal(
      (await future.client.rpc("accept_invite", { p_code: adminInvites[0].code })).error,
      null,
      "unirse como admin",
    );
    const { data: membership } = await future.client
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", ws)
      .eq("user_id", future.id)
      .maybeSingle();
    assert.equal(membership?.role, "admin", "rol admin de la invitación");
  });
});
