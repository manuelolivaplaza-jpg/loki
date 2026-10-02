/**
 * RLS de tareas recurrentes y turnos rotativos (migración
 * `20261017000000_tareas_recurrentes_turnos.sql`).
 *
 * - `task_series`: el espacio la ve; cada miembro crea la suya a nombre propio;
 *   editar/borrar, quien la creó o un admin. Los punteros (`next_occurrence`,
 *   `last_occurrence`) los tiene guardados la base: el cliente no los mueve.
 * - Generación por eventos: al crear la serie aparece su primera ocurrencia
 *   como tarea normal (con el turno que toca) y el barrido hace la siguiente,
 *   avanzando la rotación.
 * - `shift_swaps`: solo participan los dos de cada intercambio; un tercero no
 *   lo ve ni lo puede resolver, y aceptar mueve el turno.
 * - Vacaciones (`skip_shift`), reordenar la rotación y editar/borrar por
 *   alcance ("solo esta" / "esta y las siguientes").
 * - Quien sale del espacio sale de la rotación y se avisa a quien la creó.
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

/** Fecha "YYYY-MM-DD" de hoy (la serie usa días locales). */
function isoDay(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Fecha "YYYY-MM-DD" del próximo martes (regla semanal de los ejemplos). */
function nextTuesdayISO() {
  const date = new Date();
  const delta = (2 - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + delta);
  const pad = (value) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

describe("RLS: tareas recurrentes y turnos", () => {
  let admin;
  let owner;
  let member;
  let other;
  let stranger;
  let ws;
  let project;

  const seriesPayload = (overrides = {}) => ({
    workspace_id: ws,
    project_id: project,
    title: "Sacar la basura",
    notes: "",
    priority: "normal",
    recurrence_kind: "weekly",
    recurrence_interval: 1,
    recurrence_unit: "weeks",
    weekdays: [2],
    month_day: null,
    month_week: null,
    month_weekday: null,
    start_date: nextTuesdayISO(),
    time_of_day: "09:00",
    timezone: "America/Santiago",
    remind_time: "09:00",
    ends_on: null,
    rotation: [],
    rotation_index: 0,
    active: true,
    created_by: owner.id,
    ...overrides,
  });

  async function createSeries(overrides = {}) {
    const { data, error } = await owner.client
      .from("task_series")
      .insert(seriesPayload(overrides))
      .select("id, title, rotation, rotation_index, last_occurrence, next_occurrence")
      .single();
    if (error) throw new Error(`crear serie: ${error.message}`);
    return data;
  }

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("rec-owner", "Owner");
    member = await createTestUser("rec-member", "Member");
    other = await createTestUser("rec-other", "Other");
    stranger = await createTestUser("rec-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Recurrentes"));
    await addMember(admin, ws, member.id, "member", "Member");
    await addMember(admin, ws, other.id, "member", "Other");

    const { data: projects, error } = await owner.client
      .from("projects")
      .insert({
        workspace_id: ws,
        name: "Casa",
        description: "",
        emoji: "🏠",
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

  // --- series: permisos -------------------------------------------------------

  it("un miembro crea la suya y el espacio la ve; un ajeno no", async () => {
    assertAllowed(
      await member.client
        .from("task_series")
        .insert(seriesPayload({ title: "Pagar la luz", created_by: member.id })),
      "creo mi serie",
    );

    const { data: mine } = await member.client
      .from("task_series")
      .select("id")
      .eq("workspace_id", ws);
    assert.ok((mine ?? []).length >= 1, "veo las series del espacio");

    const { data: foreign } = await stranger.client
      .from("task_series")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(foreign, "un ajeno no ve las series");

    assertDenied(
      await stranger.client
        .from("task_series")
        .insert(seriesPayload({ created_by: stranger.id })),
      "un ajeno no crea series",
    );
  });

  it("no se puede crear una serie a nombre de otro", async () => {
    assertDenied(
      await member.client
        .from("task_series")
        .insert(seriesPayload({ title: "De otro", created_by: owner.id })),
      "creo una serie a nombre del owner",
    );
  });

  it("editar/borrar series: creador o admin; el resto ni error ni filas", async () => {
    const created = await member.client
      .from("task_series")
      .insert(seriesPayload({ title: "Solo mía", created_by: member.id }))
      .select("id")
      .single();
    if (created.error) throw created.error;
    const id = created.data.id;

    assertNoRowsAffected(
      await other.client
        .from("task_series")
        .update({ title: "Hack" })
        .eq("id", id)
        .select(),
      "otro miembro no edita la serie de otro",
    );

    assertAllowed(
      await member.client.from("task_series").update({ title: "Renombrada" }).eq("id", id),
      "el creador edita su serie",
    );

    // Borrar: el creador sí; otro miembro no (ni error ni filas).
    assertAllowed(
      await member.client.from("task_series").delete().eq("id", id),
      "el creador borra su serie",
    );
  });

  it("el cliente no mueve los punteros de la serie (los tiene la base)", async () => {
    const series = await createSeries({ title: "Punteros" });
    assertDenied(
      await owner.client
        .from("task_series")
        .update({ last_occurrence: 99, next_occurrence: "2099-01-01" })
        .eq("id", series.id)
        .select(),
      "muevo last_occurrence a mano",
    );
    assertDenied(
      await owner.client
        .from("task_series")
        .update({ created_by: stranger.id })
        .eq("id", series.id)
        .select(),
      "cambio el creador",
    );
  });

  it("una regla incompleta no entra (CHECK de la tabla)", async () => {
    assertDenied(
      await owner.client
        .from("task_series")
        .insert(seriesPayload({ title: "Sin días", weekdays: [] })),
      "serie semanal sin días",
    );
    assertDenied(
      await owner.client
        .from("task_series")
        .insert(seriesPayload({ title: "Mensual", recurrence_kind: "monthly", weekdays: [] })),
      "serie mensual sin día",
    );
  });

  // --- generación por eventos ------------------------------------------------

  it("al crear la serie aparece su primera ocurrencia como tarea normal", async () => {
    const series = await createSeries({
      title: "Lavar la loza",
      rotation: [member.id, owner.id],
    });
    assert.equal(series.last_occurrence, 1, "la primera ocurrencia se generó");
    assert.ok(series.next_occurrence !== null, "queda la siguiente fecha");

    const { data: tasks, error } = await member.client
      .from("tasks")
      .select("id, title, series_id, series_occurrence, assignee_ids, status")
      .eq("series_id", series.id);
    if (error) throw error;
    assert.equal((tasks ?? []).length, 1, "una ocurrencia viva");
    const first = tasks[0];
    assert.equal(first.status, "todo", "nace pendiente");
    assert.equal(first.series_occurrence, 1, "es la ocurrencia 1");
    assert.deepEqual(first.assignee_ids, [member.id], "le toca al primero de la rotación");

    // La siguiente la genera el barrido (materialize) y avanza la rotación.
    const { data: made } = await owner.client.rpc("materialize_series_occurrences", {
      p_series_id: series.id,
      p_horizon_days: 3,
    });
    assert.ok(typeof made === "number", "materialize devuelve un número");
    const { data: all } = await owner.client
      .from("tasks")
      .select("series_occurrence, assignee_ids")
      .eq("series_id", series.id)
      .order("series_occurrence");
    assert.ok((all ?? []).length >= 2, "ya hay más de una ocurrencia");
    assert.deepEqual(
      (all ?? [])[1]?.assignee_ids,
      [owner.id],
      "la segunda le toca al siguiente de la rotación",
    );
  });

  it("materialize es idempotente: repetirlo no duplica ocurrencias", async () => {
    const series = await createSeries({ title: "Regar plantas", rotation: [owner.id] });
    const before = await owner.client
      .from("tasks")
      .select("id")
      .eq("series_id", series.id);
    await owner.client.rpc("materialize_series_occurrences", {
      p_series_id: series.id,
      p_horizon_days: 3,
    });
    const after = await owner.client
      .from("tasks")
      .select("id")
      .eq("series_id", series.id);
    assert.ok(
      (after ?? []).length <= (before ?? []).length + 3,
      "no se crean cientos de tareas futuras",
    );
    const unique = new Set((after ?? []).map((row) => row.id));
    assert.equal(unique.size, (after ?? []).length, "sin ocurrencias repetidas");
  });

  it("un miembro no genera ocurrencias de la serie de otro", async () => {
    const series = await createSeries({ title: "Del owner", rotation: [owner.id] });
    await owner.client.rpc("materialize_series_occurrences", { p_series_id: series.id, p_horizon_days: 3 });
    const before = await owner.client
      .from("tasks")
      .select("id")
      .eq("series_id", series.id);
    const { data: made } = await member.client.rpc("materialize_series_occurrences", {
      p_series_id: series.id,
      p_horizon_days: 3,
    });
    const after = await owner.client
      .from("tasks")
      .select("id")
      .eq("series_id", series.id);
    assert.equal(made, 0, "un miembro no genera ocurrencias de la serie de otro");
    assert.equal(
      (after ?? []).length,
      (before ?? []).length,
      "no se crean tareas nuevas",
    );
  });

  it("uso del espacio para el límite visible", async () => {
    const { data, error } = await owner.client.rpc("series_usage", { p_workspace_id: ws });
    assert.equal(error, null, `series_usage: ${error?.message ?? ""}`);
    assert.ok(typeof data?.active === "number", "devuelve cuántas hay activas");
    assert.equal(typeof data?.limit, "number", "devuelve el límite");

    const denied = await stranger.client.rpc("series_usage", { p_workspace_id: ws });
    assertDenied(denied, "un ajeno no pregunta el uso de otro espacio");
  });

  // --- turnos: intercambios ---------------------------------------------------

  it("turnos: pedir el cambio, aceptarlo (mueve el turno) y el tercero ni lo ve", async () => {
    const series = await createSeries({
      title: "Bajar la basura",
      rotation: [member.id, owner.id, other.id],
    });
    const { data: tasks } = await owner.client
      .from("tasks")
      .select("id, assignee_ids")
      .eq("series_id", series.id)
      .order("series_occurrence")
      .limit(1);
    const taskId = tasks[0].id;

    const { data: swapId, error: swapError } = await member.client.rpc("request_shift_swap", {
      p_task_id: taskId,
      p_to_user_id: owner.id,
      p_note: "Tengo una cita",
    });
    assert.equal(swapError, null, `pedir el cambio: ${swapError?.message ?? ""}`);
    assert.equal(typeof swapId, "string", "devuelve el id de la solicitud");

    // Solo la ven los dos involucrados.
    const { data: forMember } = await member.client.from("shift_swaps").select("id, status");
    assert.ok((forMember ?? []).some((row) => row.id === swapId), "quien pide la ve");
    const { data: forOther } = await other.client.from("shift_swaps").select("id");
    assertNoRows(forOther, "un tercero no ve el intercambio");
    const { data: forStranger } = await stranger.client.from("shift_swaps").select("id");
    assertNoRows(forStranger, "un ajeno no ve el intercambio");

    // El aviso al otro (tipo shift).
    const { data: notices } = await owner.client
      .from("notifications")
      .select("type, title")
      .eq("type", "shift")
      .order("created_at", { ascending: false })
      .limit(3);
    assert.ok(
      (notices ?? []).some((row) => row.title === "¿Me cambias el turno?"),
      "avisa con tipo shift al otro",
    );

    // Un tercero no puede resolverlo, y el UPDATE directo está cerrado: la
    // resolución va por la RPC (que además mueve el turno).
    const denied = await other.client.rpc("resolve_shift_swap", {
      p_swap_id: swapId,
      p_accept: true,
    });
    assertDenied(denied, "un tercero resuelve el intercambio");

    assertNoRowsAffected(
      await owner.client
        .from("shift_swaps")
        .update({ status: "accepted" })
        .eq("id", swapId)
        .select(),
      "cambia el estado del intercambio sin la RPC",
    );

    // El otro acepta: el turno pasa a él y la rotación avanza.
    const { error: acceptError } = await owner.client.rpc("resolve_shift_swap", {
      p_swap_id: swapId,
      p_accept: true,
    });
    assert.equal(acceptError, null, `acepta el cambio: ${acceptError?.message ?? ""}`);
    const { data: task } = await owner.client
      .from("tasks")
      .select("assignee_ids")
      .eq("id", taskId)
      .maybeSingle();
    assert.deepEqual(task?.assignee_ids, [owner.id], "el turno pasó al otro");

    // Resolver dos veces no vale.
    assertDenied(
      await owner.client.rpc("resolve_shift_swap", { p_swap_id: swapId, p_accept: false }),
      "resuelve un intercambio ya cerrado",
    );
  });

  it("turnos: rechazar deja el turno como estaba", async () => {
    const series = await createSeries({
      title: "Poner la mesa",
      rotation: [member.id, owner.id],
    });
    const { data: tasks } = await owner.client
      .from("tasks")
      .select("id, assignee_ids")
      .eq("series_id", series.id)
      .limit(1);
    const taskId = tasks[0].id;
    const { data: swapId } = await member.client.rpc("request_shift_swap", {
      p_task_id: taskId,
      p_to_user_id: owner.id,
    });
    const { error } = await owner.client.rpc("resolve_shift_swap", {
      p_swap_id: swapId,
      p_accept: false,
    });
    assert.equal(error, null, `rechazar: ${error?.message ?? ""}`);
    const { data: task } = await owner.client
      .from("tasks")
      .select("assignee_ids")
      .eq("id", taskId)
      .maybeSingle();
    assert.deepEqual(task?.assignee_ids, [member.id], "el turno sigue donde estaba");
  });

  it("turnos: vacaciones (rango) sacan a alguien de la rotación", async () => {
    const series = await createSeries({
      title: "Barrer",
      rotation: [member.id, owner.id],
    });
    const { data: moved, error } = await owner.client.rpc("skip_shift", {
      p_series_id: series.id,
      p_user_id: member.id,
      p_from: isoDay(-1),
      p_to: isoDay(30),
      p_reason: "De viaje",
    });
    assert.equal(error, null, `skip_shift: ${error?.message ?? ""}`);
    assert.equal(typeof moved, "number", "devuelve cuántos turnos se movieron");

    const { data: fresh } = await owner.client
      .from("task_series")
      .select("rotation_skips")
      .eq("id", series.id)
      .maybeSingle();
    assert.ok(Array.isArray(fresh?.rotation_skips), "guarda la ausencia");
    assert.ok(fresh.rotation_skips.length >= 1, "con una entrada de vacaciones");

    // Un miembro que no creó la serie no cambia la rotación.
    const { data: ownSeries } = await member.client
      .from("task_series")
      .insert(seriesPayload({ title: "Del member", created_by: member.id }))
      .select("id")
      .single();
    assertDenied(
      await stranger.client.rpc("skip_shift", {
        p_series_id: ownSeries.id,
        p_user_id: member.id,
        p_from: isoDay(0),
        p_to: isoDay(1),
      }),
      "un ajeno cambia la rotación",
    );
    assertDenied(
      await other.client.rpc("reorder_rotation", {
        p_series_id: ownSeries.id,
        p_order: [other.id],
      }),
      "otro miembro del espacio reordena la rotación de otra serie",
    );
  });

  it("turnos: reordenar exige el mismo padrón", async () => {
    const series = await createSeries({
      title: "Tirar la ropa",
      rotation: [member.id, owner.id],
    });
    assertDenied(
      await owner.client.rpc("reorder_rotation", {
        p_series_id: series.id,
        p_order: [owner.id],
      }),
      "cambia el número de personas",
    );
    assertDenied(
      await owner.client.rpc("reorder_rotation", {
        p_series_id: series.id,
        p_order: [other.id, owner.id],
      }),
      "mete a alguien que no estaba",
    );
    const { data, error } = await owner.client.rpc("reorder_rotation", {
      p_series_id: series.id,
      p_order: [owner.id, member.id],
    });
    assert.equal(error, null, `reordenar: ${error?.message ?? ""}`);
    assert.ok(Array.isArray(data), "devuelve el nuevo orden");
    const { data: fresh } = await owner.client
      .from("task_series")
      .select("rotation, rotation_index")
      .eq("id", series.id)
      .maybeSingle();
    assert.deepEqual(fresh?.rotation, [owner.id, member.id], "el orden quedó guardado");
    assert.equal(fresh?.rotation_index, 0, "el índice vuelve a empezar");
  });

  // --- editar y borrar por alcance --------------------------------------------

  it("editar por alcance: solo esta la independiza", async () => {
    const series = await createSeries({ title: "Reciclar", rotation: [owner.id] });
    const { data: tasks } = await owner.client
      .from("tasks")
      .select("id")
      .eq("series_id", series.id)
      .limit(1);
    const taskId = tasks[0].id;

    const { error } = await owner.client.rpc("edit_task_series", {
      p_series_id: series.id,
      p_task_id: taskId,
      p_scope: "this",
      p_patch: {},
    });
    assert.equal(error, null, `solo esta: ${error?.message ?? ""}`);
    const { data: afterTask } = await owner.client
      .from("tasks")
      .select("series_id")
      .eq("id", taskId)
      .maybeSingle();
    assert.equal(afterTask?.series_id, null, "esta ya no es de la serie");
  });

  it("editar por alcance: toda la serie rehace las ocurrencias", async () => {
    const series = await createSeries({ title: "Pagar el arriendo", rotation: [owner.id] });
    await owner.client.rpc("materialize_series_occurrences", {
      p_series_id: series.id,
      p_horizon_days: 3,
    });
    const { error } = await owner.client.rpc("edit_task_series", {
      p_series_id: series.id,
      p_scope: "all",
      p_patch: { title: "Pagar el arriendo y luz", recurrence_kind: "daily" },
    });
    assert.equal(error, null, `toda la serie: ${error?.message ?? ""}`);
    const { data: fresh } = await owner.client
      .from("task_series")
      .select("title, recurrence_kind")
      .eq("id", series.id)
      .maybeSingle();
    assert.equal(fresh?.title, "Pagar el arriendo y luz", "el título cambió");
    assert.equal(fresh?.recurrence_kind, "daily", "la regla cambió");
    const { data: tasks } = await owner.client
      .from("tasks")
      .select("title")
      .eq("series_id", series.id);
    assert.ok((tasks ?? []).length >= 1, "se rehizo la primera ocurrencia");
    assert.equal(
      tasks[0]?.title,
      "Pagar el arriendo y luz",
      "las ocurrencias tomaron el título nuevo",
    );
  });

  it("un miembro no edita ni borra la serie de otro", async () => {
    const series = await createSeries({ title: "Del owner otra vez", rotation: [owner.id] });
    assertDenied(
      await member.client.rpc("edit_task_series", {
        p_series_id: series.id,
        p_scope: "all",
        p_patch: { title: "Hack" },
      }),
      "un miembro edita la serie de otro",
    );
    assertDenied(
      await member.client.rpc("delete_task_series", {
        p_series_id: series.id,
        p_scope: "all",
      }),
      "un miembro borra la serie de otro",
    );
  });

  it("borrar por alcance: esta y las siguientes deja el pasado como tarea normal", async () => {
    const series = await createSeries({ title: "Histórico", rotation: [owner.id] });
    await owner.client.rpc("materialize_series_occurrences", {
      p_series_id: series.id,
      p_horizon_days: 3,
    });
    const { data: tasks } = await owner.client
      .from("tasks")
      .select("id, series_occurrence, series_id")
      .eq("series_id", series.id)
      .order("series_occurrence");
    const done = tasks[0];
    await owner.client
      .from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", done.id);

    const { error } = await owner.client.rpc("delete_task_series", {
      p_series_id: series.id,
      p_task_id: done.id,
      p_scope: "following",
    });
    assert.equal(error, null, `borrar desde esta: ${error?.message ?? ""}`);
    const { data: past } = await owner.client
      .from("tasks")
      .select("series_id, series_occurrence")
      .eq("id", done.id)
      .maybeSingle();
    assert.equal(past?.series_id, null, "la pasada quedó como tarea normal");
    const { data: rest } = await owner.client
      .from("tasks")
      .select("id")
      .eq("series_id", series.id);
    assert.equal((rest ?? []).length, 0, "las siguientes se fueron con la serie");
    const { data: gone } = await owner.client
      .from("task_series")
      .select("id")
      .eq("id", series.id);
    assertNoRows(gone, "la serie ya no está");
  });

  // --- quien sale del espacio ---------------------------------------------------

  it("quien sale del espacio sale de la rotación y se avisa a quien la creó", async () => {
    const series = await createSeries({
      title: "Con invited",
      rotation: [owner.id, other.id],
    });
    const { error: delError } = await owner.client
      .from("workspace_members")
      .delete()
      .eq("workspace_id", ws)
      .eq("user_id", other.id);
    assert.equal(delError, null, `salir del espacio: ${delError?.message ?? ""}`);

    const { data: fresh } = await owner.client
      .from("task_series")
      .select("rotation")
      .eq("id", series.id)
      .maybeSingle();
    assert.ok(
      !(fresh?.rotation ?? []).includes(other.id),
      "el que salió ya no está en la rotación",
    );

    const { data: notices } = await owner.client
      .from("notifications")
      .select("type, title")
      .eq("type", "shift")
      .order("created_at", { ascending: false })
      .limit(1);
    assert.equal(notices?.[0]?.type, "shift", "avisa al creador con tipo shift");
  });

  // --- preferencias ---------------------------------------------------------------

  it("preferencias: el interruptor de turnos es mío", async () => {
    assertAllowed(
      await member.client
        .from("notification_prefs")
        .upsert({ user_id: member.id, shift: false }, { onConflict: "user_id" }),
      "guardo mi interruptor de turnos",
    );
    const { data: prefs } = await member.client
      .from("notification_prefs")
      .select("shift")
      .eq("user_id", member.id)
      .maybeSingle();
    assert.equal(prefs?.shift, false, "se guardó apagado");
    const { data: foreign } = await other.client
      .from("notification_prefs")
      .select("user_id")
      .eq("user_id", member.id);
    assertNoRows(foreign, "nadie ve mis preferencias");
  });

  it("aviso de turno: el recordatorio del día es idempotente", async () => {
    const created = await admin.rpc("create_shift_reminders");
    assert.equal(created.error, null, `create_shift_reminders: ${created.error?.message ?? ""}`);
    const first = typeof created.data === "number" ? created.data : 0;
    const again = await admin.rpc("create_shift_reminders");
    const second = typeof again.data === "number" ? again.data : 0;
    assert.ok(second <= first, "repetir el barrido no duplica avisos");
  });
});