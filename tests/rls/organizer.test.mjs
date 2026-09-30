/**
 * RLS del organizador: eventos, proyectos, tareas, ideas, notificaciones y
 * preferencias. Triggers de mención, respuesta en hilo y tarea asignada.
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

describe("RLS: organizador", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  let ws;
  let project;

  const eventPayload = (overrides = {}) => ({
    workspace_id: ws,
    title: "Evento",
    description: "",
    starts_at: new Date(Date.now() + 3600_000).toISOString(),
    ends_at: new Date(Date.now() + 7200_000).toISOString(),
    all_day: false,
    location: "",
    color: "#1d9bf0",
    created_by: owner.id,
    attendees: [],
    reminder_minutes: [],
    recurrence: null,
    ...overrides,
  });

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("org-owner", "Owner");
    member = await createTestUser("org-member", "Member");
    stranger = await createTestUser("org-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Organizador"));
    await addMember(admin, ws, member.id, "member", "Member");

    const { data: projects, error } = await owner.client
      .from("projects")
      .insert({
        workspace_id: ws,
        name: "Proyecto",
        description: "",
        emoji: "📁",
        color: "#1d9bf0",
        created_by: owner.id,
      })
      .select("id");
    if (error) throw error;
    project = projects[0].id;
  });

  after(async () => {
    await purgeTestData();
  });

  // --- eventos ---------------------------------------------------------------

  it("un miembro crea y lee eventos; un ajeno no ve ni crea", async () => {
    assertAllowed(
      await member.client.from("events").insert(eventPayload({ created_by: member.id, title: "De Member" })),
      "un miembro crea eventos",
    );
    const { data: mine } = await member.client
      .from("events")
      .select("id, title")
      .eq("workspace_id", ws);
    assert.ok((mine ?? []).length >= 1, "el miembro lee los eventos del espacio");

    const { data: foreign } = await stranger.client
      .from("events")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(foreign, "un ajeno no ve eventos");
    assertDenied(
      await stranger.client.from("events").insert(eventPayload({ created_by: stranger.id })),
      "un ajeno no crea eventos",
    );
  });

  it("editar/borrar eventos: creador o admin; el resto ni error ni filas", async () => {
    const { data: created } = await owner.client
      .from("events")
      .insert(eventPayload({ title: "Del Owner" }))
      .select("id");
    const id = created[0].id;

    assertDenied(
      await member.client.from("events").update({ title: "Hack" }).eq("id", id).select(),
      "un miembro no edita lo ajeno",
    );
    // Ajeno: ni lo ve (0 filas, sin error).
    assertNoRowsAffected(
      await stranger.client.from("events").update({ title: "Hack" }).eq("id", id).select(),
      "un ajeno no toca eventos",
    );
    // DELETE solo tiene USING: sin permiso son 0 filas, sin error.
    assertNoRowsAffected(
      await member.client.from("events").delete().eq("id", id).select(),
      "un miembro no borra lo ajeno",
    );
    assertAllowed(
      await owner.client.from("events").delete().eq("id", id),
      "el creador borra lo suyo",
    );
  });

  it("un evento no puede colgar de un proyecto de otro espacio", async () => {
    const other = await createWorkspaceWith(stranger.client, workspaceName("Otro"));
    const { data: otherProjects } = await stranger.client
      .from("projects")
      .insert({ workspace_id: other, name: "Ajena", created_by: stranger.id })
      .select("id");
    assertDenied(
      await member.client
        .from("events")
        .insert(eventPayload({ created_by: member.id, project_id: otherProjects[0].id })),
      "proyecto de otro espacio",
    );
  });

  // --- proyectos y tareas -----------------------------------------------------

  it("progreso hechas/total por proyecto", async () => {
    const payload = (title, status) => ({
      project_id: project,
      workspace_id: ws,
      title,
      status,
      created_by: owner.id,
    });
    assertAllowed(
      await owner.client.from("tasks").insert([payload("Una", "done"), payload("Dos", "todo")]),
      "crear tareas",
    );
    const { data: progress } = await member.client
      .from("project_progress")
      .select("total, done")
      .eq("project_id", project)
      .maybeSingle();
    assert.equal(progress?.total, 2, "total 2");
    assert.equal(progress?.done, 1, "hecha 1");

    const { data: foreign } = await stranger.client
      .from("project_progress")
      .select("total")
      .eq("project_id", project);
    assertNoRows(foreign, "un ajeno no ve el progreso");
  });

  it("cualquier miembro mueve tareas; borrar solo creador o admin", async () => {
    const { data: created } = await owner.client
      .from("tasks")
      .insert({
        project_id: project,
        workspace_id: ws,
        title: "Moverme",
        created_by: owner.id,
      })
      .select("id");
    const id = created[0].id;
    assertAllowed(
      await member.client.from("tasks").update({ status: "doing" }).eq("id", id),
      "un miembro cambia el estado",
    );
    assertNoRowsAffected(
      await member.client.from("tasks").delete().eq("id", id).select(),
      "un miembro no borra lo ajeno",
    );
    assertNoRowsAffected(
      await stranger.client.from("tasks").update({ status: "done" }).eq("id", id).select(),
      "un ajeno no toca tareas",
    );
  });

  it("subtarea de otro proyecto, denegada", async () => {
    const { data: otherProjects } = await owner.client
      .from("projects")
      .insert({ workspace_id: ws, name: "Otro", created_by: owner.id })
      .select("id");
    const otherProject = otherProjects[0].id;
    const { data: parents } = await owner.client
      .from("tasks")
      .insert({ project_id: project, workspace_id: ws, title: "Padre", created_by: owner.id })
      .select("id");
    assertDenied(
      await owner.client.from("tasks").insert({
        project_id: otherProject,
        workspace_id: ws,
        title: "Hija cruzada",
        parent_task_id: parents[0].id,
        created_by: owner.id,
      }),
      "padre de otro proyecto",
    );
  });

  // --- ideas -------------------------------------------------------------------

  it("ideas: crear, leer y convertir en tarea", async () => {
    const { data: ideas, error } = await member.client
      .from("ideas")
      .insert({ workspace_id: ws, title: "Idea", detail: "detalle", tag: "Casa", created_by: member.id })
      .select("id");
    assert.equal(error, null, `crear idea: ${error?.message ?? ""}`);
    const ideaId = ideas[0].id;
    const { data: tasks } = await member.client
      .from("tasks")
      .insert({ project_id: project, workspace_id: ws, title: "Idea", created_by: member.id })
      .select("id");
    assertAllowed(
      await member.client.from("ideas").update({ converted_task_id: tasks[0].id }).eq("id", ideaId),
      "convertir idea propia",
    );
    const { data: foreign } = await stranger.client
      .from("ideas")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(foreign, "un ajeno no ve ideas");
  });

  // --- notificaciones ------------------------------------------------------------

  it("cada usuario solo ve y toca las suyas", async () => {
    const { error: seedError } = await admin.from("notifications").insert({
      user_id: member.id,
      workspace_id: ws,
      type: "mention",
      title: "Semilla",
      body: "hola",
      link: "/chat",
    });
    if (seedError) throw seedError;

    const { data: mine } = await member.client.from("notifications").select("id, title");
    assert.ok((mine ?? []).length >= 1, "veo mis notificaciones");
    const { data: foreign } = await stranger.client
      .from("notifications")
      .select("id")
      .eq("user_id", member.id);
    assertNoRows(foreign, "nadie ve las ajenas");

    const id = mine[0].id;
    assertAllowed(
      await member.client.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id),
      "marco como leída la mía",
    );
    assertNoRowsAffected(
      await stranger.client.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id).select(),
      "un ajeno no marca las mías",
    );
  });

  it("mencionar avisa al mencionado (trigger)", async () => {
    const before = await owner.client.from("notifications").select("id", { count: "exact" });
    const beforeCount = before.count ?? 0;
    assertAllowed(
      await member.client.from("messages").insert({
        workspace_id: ws,
        chat_id: "general",
        author_id: member.id,
        author_name: "Member",
        text: "oye @Owner",
        type: "user",
        mentions: [owner.id],
      }),
      "mensaje con mención",
    );
    const after = await owner.client.from("notifications").select("id,type", { count: "exact" });
    assert.equal((after.count ?? 0) - beforeCount, 1, "una notificación de mención");
    assert.equal(after.data?.[after.data.length - 1]?.type, "mention", "type mention");
  });

  it("responder en hilo avisa al autor del padre (trigger)", async () => {
    const { data: parents } = await owner.client
      .from("messages")
      .insert({
        workspace_id: ws,
        chat_id: "general",
        author_id: owner.id,
        author_name: "Owner",
        text: "padre",
        type: "user",
      })
      .select("id");
    const before = await owner.client.from("notifications").select("id", { count: "exact" });
    assertAllowed(
      await member.client.from("messages").insert({
        workspace_id: ws,
        chat_id: "general",
        author_id: member.id,
        author_name: "Member",
        text: "respuesta",
        type: "user",
        thread_parent_id: parents[0].id,
      }),
      "respuesta de hilo",
    );
    const after = await owner.client.from("notifications").select("id", { count: "exact" });
    assert.equal((after.count ?? 0) - (before.count ?? 0), 1, "una notificación de respuesta");
  });

  it("asignar tarea avisa a los responsables (trigger)", async () => {
    const before = await member.client.from("notifications").select("id", { count: "exact" });
    assertAllowed(
      await owner.client.from("tasks").insert({
        project_id: project,
        workspace_id: ws,
        title: "Para Member",
        assignee_ids: [member.id],
        created_by: owner.id,
      }),
      "tarea asignada",
    );
    const after = await member.client
      .from("notifications")
      .select("id,type", { count: "exact" });
    assert.equal((after.count ?? 0) - (before.count ?? 0), 1, "una notificación de asignación");
    assert.equal(after.data?.[after.data.length - 1]?.type, "task_assigned", "type task_assigned");
  });

  it("prefs: guardo las mías, nadie toca las ajenas", async () => {
    assertAllowed(
      await member.client.from("notification_prefs").upsert(
        { user_id: member.id, mention: false },
        { onConflict: "user_id" },
      ),
      "upsert de mis prefs",
    );
    const { data: prefs } = await member.client
      .from("notification_prefs")
      .select("mention")
      .eq("user_id", member.id)
      .maybeSingle();
    assert.equal(prefs?.mention, false, "se guardó el interruptor");
    const { data: foreign } = await stranger.client
      .from("notification_prefs")
      .select("user_id")
      .eq("user_id", member.id);
    assertNoRows(foreign, "nadie ve mis prefs");
  });
});
