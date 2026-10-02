/**
 * RLS del resumen diario "Tu día" (daily_digest_prefs + notificaciones `daily`
 * + `create_daily_digests()` + trabajo `day_highlights`).
 *
 * - Preferencias: cada usuario solo las suyas (ver, guardar, editar, borrar).
 * - Tipo `daily`: se puede insertar lo propio y viaja con su interruptor en
 *   `notification_prefs` (sin fila = todo activado).
 * - `create_daily_digests()`: SQL barato sin LLM; arma UNA notificación con
 *   texto concreto (eventos de hoy, tareas, listas, encuestas), idempotente
 *   por usuario y día local (segunda corrida no duplica) y respeta días
 *   hábiles y "no avisar en vacío".
 * - `day_highlights`: se encola a nombre propio y su resultado lo lee el
 *   espacio, no un ajeno.
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
  messagePayload,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

/** Hora local de Santiago "HH:MM" de hace `backMin` minutos (ventana 15 min). */
function santiagoTime(backMin = 5) {
  const parts = new Intl.DateTimeFormat("es-CL", {
    timeZone: "America/Santiago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(Date.now() - backMin * 60_000));
  return parts;
}

/** Día local de Santiago "YYYYMMDD" (dedupe del resumen). */
function santiagoDay() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts.replaceAll("-", "");
}

describe("RLS: resumen diario", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  let ws;
  let project;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("daily-owner", "Owner");
    member = await createTestUser("daily-member", "Member");
    stranger = await createTestUser("daily-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Resumen"));
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

  it("preferencias: solo las mías (ver, guardar, editar, borrar)", async () => {
    assertAllowed(
      await owner.client.from("daily_digest_prefs").insert({
        user_id: owner.id,
        enabled: true,
        digest_time: "08:00",
        timezone: "America/Santiago",
        days: "all",
        workspace_ids: [],
        send_when_empty: false,
      }),
      "guardo mis preferencias del resumen",
    );

    const seen = await stranger.client
      .from("daily_digest_prefs")
      .select("user_id")
      .eq("user_id", owner.id);
    assert.equal(seen.error, null, "leer ajeno no da error");
    assertNoRows(seen.data, "un ajeno no ve mis preferencias");

    assertDenied(
      await stranger.client.from("daily_digest_prefs").insert({
        user_id: owner.id,
        enabled: false,
      }),
      "un ajeno no guarda preferencias a mi nombre",
    );

    const hijack = await stranger.client
      .from("daily_digest_prefs")
      .update({ enabled: false })
      .eq("user_id", owner.id)
      .select("user_id");
    assert.equal((hijack.data ?? []).length, 0, "un ajeno no edita mis preferencias");

    const gone = await owner.client
      .from("daily_digest_prefs")
      .delete()
      .eq("user_id", owner.id)
      .select("user_id");
    assert.equal((gone.data ?? []).length, 1, "yo sí borro mis preferencias");
  });

  it("el tipo daily existe y viaja con su interruptor", async () => {
    const note = await owner.client
      .from("notifications")
      .insert({
        user_id: owner.id,
        workspace_id: null,
        type: "daily",
        title: "Tu día",
        body: "Hoy: 1 evento.",
        link: "/inicio?vista=dia",
      })
      .select("id");
    assertAllowed(note, "el tipo daily está permitido en notifications");
    await admin.from("notifications").delete().eq("id", note.data.id);

    assertAllowed(
      await owner.client.from("notification_prefs").upsert({
        user_id: owner.id,
        daily: false,
      }),
      "el interruptor daily existe en notification_prefs",
    );
    await owner.client.from("notification_prefs").upsert({
      user_id: owner.id,
      daily: true,
    });
  });

  it("el resumen agrupa el día y es idempotente por día local", async () => {
    // Datos de hoy: 1 evento, 1 tarea que vence (asignada al owner), 1 lista
    // fijada con pendiente y 1 encuesta abierta sin su voto.
    const now = Date.now();
    assertAllowed(
      await owner.client.from("events").insert({
        workspace_id: ws,
        title: "Dentista",
        description: "",
        starts_at: new Date(now + 3600_000).toISOString(),
        ends_at: new Date(now + 7200_000).toISOString(),
        all_day: false,
        location: "",
        color: "#1d9bf0",
        created_by: owner.id,
        attendees: [],
        reminder_minutes: [],
        recurrence: null,
      }),
      "evento de hoy",
    );
    assertAllowed(
      await owner.client.from("tasks").insert({
        project_id: project,
        workspace_id: ws,
        title: "Comprar torta",
        notes: "",
        status: "todo",
        priority: "normal",
        assignee_ids: [owner.id],
        due_at: new Date(now + 3600_000).toISOString(),
        created_by: owner.id,
      }),
      "tarea que vence hoy",
    );
    const list = await owner.client
      .from("lists")
      .insert({
        workspace_id: ws,
        title: "Súper",
        emoji: "🛒",
        color: "#1d9bf0",
        kind: "groceries",
        pinned: true,
        archived: false,
        created_by: owner.id,
      })
      .select("id")
      .single();
    assertAllowed(list, "lista fijada");
    assertAllowed(
      await owner.client.from("list_items").insert({
        list_id: list.data.id,
        workspace_id: ws,
        text: "Leche",
        created_by: owner.id,
      }),
      "ítem pendiente",
    );
    const message = await owner.client
      .from("messages")
      .insert({
        workspace_id: ws,
        chat_id: "general",
        author_id: owner.id,
        author_name: "Owner",
        ...messagePayload({ text: "¿Pizza o sushi?", type: "card" }),
      })
      .select("id")
      .single();
    assertAllowed(message, "mensaje de la encuesta");
    const poll = await owner.client
      .from("polls")
      .insert({
        message_id: message.data.id,
        workspace_id: ws,
        chat_id: "general",
        question: "¿Pizza o sushi?",
        kind: "single",
        created_by: owner.id,
      })
      .select("id")
      .single();
    assertAllowed(poll, "encuesta abierta");
    await owner.client.from("poll_options").insert([
      { poll_id: poll.data.id, workspace_id: ws, text: "Pizza", position: 1024, added_by: owner.id },
      { poll_id: poll.data.id, workspace_id: ws, text: "Sushi", position: 2048, added_by: owner.id },
    ]);

    // Preferencias: hora local de Santiago dentro de la ventana de 15 min.
    await owner.client.from("daily_digest_prefs").upsert({
      user_id: owner.id,
      enabled: true,
      digest_time: santiagoTime(5),
      timezone: "America/Santiago",
      days: "all",
      workspace_ids: [],
      send_when_empty: false,
    });
    await admin
      .from("notifications")
      .delete()
      .eq("user_id", owner.id)
      .like("dedupe", "daily:%");

    const first = await admin.rpc("create_daily_digests");
    assertAllowed(first, "create_daily_digests corre");
    assert.ok((first.data ?? 0) >= 1, "genera al menos el resumen del owner");

    const notes = await admin
      .from("notifications")
      .select("type, title, body, link, dedupe")
      .eq("user_id", owner.id)
      .eq("dedupe", `daily:${santiagoDay()}`);
    assert.equal((notes.data ?? []).length, 1, "un solo resumen por día local");
    assert.equal(notes.data[0].type, "daily", "tipo daily");
    assert.equal(notes.data[0].link, "/inicio?vista=dia", "el link abre Tu día");
    assert.ok(
      notes.data[0].body.includes("evento") && notes.data[0].body.includes("tarea"),
      `texto concreto con eventos y tareas (fue: ${notes.data[0].body})`,
    );

    // Segunda corrida: idempotente, no duplica.
    await admin.rpc("create_daily_digests");
    const again = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", owner.id)
      .eq("dedupe", `daily:${santiagoDay()}`);
    assert.equal((again.data ?? []).length, 1, "repetir no duplica el resumen");
  });

  it("solo hábiles y vacío sin aviso: ese día no sale push", async () => {
    // Member con días hábiles: si hoy es fin de semana en Santiago, se salta.
    const weekday = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", weekday: "short" }).format(new Date()) === "Sat" ||
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", weekday: "short" }).format(new Date()) === "Sun"
        ? 0
        : 1,
    );
    await member.client.from("daily_digest_prefs").upsert({
      user_id: member.id,
      enabled: true,
      digest_time: santiagoTime(5),
      timezone: "America/Santiago",
      days: "weekdays",
      workspace_ids: [],
      send_when_empty: false,
    });
    await admin
      .from("notifications")
      .delete()
      .eq("user_id", member.id)
      .like("dedupe", "daily:%");

    await admin.rpc("create_daily_digests");
    const notes = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", member.id)
      .eq("dedupe", `daily:${santiagoDay()}`);
    // Member no tiene nada pendiente (los datos son del owner): sin aviso en
    // vacío no sale nada; en fin de semana tampoco por días hábiles.
    if (weekday === 0) {
      assertNoRows(notes.data, "en fin de semana no sale con solo hábiles");
    } else {
      assertNoRows(notes.data, "sin nada pendiente y sin aviso en vacío no sale push");
    }
  });

  it("destacados: trabajo day_highlights propio y visible en el espacio", async () => {
    const job = await member.client
      .from("ai_jobs")
      .insert({
        workspace_id: ws,
        requested_by: member.id,
        type: "day_highlights",
        payload: { user_id: member.id, date: "2026-10-02" },
      })
      .select("id, status")
      .single();
    assertAllowed(job, "el tipo day_highlights está permitido en ai_jobs");
    assert.equal(job.data.status, "queued", "el trabajo nace en cola (lo despierta el trigger)");

    await admin
      .from("ai_jobs")
      .update({ status: "done", result: { summary: "Lo importante de hoy." } })
      .eq("id", job.data.id);

    const read = await owner.client
      .from("ai_jobs")
      .select("result")
      .eq("id", job.data.id)
      .maybeSingle();
    assertAllowed(read, "otro miembro del espacio lee el resultado");
    assert.equal(read.data.result.summary, "Lo importante de hoy.", "llega al espacio");

    const denied = await member.client
      .from("ai_jobs")
      .insert({
        workspace_id: ws,
        requested_by: owner.id,
        type: "day_highlights",
        payload: { user_id: owner.id, date: "2026-10-02" },
      })
      .select("id");
    assertDenied(denied, "no se puede encolar un trabajo a nombre de otro");
  });
});
