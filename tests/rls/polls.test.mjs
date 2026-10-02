/**
 * RLS de encuestas (polls, poll_options, poll_votes) + tarjeta en el chat +
 * cierre por tiempo y recordatorio "falta tu voto".
 *
 * - Ver y votar: quien puede ver el chat (can_access_chat). Un ajeno no ve la
 *   encuesta ni puede votarla ni crear una.
 * - Opción única y sí/no: un solo voto por persona (cambiar borra el anterior).
 * - Encuesta cerrada: nadie vota (ni por RPC ni por insert directo).
 * - Anónimas: la RLS no deja ver los votos ajenos y `poll_results` tampoco los
 *   expone; en las no anónimas sí (para los avatares de la tarjeta).
 * - Opciones: cualquiera sugiere si la encuesta lo permite; con la opción
 *   cerrada solo creador o admin.
 * - Cierre: solo creador o admin (o cualquiera si closeBy = 'anyone').
 * - Tick: cierra las vencidas y avisa UNA vez a quien no votó.
 * - Disponibilidad de las opciones con fecha: solo el número de ocupados.
 * - Resumen con Loki: el trabajo `poll_summary` se encola a nombre propio y su
 *   resultado lo ve el espacio (nada más).
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
  messagePayload,
  purgeTestData,
  workspaceName,
} from "./_helpers.mjs";

const POLL_META = (pollId) => ({ kind: "poll", poll_id: pollId });

/** Crea el mensaje 'card' + la encuesta + `options` y devuelve ids. */
async function createPoll(client, { wsId, chatId, uid, name, question, kind, settings, options }) {
  const message = await client
    .from("messages")
    .insert({
      workspace_id: wsId,
      chat_id: chatId,
      author_id: uid,
      author_name: name,
      ...messagePayload({ text: question, type: "card" }),
    })
    .select("id")
    .single();
  assertAllowed(message, `mensaje de la encuesta "${question}"`);
  const poll = await client
    .from("polls")
    .insert({
      message_id: message.data.id,
      workspace_id: wsId,
      chat_id: chatId,
      question,
      kind,
      settings,
      created_by: uid,
    })
    .select("id")
    .single();
  assertAllowed(poll, `encuesta "${question}"`);
  const pollId = poll.data.id;
  await client
    .from("messages")
    .update({ meta: POLL_META(pollId) })
    .eq("id", message.data.id);
  const optionIds = [];
  let position = 1024;
  for (const option of options) {
    const row = await client
      .from("poll_options")
      .insert({
        poll_id: pollId,
        workspace_id: wsId,
        text: option.text,
        starts_at: option.startsAt ?? null,
        ends_at: option.endsAt ?? null,
        position,
        added_by: uid,
      })
      .select("id")
      .single();
    assertAllowed(row, `opción "${option.text}"`);
    optionIds.push(row.data.id);
    position += 1024;
  }
  return { messageId: message.data.id, pollId, optionIds };
}

describe("RLS: encuestas", () => {
  let admin;
  let owner;
  let member;
  let plain;
  let stranger;
  let ws;
  let chatId;
  let dmChatId;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("poll-owner", "Owner");
    member = await createTestUser("poll-member", "Member");
    plain = await createTestUser("poll-plain", "Plain");
    stranger = await createTestUser("poll-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Encuestas"));
    await addMember(admin, ws, member.id, "member", "Member");
    await addMember(admin, ws, plain.id, "member", "Plain");

    const { data: chats } = await owner.client
      .from("chats")
      .select("id")
      .eq("workspace_id", ws)
      .eq("type", "group")
      .limit(1);
    chatId = chats[0].id;
    await owner.client.from("chats").update({ name: "General" }).eq("workspace_id", ws).eq("id", chatId);
    dmChatId = "00000000-0000-0000-0000-0000000000aa";
    await admin.from("chats").insert({
      workspace_id: ws,
      id: dmChatId,
      type: "dm",
      name: "Owner y Member",
      member_ids: [owner.id, member.id],
      created_by: owner.id,
    });
  });

  after(async () => {
    await purgeTestData();
  });

  it("un miembro crea la encuesta y un ajeno ni la ve ni la crea", async () => {
    const created = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Pizza o sushi?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "Pizza" }, { text: "Sushi" }],
    });
    assert.ok(created.pollId !== undefined, "la encuesta se creo");

    const seen = await stranger.client.from("polls").select("id").eq("id", created.pollId);
    assert.equal(seen.error, null, "leer ajeno no da error");
    assertNoRows(seen.data, "un ajeno no ve la encuesta");

    const foreign = await stranger.client.from("polls").insert({
      message_id: created.messageId,
      workspace_id: ws,
      chat_id: chatId,
      question: "Ajena",
      kind: "single",
      created_by: stranger.id,
    });
    assertDenied(foreign, "un ajeno no crea encuestas");
  });

  it("vota quien puede ver el chat; en opción única queda un solo voto", async () => {
    const { pollId, optionIds } = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Qué day hacemos el asado?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "Viernes" }, { text: "Sábado" }],
    });

    const first = await owner.client.rpc("cast_poll_vote", {
      p_poll_id: pollId,
      p_option_ids: [optionIds[0]],
    });
    assertAllowed(first, "el owner vota");

    // Cambiar de opción no acumula: sigue habiendo un voto suyo.
    const changed = await owner.client.rpc("cast_poll_vote", {
      p_poll_id: pollId,
      p_option_ids: [optionIds[1]],
    });
    assertAllowed(changed, "cambiar de voto");

    const { data: mine } = await owner.client
      .from("poll_votes")
      .select("option_id")
      .eq("poll_id", pollId)
      .eq("user_id", owner.id);
    assert.equal((mine ?? []).length, 1, "un solo voto en opción única");
    assert.equal(mine[0].option_id, optionIds[1], "quedó el nuevo");

    // Múltiples sí acumula.
    const multi = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Qué llevo?",
      kind: "multiple",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "Carne" }, { text: "Pan" }, { text: "Postre" }],
    });
    const both = await owner.client.rpc("cast_poll_vote", {
      p_poll_id: multi.pollId,
      p_option_ids: [multi.optionIds[0], multi.optionIds[2]],
    });
    assertAllowed(both, "voto múltiple");
    const { data: twoVotes } = await owner.client
      .from("poll_votes")
      .select("option_id")
      .eq("poll_id", multi.pollId)
      .eq("user_id", owner.id);
    assert.equal((twoVotes ?? []).length, 2, "en múltiple se acumulan");
  });

  it("un ajeno no vota y una encuesta cerrada tampoco", async () => {
    const { pollId, optionIds } = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Aprobamos el diseño?",
      kind: "yesno",
      settings: { anonymous: false, allowSuggestions: false, remindMissing: false, closeBy: "creator" },
      options: [{ text: "Sí" }, { text: "No" }],
    });

    // Ajeno al espacio: la RPC lo rechaza.
    const foreignVote = await stranger.client.rpc("cast_poll_vote", {
      p_poll_id: pollId,
      p_option_ids: [optionIds[0]],
    });
    assertDenied(foreignVote, "un ajeno no vota");
    // …ni por insert directo (RLS + guarda).
    const foreignInsert = await stranger.client
      .from("poll_votes")
      .insert({ poll_id: pollId, option_id: optionIds[0], user_id: stranger.id })
      .select("id");
    assertDenied(foreignInsert, "insert directo de un ajeno");

    // Cerrada: ni RPC ni insert.
    const closed = await member.client.rpc("close_poll", { p_poll_id: pollId });
    assertAllowed(closed, "el creador cierra");
    const afterClose = await owner.client.rpc("cast_poll_vote", {
      p_poll_id: pollId,
      p_option_ids: [optionIds[0]],
    });
    assertDenied(afterClose, "no se vota una encuesta cerrada");
    const insertAfterClose = await owner.client
      .from("poll_votes")
      .insert({ poll_id: pollId, option_id: optionIds[0], user_id: owner.id })
      .select("id");
    assertDenied(insertAfterClose, "insert directo en encuesta cerrada");

    // Sin votos, la tarjeta no tiene ganador.
    const result = await owner.client.rpc("poll_results", { p_poll_id: pollId });
    assertAllowed(result, "poll_results de una cerrada");
    assert.equal(result.data.winners.length, 0, "sin votos no hay ganador");
    assert.equal(result.data.isOpen, false, "queda cerrada");
  });

  it("anonima: la RLS y poll_results ocultan quien voto", async () => {
    const anon = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Anonima?",
      kind: "single",
      settings: { anonymous: true, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "Sí" }, { text: "No" }],
    });
    const open = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Con nombre?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "Sí" }, { text: "No" }],
    });

    for (const poll of [anon, open]) {
      const voted = await owner.client.rpc("cast_poll_vote", {
        p_poll_id: poll.pollId,
        p_option_ids: [poll.optionIds[0]],
      });
      assertAllowed(voted, "el owner vota");
    }

    // El membro (autor de ambas) no ve los votos del owner en la anónima.
    const rows = await member.client
      .from("poll_votes")
      .select("poll_id, user_id")
      .in("poll_id", [anon.pollId, open.pollId]);
    assert.equal(rows.error, null, "leer votos no da error");
    const anonVotes = (rows.data ?? []).filter((row) => row.poll_id === anon.pollId);
    const openVotes = (rows.data ?? []).filter((row) => row.poll_id === open.pollId);
    assertNoRows(anonVotes, "en la anonima no se ven los votos de otros");
    assert.equal((openVotes ?? []).length, 1, "en la normal si");

    // La RPC tampoco los expone (aunque corra como security definer).
    const anonResult = await member.client.rpc("poll_results", { p_poll_id: anon.pollId });
    assertAllowed(anonResult, "poll_results anonima");
    assert.equal(anonResult.data.anonymous, true, "marca anonima");
    for (const option of anonResult.data.options) {
      assert.equal(option.voters.length, 0, "la anonima no expone los voters");
    }
    assert.equal(anonResult.data.missing.length, 0, "la anonima no dice quien falta");
    assert.equal(anonResult.data.missingCount >= 0, true, "si cuenta los que faltan");

    const openResult = await member.client.rpc("poll_results", { p_poll_id: open.pollId });
    assertAllowed(openResult, "poll_results normal");
    assert.equal(openResult.data.options[0].voters[0], owner.id, "la normal si dice quien voto");
    assert.ok(
      openResult.data.missing.includes(plain.id),
      "dice quien falta por votar",
    );
  });

  it("opciones: cerradas solo el creador o un admin", async () => {
    const free = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Donde comemos?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "Casa" }],
    });
    const suggested = await plain.client
      .from("poll_options")
      .insert({
        poll_id: free.pollId,
        workspace_id: ws,
        text: "Restaurante",
        position: 2048,
        added_by: plain.id,
      })
      .select("id");
    assertAllowed(suggested, "cualquiera sugiere si la encuesta lo permite");

    const locked = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Solo mis opciones?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: false, remindMissing: false, closeBy: "creator" },
      options: [{ text: "A" }, { text: "B" }],
    });
    const denied = await plain.client
      .from("poll_options")
      .insert({
        poll_id: locked.pollId,
        workspace_id: ws,
        text: "C",
        position: 3072,
        added_by: plain.id,
      })
      .select("id");
    assertDenied(denied, "sin allowSuggestions solo creador o admin");

    const byOwner = await owner.client
      .from("poll_options")
      .insert({
        poll_id: locked.pollId,
        workspace_id: ws,
        text: "D",
        position: 4096,
        added_by: owner.id,
      })
      .select("id");
    assertAllowed(byOwner, "un admin si puede agregar opciones");

    // Nadie mueve la opción de encuesta ni su autor.
    const hijack = await plain.client
      .from("poll_options")
      .update({ poll_id: free.pollId })
      .eq("id", locked.optionIds[0])
      .select("id");
    assertNoRowsAffected(hijack, "no se cambia el poll_id de una opción");
  });

  it("cerrar: solo creador o admin, salvo closeBy=anyone", async () => {
    const creatorOnly = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Cierra el creador?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "A" }, { text: "B" }],
    });
    const denied = await plain.client.rpc("close_poll", { p_poll_id: creatorOnly.pollId });
    assertDenied(denied, "un miembro raso no cierra");
    const byAdmin = await owner.client.rpc("close_poll", { p_poll_id: creatorOnly.pollId });
    assertAllowed(byAdmin, "un admin si cierra");

    const anyone = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Cierra cualquiera?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "anyone" },
      options: [{ text: "A" }, { text: "B" }],
    });
    const byMember = await plain.client.rpc("close_poll", { p_poll_id: anyone.pollId });
    assertAllowed(byMember, "con closeBy=anyone cierra cualquier miembro del chat");

    const byStranger = await stranger.client.rpc("close_poll", { p_poll_id: anyone.pollId });
    assertDenied(byStranger, "pero un ajeno no");
  });

  it("el tick cierra lo vencido y avisa UNA vez a quien no voto", async () => {
    const { pollId } = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Vence ya?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: true, closeBy: "creator" },
      options: [{ text: "A" }, { text: "B" }],
    });
    // El owner vota: no debe recibir aviso. Plain y… quedan sin votar.
    await owner.client.rpc("cast_poll_vote", { p_poll_id: pollId, p_option_ids: [] });

    await admin
      .from("polls")
      .update({ closes_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", pollId);

    const tick = await admin.rpc("poll_tick");
    assertAllowed(tick, "poll_tick corre");

    const { data: poll } = await admin
      .from("polls")
      .select("closed_at")
      .eq("id", pollId)
      .single();
    assert.ok(poll.closed_at !== null, "el tick cierra la vencida");

    // Vencida: ya no hay aviso pendiente (el cierre gana).
    const { data: notes } = await admin
      .from("notifications")
      .select("id, user_id")
      .like("dedupe", `poll:${pollId}:%`);
    assertNoRows(notes, "una encuesta ya vencida no genera aviso de 'falta tu voto'");

    // Ahora una que vence en 30 min: aviso a quien no votó, una sola vez.
    const soon = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Vence en media hora?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: true, closeBy: "creator" },
      options: [{ text: "A" }, { text: "B" }],
    });
    await admin
      .from("polls")
      .update({ closes_at: new Date(Date.now() + 30 * 60_000).toISOString() })
      .eq("id", soon.pollId);
    await admin
      .from("notifications")
      .delete()
      .eq("type", "poll")
      .like("dedupe", `poll:${soon.pollId}:%`);

    await admin.rpc("poll_tick");
    const first = await admin
      .from("notifications")
      .select("user_id, link")
      .eq("type", "poll")
      .like("dedupe", `poll:${soon.pollId}:%`);
    assert.equal((first.data ?? []).length, 1, "un aviso por quien no voto (el owner votó)");
    const recipient = first.data[0].user_id;
    assert.ok(recipient !== member.id, "el creador no se avisa a sí mismo");
    assert.ok(first.data[0].link.includes("msg="), "el aviso abre el chat en la encuesta");

    // Segundo tick: el dedupe evita el duplicado.
    await admin.rpc("poll_tick");
    const second = await admin
      .from("notifications")
      .select("id")
      .eq("type", "poll")
      .like("dedupe", `poll:${soon.pollId}:%`);
    assert.equal((second.data ?? []).length, 1, "una sola notificacion por persona y encuesta");
  });

  it("encuesta de fecha: solo el numero de ocupados, nunca el detalle", async () => {
    const { pollId, optionIds } = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Que dia hacemos el asado?",
      kind: "date",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [
        {
          text: "Viernes",
          startsAt: "2026-11-13T21:00:00.000Z",
          endsAt: "2026-11-14T01:00:00.000Z",
        },
        {
          text: "Sábado",
          startsAt: "2026-11-14T21:00:00.000Z",
          endsAt: "2026-11-15T01:00:00.000Z",
        },
      ],
    });

    // Un evento el viernes con el owner de asistente (con imported de Google).
    await admin.from("events").insert({
      workspace_id: ws,
      title: "Cumple de Ana",
      starts_at: "2026-11-13T22:00:00.000Z",
      ends_at: "2026-11-13T23:30:00.000Z",
      attendees: [owner.id],
      external_id: "gcal-123",
      external_source: "google",
    });

    const busy = await plain.client.rpc("poll_option_busy", { p_poll_id: pollId });
    assertAllowed(busy, "poll_option_busy responde");
    const rows = busy.data.options;
    assert.equal(rows.length, 2, "una fila por opción");
    const friday = rows.find((row) => row.id === optionIds[0]);
    const saturday = rows.find((row) => row.id === optionIds[1]);
    assert.equal(friday.busy, 1, "el viernes hay 1 ocupado (los de Google cuentan)");
    assert.equal(saturday.busy, 0, "el sábado está libre");
    // Ni una letra del evento sale de la base.
    assert.equal(
      JSON.stringify(busy.data).includes("Cumple"),
      false,
      "la disponibilidad no expone el detalle del evento",
    );
  });

  it("en un dm solo votan y ven los del dm", async () => {
    const created = await createPoll(member.client, {
      wsId: ws,
      chatId: dmChatId,
      uid: member.id,
      name: "Member",
      question: "¿Privada?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "A" }, { text: "B" }],
    });

    // Miembro del espacio pero fuera del dm: ni la ve ni vota.
    const seen = await plain.client.from("polls").select("id").eq("id", created.pollId);
    assert.equal(seen.error, null, "leer un dm ajeno no da error");
    assertNoRows(seen.data, "un miembro fuera del dm no ve la encuesta");
    const vote = await plain.client.rpc("cast_poll_vote", {
      p_poll_id: created.pollId,
      p_option_ids: [created.optionIds[0]],
    });
    assertDenied(vote, "un miembro fuera del dm no vota");

    // Los del dm sí, y el padrón de "quién falta" son solo ellos.
    const voted = await owner.client.rpc("cast_poll_vote", {
      p_poll_id: created.pollId,
      p_option_ids: [created.optionIds[0]],
    });
    assertAllowed(voted, "un miembro del dm vota");
    const result = await owner.client.rpc("poll_results", { p_poll_id: created.pollId });
    assertAllowed(result, "poll_results del dm");
    assert.equal(result.data.membersCount, 2, "en el dm solo cuentan sus dos miembros");
  });

  it("borrar la encuesta: creador o admin, y se lleva los votos", async () => {
    const created = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Se puede borrar?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "A" }, { text: "B" }],
    });
    await owner.client.rpc("cast_poll_vote", {
      p_poll_id: created.pollId,
      p_option_ids: [created.optionIds[0]],
    });

    const denied = await plain.client.from("polls").delete().eq("id", created.pollId).select("id");
    assert.equal((denied.data ?? []).length, 0, "un miembro raso no borra");

    const byAdmin = await owner.client.from("polls").delete().eq("id", created.pollId).select("id");
    assert.equal((byAdmin.data ?? []).length, 1, "un admin si borra");

    const { data: votes } = await admin
      .from("poll_votes")
      .select("id")
      .eq("poll_id", created.pollId);
    assertNoRows(votes, "los votos caen en cascada");
  });

  it("resumen con Loki: trabajo poll_summary propio y visible en el espacio", async () => {
    const created = await createPoll(member.client, {
      wsId: ws,
      chatId,
      uid: member.id,
      name: "Member",
      question: "¿Resumen de la cena?",
      kind: "single",
      settings: { anonymous: false, allowSuggestions: true, remindMissing: false, closeBy: "creator" },
      options: [{ text: "A" }, { text: "B" }],
    });

    // Un miembro pide el resumen a nombre propio (lo mueve la service role).
    const job = await member.client
      .from("ai_jobs")
      .insert({
        workspace_id: ws,
        requested_by: member.id,
        type: "poll_summary",
        payload: { poll_id: created.pollId },
      })
      .select("id, status")
      .single();
    assertAllowed(job, "el tipo poll_summary está permitido en ai_jobs");
    assert.equal(job.data.status, "queued", "el trabajo nace en cola (lo despierta el trigger)");

    // El resultado lo escribe el worker y lo lee el espacio, no un ajeno.
    await admin
      .from("ai_jobs")
      .update({ status: "done", result: { summary: "Ganó A." } })
      .eq("id", job.data.id);

    const read = await owner.client
      .from("ai_jobs")
      .select("result")
      .eq("id", job.data.id)
      .maybeSingle();
    assertAllowed(read, "otro miembro del espacio lee el resultado");
    assert.equal(read.data.result.summary, "Ganó A.", "el resumen llega al espacio");

    // A nombre ajeno no: la política exige requested_by = auth.uid().
    const denied = await member.client
      .from("ai_jobs")
      .insert({
        workspace_id: ws,
        requested_by: owner.id,
        type: "poll_summary",
        payload: { poll_id: created.pollId },
      })
      .select("id");
    assertDenied(denied, "no se puede encolar un trabajo a nombre de otro");
  });
});
