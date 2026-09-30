/**
 * RLS negativos (T35): lo prohibido, denegado.
 *
 * Solo casos de FALLO (lecturas vacías, escrituras denegadas, 0 filas
 * afectadas). Los caminos felices viven en los demás archivos; este no los
 * repite. Patrón de `_helpers.mjs`: usuarios reales con `auth.signUp`,
 * service_role solo para sembrar y limpiar.
 */

import { after, before, describe, it } from "node:test";

import {
  addMember,
  adminClient,
  assertDenied,
  assertNoRows,
  assertNoRowsAffected,
  createTestUser,
  createWorkspaceWith,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

describe("RLS negativos", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  let ws;
  let project;
  let ownerEvent;
  let ownerTask;

  const eventPayload = (by, overrides = {}) => ({
    workspace_id: ws,
    title: "Evento del owner",
    description: "",
    starts_at: new Date(Date.now() + 3600_000).toISOString(),
    ends_at: new Date(Date.now() + 7200_000).toISOString(),
    all_day: false,
    location: "",
    created_by: by,
    ...overrides,
  });

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("neg-owner", "Owner");
    member = await createTestUser("neg-member", "Member");
    stranger = await createTestUser("neg-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Negativos"));
    await addMember(admin, ws, member.id, "member", "Member");

    const { data: projects, error } = await owner.client
      .from("projects")
      .insert({ workspace_id: ws, name: "Proyecto", created_by: owner.id })
      .select("id");
    if (error) throw error;
    project = projects[0].id;

    const { data: events, error: eventError } = await owner.client
      .from("events")
      .insert(eventPayload(owner.id))
      .select("id");
    if (eventError) throw eventError;
    ownerEvent = events[0].id;

    const { data: tasks, error: taskError } = await owner.client
      .from("tasks")
      .insert({
        project_id: project,
        workspace_id: ws,
        title: "Tarea del owner",
        created_by: owner.id,
      })
      .select("id");
    if (taskError) throw taskError;
    ownerTask = tasks[0].id;
  });

  after(async () => {
    await purgeTestData();
  });

  it("un ajeno no lee nada del espacio", async () => {
    const { data: events } = await stranger.client
      .from("events")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(events, "eventos ajenos");

    const { data: tasks } = await stranger.client
      .from("tasks")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(tasks, "tareas ajenas");

    const { data: projects } = await stranger.client
      .from("projects")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(projects, "proyectos ajenos");

    const { data: messages } = await stranger.client
      .from("messages")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(messages, "mensajes ajenos");

    const { data: invites } = await stranger.client
      .from("invites")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(invites, "invitaciones ajenas");

    const { data: members } = await stranger.client
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", ws);
    assertNoRows(members, "membresías ajenas");
  });

  it("un ajeno no escribe nada en el espacio", async () => {
    assertDenied(
      await stranger.client.from("events").insert(eventPayload(stranger.id)),
      "ajeno crea eventos",
    );
    assertDenied(
      await stranger.client.from("tasks").insert({
        project_id: project,
        workspace_id: ws,
        title: "Hack",
        created_by: stranger.id,
      }),
      "ajeno crea tareas",
    );
    assertDenied(
      await stranger.client.from("projects").insert({
        workspace_id: ws,
        name: "Hack",
        created_by: stranger.id,
      }),
      "ajeno crea proyectos",
    );
    assertDenied(
      await stranger.client.from("messages").insert({
        workspace_id: ws,
        chat_id: "general",
        author_id: stranger.id,
        author_name: "Stranger",
        text: "hack",
        type: "user",
      }),
      "ajeno envía mensajes",
    );
  });

  it("un miembro de otro espacio no ve ni escribe aquí", async () => {
    const other = await createTestUser("neg-other", "Otro");
    const otherWs = await createWorkspaceWith(other.client, workspaceName("Otro"));

    const { data: foreign } = await other.client
      .from("events")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(foreign, "eventos de otro espacio");

    const { data: foreignTasks } = await other.client
      .from("tasks")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(foreignTasks, "tareas de otro espacio");

    assertDenied(
      await other.client.from("events").insert(eventPayload(other.id)),
      "miembro de otro espacio crea eventos aquí",
    );

    // Y al revés: los de aquí no ven su espacio.
    const { data: mine } = await member.client
      .from("events")
      .select("id")
      .eq("workspace_id", otherWs);
    assertNoRows(mine, "no veo el espacio ajeno");
  });

  it("un member no crea ni toca invitaciones", async () => {
    assertDenied(
      await member.client
        .from("invites")
        .insert({ workspace_id: ws, created_by: member.id }),
      "member crea invites",
    );

    const { data: invites } = await owner.client
      .from("invites")
      .insert({ workspace_id: ws, created_by: owner.id })
      .select("id");
    const inviteId = invites[0].id;

    // La política de edición exige admin en el USING: sin permiso son 0
    // filas, sin error.
    assertNoRowsAffected(
      await member.client
        .from("invites")
        .update({ max_uses: 1 })
        .eq("id", inviteId)
        .select(),
      "member edita invites",
    );
    assertNoRowsAffected(
      await member.client.from("invites").delete().eq("id", inviteId).select(),
      "member borra invites",
    );
  });

  it("un member no cambia roles ni expulsa", async () => {
    // Cambiar el rol lo bloquea el trigger (excepción, llega como error).
    const roleChange = await member.client
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", ws)
      .eq("user_id", member.id)
      .select();
    assertDenied(roleChange, "member se hace admin");

    const otherChange = await member.client
      .from("workspace_members")
      .update({ role: "member" })
      .eq("workspace_id", ws)
      .eq("user_id", owner.id)
      .select();
    if (otherChange.error === null) {
      assertNoRows(otherChange.data, "member no degrada al owner");
    }

    // Expulsar lo bloquea la política (USING falso: 0 filas, sin error).
    assertNoRowsAffected(
      await member.client
        .from("workspace_members")
        .delete()
        .eq("workspace_id", ws)
        .eq("user_id", owner.id)
        .select(),
      "member no expulsa al owner",
    );
  });

  it("update/delete ajenos en eventos: solo creador o admin", async () => {
    assertDenied(
      await member.client
        .from("events")
        .update({ title: "Hack" })
        .eq("id", ownerEvent)
        .select(),
      "member edita evento ajeno",
    );
    assertNoRowsAffected(
      await member.client.from("events").delete().eq("id", ownerEvent).select(),
      "member borra evento ajeno",
    );
    assertNoRowsAffected(
      await stranger.client
        .from("events")
        .update({ title: "Hack" })
        .eq("id", ownerEvent)
        .select(),
      "ajeno edita eventos",
    );
    assertNoRowsAffected(
      await stranger.client.from("events").delete().eq("id", ownerEvent).select(),
      "ajeno borra eventos",
    );
  });

  it("update/delete ajenos en tareas: borrar solo creador o admin", async () => {
    assertNoRowsAffected(
      await member.client.from("tasks").delete().eq("id", ownerTask).select(),
      "member borra tarea ajena",
    );
    assertNoRowsAffected(
      await stranger.client
        .from("tasks")
        .update({ status: "done" })
        .eq("id", ownerTask)
        .select(),
      "ajeno toca tareas",
    );
    assertNoRowsAffected(
      await stranger.client.from("tasks").delete().eq("id", ownerTask).select(),
      "ajeno borra tareas",
    );
  });

  it("update/delete ajenos en proyectos: solo creador o admin", async () => {
    assertDenied(
      await member.client
        .from("projects")
        .update({ name: "Hack" })
        .eq("id", project)
        .select(),
      "member edita proyecto ajeno",
    );
    assertNoRowsAffected(
      await member.client.from("projects").delete().eq("id", project).select(),
      "member borra proyecto ajeno",
    );
    assertNoRowsAffected(
      await stranger.client
        .from("projects")
        .update({ name: "Hack" })
        .eq("id", project)
        .select(),
      "ajeno edita proyectos",
    );
    assertNoRowsAffected(
      await stranger.client.from("projects").delete().eq("id", project).select(),
      "ajeno borra proyectos",
    );
  });

  it("nadie edita ni borra mensajes ajenos", async () => {
    const { data: posted } = await owner.client
      .from("messages")
      .insert({
        workspace_id: ws,
        chat_id: "general",
        author_id: owner.id,
        author_name: "Owner",
        text: "mío",
        type: "user",
      })
      .select("id");
    const id = posted[0].id;

    assertNoRowsAffected(
      await member.client
        .from("messages")
        .update({ text: "hack" })
        .eq("id", id)
        .select(),
      "member edita mensaje ajeno",
    );
    assertNoRowsAffected(
      await member.client.from("messages").delete().eq("id", id).select(),
      "member borra mensaje ajeno",
    );
    assertNoRowsAffected(
      await stranger.client
        .from("messages")
        .update({ text: "hack" })
        .eq("id", id)
        .select(),
      "ajeno edita mensajes",
    );
  });
});
