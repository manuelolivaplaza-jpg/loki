/**
 * RLS de perfiles, espacios y miembros.
 * Equivalente a tests/firestore.rules.test.mjs (T8) más el camino de alta
 * por la RPC `create_workspace`, que en Postgres sustituye al batch de T8.
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

describe("RLS: perfiles, espacios y miembros", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  /** Espacio del owner, con member dentro como 'member'. */
  let ownerWorkspaceId;
  /** Espacio propio de member, creado con la RPC. */
  let memberWorkspaceId;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("owner", "Owner");
    member = await createTestUser("member", "Member");
    stranger = await createTestUser("stranger", "Stranger");
    ownerWorkspaceId = await createWorkspaceWith(owner.client, workspaceName("Familia"));
    await addMember(admin, ownerWorkspaceId, member.id, "member", "Member");
  });

  after(async () => {
    await purgeTestData();
  });

  // --- perfiles -------------------------------------------------------------

  it("el trigger de auth crea mi perfil con el display_name del registro", async () => {
    const { data, error } = await owner.client
      .from("profiles")
      .select("id, email, display_name, avatar_color, current_workspace_id")
      .eq("id", owner.id)
      .maybeSingle();
    assertAllowed({ error }, "leer mi perfil");
    assert.equal(data.id, owner.id);
    assert.equal(data.email, owner.email);
    assert.equal(data.display_name, "Owner");
    assert.match(data.avatar_color, /^#[0-9a-f]{6}$/i);
  });

  it("el perfil del otro usuario no es visible", async () => {
    const { data, error } = await stranger.client
      .from("profiles")
      .select("id, display_name")
      .eq("id", owner.id);
    assertAllowed({ error }, "consultar el perfil ajeno");
    assertNoRows(data, "el perfil ajeno no debe verse");
  });

  it("puedo editar mi perfil pero no el ajeno", async () => {
    const own = await owner.client
      .from("profiles")
      .update({ display_name: "Owner renombrado" })
      .eq("id", owner.id)
      .select("display_name")
      .maybeSingle();
    assertAllowed(own, "editar mi perfil");
    assert.equal(own.data.display_name, "Owner renombrado");

    const foreign = await stranger.client
      .from("profiles")
      .update({ display_name: "Secuestro" })
      .eq("id", owner.id)
      .select("display_name");
    assertNoRowsAffected(foreign, "editar el perfil de otro");
  });

  it("no puedo cambiar mi propia id de perfil (WITH CHECK)", async () => {
    const idSwap = await owner.client
      .from("profiles")
      .update({ id: stranger.id })
      .eq("id", owner.id)
      .select("id");
    assertDenied(idSwap, "cambiar mi propia id de perfil");
  });

  // --- create_workspace -----------------------------------------------------

  it("create_workspace crea espacio, owner y los chats general y posts", async () => {
    memberWorkspaceId = await createWorkspaceWith(member.client, workspaceName("Propio"));

    const { data: ws, error } = await member.client
      .from("workspaces")
      .select("id, name, emoji, created_by")
      .eq("id", memberWorkspaceId)
      .maybeSingle();
    assertAllowed({ error }, "leer el espacio recien creado");
    assert.equal(ws.name, workspaceName("Propio"));
    assert.equal(ws.created_by, member.id);

    const { data: chats, error: chatError } = await member.client
      .from("chats")
      .select("id, type, name, emoji, member_ids, created_by")
      .eq("workspace_id", memberWorkspaceId)
      .order("id");
    assertAllowed({ error: chatError }, "listar los chats del espacio");
    assert.deepEqual(
      chats.map((chat) => chat.id),
      ["general", "posts"],
    );
    assert.equal(chats[0].type, "group");
    assert.equal(chats[0].name, "General");
    assert.equal(chats[0].emoji, "💬");
    assert.equal(chats[0].created_by, member.id);
    assert.equal(chats[1].type, "posts");
    assert.equal(chats[1].name, "Publicaciones");
    assert.equal(chats[1].emoji, "📰");
    assert.deepEqual(chats[1].member_ids, []);
    // 'ai' no existe en chats de espacio: solo en los chats privados de IA.
    assert.ok(!chats.some((chat) => chat.type === "ai"));
  });

  it("quien llama a create_workspace queda como owner y con el espacio actual", async () => {
    const { data: membership } = await member.client
      .from("workspace_members")
      .select("role, display_name")
      .eq("workspace_id", memberWorkspaceId)
      .eq("user_id", member.id)
      .maybeSingle();
    assert.equal(membership.role, "owner");
    assert.equal(membership.display_name, "Member");

    const { data: profile } = await member.client
      .from("profiles")
      .select("current_workspace_id")
      .eq("id", member.id)
      .maybeSingle();
    assert.equal(profile.current_workspace_id, memberWorkspaceId);
  });

  it("create_workspace valida el nombre (1 a 40 caracteres)", async () => {
    const empty = await member.client.rpc("create_workspace", { p_name: "   ", p_emoji: "🏠" });
    assertDenied(empty, "nombre vacio");

    const tooLong = await member.client.rpc("create_workspace", {
      p_name: "x".repeat(41),
      p_emoji: "🏠",
    });
    assertDenied(tooLong, "nombre de 41 caracteres");

    const justRight = await member.client.rpc("create_workspace", {
      p_name: "x".repeat(40),
      p_emoji: "🏠",
    });
    assertAllowed(justRight, "nombre de 40 caracteres");
  });

  it("insertar un espacio a mano esta denegado: el alta es solo la RPC", async () => {
    const { error } = await owner.client
      .from("workspaces")
      .insert({ name: workspaceName("Colado"), emoji: "🏠", created_by: owner.id });
    assertDenied({ error }, "insert directo en workspaces");
  });

  // --- workspaces -----------------------------------------------------------

  it("un miembro ve su espacio y uno ajeno no", async () => {
    const mine = await member.client
      .from("workspaces")
      .select("id")
      .eq("id", ownerWorkspaceId)
      .maybeSingle();
    assertAllowed(mine, "leer mi espacio");
    assert.equal(mine.data.id, ownerWorkspaceId);

    const foreign = await stranger.client
      .from("workspaces")
      .select("id")
      .eq("id", ownerWorkspaceId);
    assertAllowed(foreign, "consultar el espacio ajeno");
    assertNoRows(foreign.data, "el espacio ajeno no debe verse");
  });

  it("solo el owner renombra el espacio", async () => {
    const byOwner = await owner.client
      .from("workspaces")
      .update({ name: workspaceName("Familia v2") })
      .eq("id", ownerWorkspaceId)
      .select("name")
      .maybeSingle();
    assertAllowed(byOwner, "el owner renombra");
    assert.equal(byOwner.data.name, workspaceName("Familia v2"));

    const byMember = await member.client
      .from("workspaces")
      .update({ name: workspaceName("Secuestrado") })
      .eq("id", ownerWorkspaceId)
      .select("name");
    assertNoRowsAffected(byMember, "un miembro que no es owner renombra");
  });

  it("un no miembro no ve la lista de miembros ni puede auto-scribirse", async () => {
    const list = await stranger.client
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", ownerWorkspaceId);
    assertAllowed(list, "listar miembros siendo un Strange");
    assertNoRows(list.data, "la lista de miembros no debe verse");

    const selfInsert = await stranger.client.from("workspace_members").insert({
      workspace_id: ownerWorkspaceId,
      user_id: stranger.id,
      role: "member",
      display_name: "Colado",
    });
    assertDenied(selfInsert, "un no miembro se apunta a si mismo");
  });

  it("el owner anade y quita miembros; un miembro no", async () => {
    const added = await owner.client
      .from("workspace_members")
      .insert({
        workspace_id: ownerWorkspaceId,
        user_id: stranger.id,
        role: "member",
        display_name: "Invitado",
      })
      .select("user_id")
      .maybeSingle();
    assertAllowed(added, "el owner anade a un miembro");
    assert.equal(added.data.user_id, stranger.id);

    const removed = await owner.client
      .from("workspace_members")
      .delete()
      .eq("workspace_id", ownerWorkspaceId)
      .eq("user_id", stranger.id);
    assertAllowed(removed, "el owner quita a un miembro");

    const removedByMember = await member.client
      .from("workspace_members")
      .delete()
      .eq("workspace_id", ownerWorkspaceId)
      .eq("user_id", member.id)
      .select("user_id");
    assertNoRowsAffected(removedByMember, "un miembro simple no quita miembros");
  });

  it("cada uno cambia su display_name pero el rol solo lo cambia el owner", async () => {
    const own = await member.client
      .from("workspace_members")
      .update({ display_name: "Member renombrado" })
      .eq("workspace_id", ownerWorkspaceId)
      .eq("user_id", member.id)
      .select("display_name")
      .maybeSingle();
    assertAllowed(own, "cambiar mi display_name de miembro");
    assert.equal(own.data.display_name, "Member renombrado");

    // Aqui la RLS deja pasar la fila (soy el dueno de mi fila), pero el trigger
    // workspace_members_guard_update la rechaza: 42501.
    const selfPromote = await member.client
      .from("workspace_members")
      .update({ role: "owner" })
      .eq("workspace_id", ownerWorkspaceId)
      .eq("user_id", member.id)
      .select("user_id");
    assertDenied(selfPromote, "un miembro se autopromueve a owner");

    const promote = await owner.client
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", ownerWorkspaceId)
      .eq("user_id", member.id)
      .select("role")
      .maybeSingle();
    assertAllowed(promote, "el owner cambia el rol");
    assert.equal(promote.data.role, "admin");

    // Se deja como estaba para el resto de tests.
    await owner.client
      .from("workspace_members")
      .update({ role: "member" })
      .eq("workspace_id", ownerWorkspaceId)
      .eq("user_id", member.id);
  });
});
