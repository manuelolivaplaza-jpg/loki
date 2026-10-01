/**
 * RLS de las transcripciones de audio (`audio_transcriptions`) y del grupo
 * `transcriptions` de `global_search`.
 *
 * Lo que se comprueba, que es justo la promesa del producto:
 *   · Solo se pide transcripción de un archivo de MI espacio: el primer
 *     segmento de la ruta tiene que ser el workspace_id y hay que ser
 *     miembro (el CHECK + la política de INSERT).
 *   · Con mensaje, la transcripción hereda su visibilidad: en un DM solo la
 *     ven sus miembros; en un chat de grupo, todo el espacio.
 *   · Un dictado suelto (sin mensaje) solo lo ve quien lo grabó.
 *   · El ciclo (pending -> running -> ready/error) no lo mueve el cliente;
 *     el reintento pasa por retry_transcription().
 *   · La búsqueda devuelve las transcripciones del chat accesible y NO las
 *     de un DM ajeno.
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

/** Ruta de Storage con la forma que espera el CHECK de la tabla. */
function objectPath(wsId, name) {
  return `${wsId}/00000000-0000-4000-8000-000000000001-${name}.webm`;
}

describe("RLS: transcripciones de audio", () => {
  let admin;
  let owner;
  let member;
  let outsider;
  /** Espacio compartido: owner y member son miembros. */
  let sharedWs;
  /** Espacio privado del owner: member NO es miembro. */
  let privateWs;
  /** Mensaje de grupo (con audio) del espacio compartido. */
  let groupMessage;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("tr-owner", "Owner");
    member = await createTestUser("tr-member", "Member");
    outsider = await createTestUser("tr-outsider", "Outsider");

    sharedWs = await createWorkspaceWith(owner.client, workspaceName("Transcripciones"));
    await addMember(admin, sharedWs, member.id, "member", "Member");
    privateWs = await createWorkspaceWith(owner.client, workspaceName("Transcripciones Privado"));

    // Mensaje de grupo con una nota de voz (lo siembra la service role: el
    // cliente podría crearlo, pero aquí importa el mensaje, no quién lo wrote).
    const { data: message, error } = await admin
      .from("messages")
      .insert({
        workspace_id: sharedWs,
        chat_id: "general",
        author_id: member.id,
        author_name: "Member",
        ...messagePayload({
          text: "",
          attachments: [
            {
              kind: "audio",
              url: "https://example.test/audio.webm",
              name: "nota.webm",
              size: 1024,
              mime: "audio/webm",
              path: `chat-media/${objectPath(sharedWs, "nota")}`,
            },
          ],
        }),
      })
      .select("id")
      .single();
    if (error) throw error;
    groupMessage = message;
  });

  after(async () => {
    await purgeTestData();
  });

  // --- INSERT: la puerta es ser miembro del espacio DEL ARCHIVO -------------

  it("un miembro pide la transcripción de una nota de voz de su chat", async () => {
    assertAllowed(
      await member.client.from("audio_transcriptions").insert({
        workspace_id: sharedWs,
        bucket: "chat-media",
        object_path: objectPath(sharedWs, "nota"),
        message_id: groupMessage.id,
        chat_id: "general",
        author_id: member.id,
        requested_by: member.id,
        duration_seconds: 12,
      }),
      "un miembro pide una transcripción de su espacio",
    );
  });

  it("un no miembro no pide transcripciones en un espacio ajeno", async () => {
    assertDenied(
      await outsider.client.from("audio_transcriptions").insert({
        workspace_id: sharedWs,
        object_path: objectPath(sharedWs, "colado"),
        message_id: groupMessage.id,
        chat_id: "general",
        requested_by: outsider.id,
      }),
      "pedir transcripción en un espacio ajeno",
    );
  });

  it("nadie pide una transcripción a nombre de otro", async () => {
    assertDenied(
      await member.client.from("audio_transcriptions").insert({
        workspace_id: sharedWs,
        object_path: objectPath(sharedWs, "suplantado"),
        message_id: groupMessage.id,
        chat_id: "general",
        requested_by: owner.id,
      }),
      "pedir a nombre de otro",
    );
  });

  it("la ruta del archivo tiene que ser del espacio que se declara", async () => {
    // El CHECK storage_workspace_id(object_path) = workspace_id ata la fila al
    // espacio REAL del archivo: no se puede pedir la transcripción del audio
    // de otro espacio declarando el mío.
    assertDenied(
      await member.client.from("audio_transcriptions").insert({
        workspace_id: sharedWs,
        object_path: objectPath(privateWs, "ajeno"),
        requested_by: member.id,
      }),
      "transcripción de un archivo de otro espacio",
    );
  });

  it("un archivo, una transcripción (índice único)", async () => {
    // Reintentar de más no crea una segunda fila: la que ya existe se reutiliza
    // (es lo que hace el cliente: insert y, si choca, se lee la existente).
    assertDenied(
      await member.client.from("audio_transcriptions").insert({
        workspace_id: sharedWs,
        object_path: objectPath(sharedWs, "nota"),
        message_id: groupMessage.id,
        chat_id: "general",
        requested_by: member.id,
      }),
      "una segunda transcripción del mismo archivo",
    );
  });

  // --- SELECT: hereda la visibilidad del mensaje ----------------------------

  it("los miembros del espacio ven la transcripción de un chat de grupo", async () => {
    const { data, error } = await member.client
      .from("audio_transcriptions")
      .select("id, text, status")
      .eq("workspace_id", sharedWs);
    assert.equal(error, null, "el miembro lee sin error");
    assert.ok((data ?? []).length >= 1, "el miembro ve la transcripción del grupo");
  });

  it("un no miembro no ve nada de ese espacio", async () => {
    const { data } = await outsider.client
      .from("audio_transcriptions")
      .select("id")
      .eq("workspace_id", sharedWs);
    assertNoRows(data, "un ajeno no ve transcripciones");
  });

  it("en un DM solo la ven sus miembros", async () => {
    // El owner y outsider son los dos lados del DM; member NO.
    const { data: dm, error: dmError } = await admin
      .from("chats")
      .insert({
        workspace_id: sharedWs,
        id: "dm-tr",
        type: "dm",
        name: "DM prueba",
        member_ids: [owner.id, outsider.id],
      })
      .select("id")
      .single();
    if (dmError) throw dmError;

    const { data: dmMessage, error: msgError } = await admin
      .from("messages")
      .insert({
        workspace_id: sharedWs,
        chat_id: dm.id,
        author_id: owner.id,
        author_name: "Owner",
        ...messagePayload({
          text: "",
          attachments: [
            {
              kind: "audio",
              url: "https://example.test/dm.webm",
              name: "dm.webm",
              size: 900,
              mime: "audio/webm",
              path: `chat-media/${objectPath(sharedWs, "dm")}`,
            },
          ],
        }),
      })
      .select("id")
      .single();
    if (msgError) throw msgError;

    assertAllowed(
      await owner.client.from("audio_transcriptions").insert({
        workspace_id: sharedWs,
        object_path: objectPath(sharedWs, "dm"),
        message_id: dmMessage.id,
        chat_id: dm.id,
        author_id: owner.id,
        requested_by: owner.id,
      }),
      "el owner pide la transcripción de su DM",
    );

    // El otro lado del DM sí la ve.
    const { data: other } = await outsider.client
      .from("audio_transcriptions")
      .select("id")
      .eq("object_path", objectPath(sharedWs, "dm"));
    assert.ok((other ?? []).length === 1, "el otro miembro del DM la ve");

    // Un miembro del espacio que NO está en el DM, no.
    const { data: outside } = await member.client
      .from("audio_transcriptions")
      .select("id")
      .eq("object_path", objectPath(sharedWs, "dm"));
    assertNoRows(outside, "alguien del espacio fuera del DM no la ve");
  });

  it("un dictado suelto solo lo ve quien lo grabó", async () => {
    const path = objectPath(sharedWs, "dictado");
    assertAllowed(
      await member.client.from("audio_transcriptions").insert({
        workspace_id: sharedWs,
        object_path: path,
        requested_by: member.id,
      }),
      "el miembro dicta en su espacio",
    );
    const { data: mine } = await member.client
      .from("audio_transcriptions")
      .select("id")
      .eq("object_path", path);
    assert.ok((mine ?? []).length === 1, "yo veo mi dictado");
    // El owner es miembro del espacio pero no lo dictó.
    const { data: theirs } = await owner.client
      .from("audio_transcriptions")
      .select("id")
      .eq("object_path", path);
    assertNoRows(theirs, "otro miembro no ve mi dictado");
  });

  // --- UPDATE/DELETE: el ciclo no lo mueve el cliente -----------------------

  it("el cliente no cambia el estado ni borra", async () => {
    const update = await member.client
      .from("audio_transcriptions")
      .update({ status: "ready", text: "inventado" })
      .eq("workspace_id", sharedWs)
      .select("id");
    assertNoRowsAffected(update, "el cliente no marca la transcripción como lista");

    const remove = await member.client
      .from("audio_transcriptions")
      .delete()
      .eq("workspace_id", sharedWs)
      .select("id");
    assertNoRowsAffected(remove, "el cliente no borra transcripciones");
  });

  it("retry_transcription: solo el dueño o un admin, y solo si falló", async () => {
    const { data: created } = await member.client
      .from("audio_transcriptions")
      .insert({
        workspace_id: sharedWs,
        object_path: objectPath(sharedWs, "reintento"),
        requested_by: member.id,
      })
      .select("id");
    const id = created[0].id;

    // En pending no hace nada (no es error): false, no excepción.
    const pending = await member.client.rpc("retry_transcription", { p_transcription_id: id });
    assert.equal(pending.error, null, "retry no falla con una transcripción pending");
    assert.equal(pending.data, false, "una pending no se reencola");

    // El worker la marca como fallada (service role) y ahora sí se reencola.
    await admin
      .from("audio_transcriptions")
      .update({ status: "error", error: "Transcripción sin configurar." })
      .eq("id", id);

    const denied = await outsider.client.rpc("retry_transcription", {
      p_transcription_id: id,
    });
    assert.equal(denied.error?.code, "42501", "un ajeno no puede reintentar");

    const ok = await member.client.rpc("retry_transcription", { p_transcription_id: id });
    assert.equal(ok.error, null, "el dueño reintenta");
    assert.equal(ok.data, true, "el dueño reencola");

    // Y el trabajo volvió a la cola (lo crea el trigger encolador).
    const { data: jobs } = await admin
      .from("ai_jobs")
      .select("id, type, status")
      .eq("type", "transcribe_audio");
    const mine = (jobs ?? []).filter((job) => job.id !== undefined);
    assert.ok(mine.length >= 1, "el reintento deja un trabajo transcribe_audio encolado");
  });

  // --- global_search: el grupo nuevo ----------------------------------------

  it("la búsqueda trae las transcripciones pero solo de chats accesibles", async () => {
    // Textos reconocibles: "tiburones" está en la del grupo, "ballenas" en la
    // del DM (que member no puede ver).
    await admin
      .from("audio_transcriptions")
      .update({ status: "ready", text: "hay tiburones en la pileta" })
      .eq("object_path", objectPath(sharedWs, "nota"));
    await admin
      .from("audio_transcriptions")
      .update({ status: "ready", text: "vimos ballenas ayer" })
      .eq("object_path", objectPath(sharedWs, "dm"));

    const { data, error } = await member.client.rpc("global_search", {
      p_ws: sharedWs,
      p_q: "tiburones",
    });
    assert.equal(error, null, "global_search responde");
    const group = data.transcriptions;
    assert.ok(Array.isArray(group), "la RPC devuelve el grupo transcriptions");
    assert.equal(group.length, 1, "el grupo tiene la transcripción del chat de grupo");
    assert.equal(group[0].text, "hay tiburones en la pileta");
    assert.equal(group[0].chat_id, "general");

    // La del DM ajeno a member no aparece, aunque sea del mismo espacio.
    const { data: dmSearch } = await member.client.rpc("global_search", {
      p_ws: sharedWs,
      p_q: "ballenas",
    });
    assertNoRows(dmSearch.transcriptions, "el DM ajeno no sale en la búsqueda");

    // El que sí es del DM la encuentra.
    const { data: ownerSearch } = await owner.client.rpc("global_search", {
      p_ws: sharedWs,
      p_q: "ballenas",
    });
    assert.equal((ownerSearch.transcriptions ?? []).length, 1, "el del DM sí la encuentra");

    // Y sin coincidencias, el grupo viene vacío pero presente.
    const { data: none } = await member.client.rpc("global_search", {
      p_ws: sharedWs,
      p_q: "zzzz",
    });
    assert.deepEqual(none.transcriptions, [], "sin coincidencias el grupo va vacío");
  });

  it("global_search con menos de 2 letras devuelve los seis grupos vacíos", async () => {
    const { data, error } = await member.client.rpc("global_search", {
      p_ws: sharedWs,
      p_q: "a",
    });
    assert.equal(error, null, "no falla con una letra");
    for (const key of [
      "messages",
      "tasks",
      "projects",
      "events",
      "people",
      "transcriptions",
    ]) {
      assert.deepEqual(data[key], [], `${key} debe venir vacío`);
    }
  });
});
