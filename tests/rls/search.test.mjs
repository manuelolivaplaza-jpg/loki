/**
 * RLS de la búsqueda total (`global_search` con 12 grupos, `search_more`,
 * índice `message_attachments` y ajuste `workspace_search_settings`).
 *
 * Lo que se comprueba, que es justo la promesa del producto:
 *   · Todo lo que se guarda se encuentra: listas, ítems, encuestas, ideas,
 *     archivos por nombre y recuerdos no sensibles.
 *   · El índice de adjuntos lo alimenta el trigger al enviar el mensaje
 *     (nunca bloquea) y hereda la visibilidad del chat: un DM ajeno queda
 *     fuera con sus archivos y su OCR.
 *   · Los recuerdos sensibles, privados y caducados no salen en el global.
 *   · Filtros: `solo míos` deja solo lo propio; `search_more` pagina por
 *     grupo y rechaza grupos inventados; con menos de 2 letras todo vacío.
 *   · El OCR solo se encola si el espacio lo activó (y solo un admin lo
 *     activa); sin OCR, la imagen se encuentra por nombre.
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

const ATTACH_ID = "11111111-2222-4333-8333-111111111111";

function imageAttachment(wsId, name) {
  return {
    kind: "image",
    url: "https://example.test/foto.png",
    name,
    size: 2048,
    mime: "image/png",
    path: `chat-media/${wsId}/${ATTACH_ID}-${name}`,
  };
}

describe("RLS: búsqueda total", () => {
  let admin;
  let owner;
  let member;
  let outsider;
  let ws;
  let dmId = "dm-search";

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("busq-owner", "Sofi");
    member = await createTestUser("busq-member", "Member");
    outsider = await createTestUser("busq-outsider", "Outsider");

    ws = await createWorkspaceWith(owner.client, workspaceName("Busqueda"));
    await addMember(admin, ws, member.id, "member", "Member");

    // DM entre owner y outsider: member NO está.
    const { error: dmError } = await admin.from("chats").insert({
      workspace_id: ws,
      id: dmId,
      type: "dm",
      name: "DM búsqueda",
      member_ids: [owner.id, outsider.id],
    });
    if (dmError) throw dmError;

    // Mensaje de grupo con imagen + archivo (lo indexa el trigger).
    const { error: msgError } = await admin.from("messages").insert({
      workspace_id: ws,
      chat_id: "general",
      author_id: member.id,
      author_name: "Member",
      ...messagePayload({
        text: "paso la receta del queque de zanahoria",
        attachments: [
          imageAttachment(ws, "receta-queque.png"),
          {
            kind: "file",
            url: "https://example.test/lista.pdf",
            name: "lista-compras.pdf",
            size: 512,
            mime: "application/pdf",
            path: `chat-media/${ws}/${ATTACH_ID}-lista-compras.pdf`,
          },
        ],
      }),
    });
    if (msgError) throw msgError;

    // Mensaje del DM con imagen (solo sus dos miembros).
    const { error: dmMsgError } = await admin.from("messages").insert({
      workspace_id: ws,
      chat_id: dmId,
      author_id: owner.id,
      author_name: "Sofi",
      ...messagePayload({
        text: "foto del regalo secreto",
        attachments: [imageAttachment(ws, "regalo-secreto.png")],
      }),
    });
    if (dmMsgError) throw dmMsgError;

    // Lista + ítem.
    const { data: list, error: listError } = await admin
      .from("lists")
      .insert({
        workspace_id: ws,
        title: "Súper del sábado",
        emoji: "🛒",
        kind: "groceries",
        created_by: member.id,
      })
      .select("id")
      .single();
    if (listError) throw listError;
    const { error: itemError } = await admin.from("list_items").insert({
      list_id: list.id,
      workspace_id: ws,
      text: "zanahorias para el queque",
      created_by: member.id,
    });
    if (itemError) throw itemError;

    // Encuesta sobre un mensaje tarjeta.
    const { data: pollMsg, error: pollMsgError } = await admin
      .from("messages")
      .insert({
        workspace_id: ws,
        chat_id: "general",
        author_id: owner.id,
        author_name: "Sofi",
        ...messagePayload({ text: "¿qué día hacemos el asado?", type: "card" }),
      })
      .select("id")
      .single();
    if (pollMsgError) throw pollMsgError;
    const { error: pollError } = await admin.from("polls").insert({
      message_id: pollMsg.id,
      workspace_id: ws,
      chat_id: "general",
      question: "¿qué día hacemos el asado?",
      kind: "single",
      created_by: owner.id,
    });
    if (pollError) throw pollError;

    // Idea.
    const { error: ideaError } = await admin.from("ideas").insert({
      workspace_id: ws,
      title: "Huerto en el balcón",
      detail: "partir con zanahorias y lechugas",
      tag: "Casa",
      created_by: member.id,
    });
    if (ideaError) throw ideaError;

    // Recuerdos: uno visible y uno sensible (el sensible no sale en global).
    const { error: memError } = await admin.from("space_memories").insert([
      {
        workspace_id: ws,
        content: "El asado se hace con carbón de espino",
        category: "casa",
        created_by: member.id,
      },
      {
        workspace_id: ws,
        content: "La clave de la caja fuerte es 4711",
        category: "casa",
        sensitive: true,
        created_by: member.id,
      },
    ]);
    if (memError) throw memError;
  });

  after(async () => {
    await purgeTestData();
  });

  it("el trigger indexa los adjuntos al enviar el mensaje", async () => {
    const { data, error } = await member.client
      .from("message_attachments")
      .select("name, kind, mime, ocr_status, bucket, object_path")
      .eq("workspace_id", ws)
      .order("name", { ascending: true });
    assert.equal(error, null, "leer el índice no da error");
    const names = (data ?? []).map((row) => row.name);
    assert.ok(names.includes("receta-queque.png"), "la imagen quedó indexada");
    assert.ok(names.includes("lista-compras.pdf"), "el archivo quedó indexado");
    const image = (data ?? []).find((row) => row.name === "receta-queque.png");
    assert.equal(image.kind, "image", "el tipo se conserva");
    assert.equal(image.ocr_status, "pending", "la imagen nace pendiente de OCR");
    assert.equal(image.bucket, "chat-media", "el bucket se parte del path");
    assert.ok(
      String(image.object_path ?? "").startsWith(`${ws}/`),
      "la ruta ata al espacio",
    );
    const file = (data ?? []).find((row) => row.name === "lista-compras.pdf");
    assert.equal(file.ocr_status, "none", "lo que no es imagen no espera OCR");
  });

  it("un ajeno no ve el índice y el DM ajeno queda fuera", async () => {
    const { data: outside } = await outsider.client
      .from("message_attachments")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(outside, "un no miembro no ve adjuntos");

    const { data: dmRows } = await member.client
      .from("message_attachments")
      .select("id, name")
      .eq("workspace_id", ws);
    assert.ok(
      !(dmRows ?? []).some((row) => row.name === "regalo-secreto.png"),
      "quien no está en el DM no ve su imagen",
    );
    const { data: dmMember } = await owner.client
      .from("message_attachments")
      .select("id, name")
      .eq("workspace_id", ws);
    assert.ok(
      (dmMember ?? []).some((row) => row.name === "regalo-secreto.png"),
      "quien sí está en el DM la ve",
    );
  });

  it("el cliente no escribe el índice a mano", async () => {
    assertDenied(
      await member.client.from("message_attachments").insert({
        workspace_id: ws,
        chat_id: "general",
        message_id: "00000000-0000-4000-8000-000000000000",
        name: "trucho.png",
      }),
      "el índice solo lo escribe el trigger",
    );
    const update = await member.client
      .from("message_attachments")
      .update({ ocr_text: "inventado" })
      .eq("workspace_id", ws)
      .select("id");
    assertNoRowsAffected(update, "el cliente no marca OCR");
  });

  it("global_search trae los grupos nuevos", async () => {
    const { data, error } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "queque",
    });
    assert.equal(error, null, "global_search responde");
    for (const key of [
      "messages",
      "tasks",
      "projects",
      "events",
      "people",
      "transcriptions",
      "memories",
      "lists",
      "list_items",
      "polls",
      "ideas",
      "attachments",
    ]) {
      assert.ok(Array.isArray(data[key]), `el grupo ${key} viene como lista`);
    }
    assert.ok(
      (data.messages ?? []).some((row) => String(row.text ?? "").includes("queque")),
      "el mensaje sale",
    );
    assert.ok(
      (data.attachments ?? []).some((row) => row.name === "receta-queque.png"),
      "la imagen sale por nombre",
    );
    assert.ok(
      (data.list_items ?? []).some((row) => String(row.text ?? "").includes("zanahorias")),
      "el ítem sale con su texto",
    );
    assert.equal(
      (data.list_items ?? [])[0]?.list_title,
      "Súper del sábado",
      "el ítem trae su lista",
    );
  });

  it("listas, encuestas e ideas se encuentran por lo suyo", async () => {
    const { data: lists } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "sábado",
    });
    assert.ok(
      (lists.lists ?? []).some((row) => row.title === "Súper del sábado"),
      "la lista sale por título",
    );

    const { data: polls } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "asado",
    });
    assert.ok(
      (polls.polls ?? []).some((row) => String(row.question ?? "").includes("asado")),
      "la encuesta sale por pregunta",
    );
    assert.ok(
      (polls.memories ?? []).some((row) => String(row.content ?? "").includes("espino")),
      "el recuerdo visible sale",
    );

    const { data: ideas } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "huerto",
    });
    assert.ok(
      (ideas.ideas ?? []).some((row) => row.title === "Huerto en el balcón"),
      "la idea sale por título",
    );
  });

  it("lo sensible y el DM ajeno no salen en la búsqueda", async () => {
    const { data: secret } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "caja fuerte",
    });
    assertNoRows(secret.memories, "el recuerdo sensible no sale ni exacto");

    const { data: dmSearch } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "regalo secreto",
    });
    assertNoRows(dmSearch.attachments, "la imagen del DM ajeno no sale");
    const { data: dmOwner } = await owner.client.rpc("global_search", {
      p_ws: ws,
      p_q: "regalo secreto",
    });
    assert.equal(
      (dmOwner.attachments ?? []).length,
      1,
      "quien está en el DM sí la encuentra",
    );
  });

  it("filtros: solo míos y por autor", async () => {
    await admin.from("messages").insert({
      workspace_id: ws,
      chat_id: "general",
      author_id: member.id,
      author_name: "Member",
      ...messagePayload({ text: "tornillo azul marino" }),
    });
    await admin.from("messages").insert({
      workspace_id: ws,
      chat_id: "general",
      author_id: owner.id,
      author_name: "Sofi",
      ...messagePayload({ text: "tornillo rojo" }),
    });

    const { data: mine, error } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "tornillo",
      p_mine: true,
    });
    assert.equal(error, null, "p_mine responde");
    assert.equal((mine.messages ?? []).length, 1, "solo lo propio");
    assert.equal(mine.messages[0]?.author_name, "Member", "es mi mensaje");

    const { data: byAuthor } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "tornillo",
      p_author: "Sofi",
    });
    assert.equal((byAuthor.messages ?? []).length, 1, "de: filtra por autor");
    assert.equal(byAuthor.messages[0]?.author_name, "Sofi", "es el de Sofi");
  });

  it("search_more pagina por grupo y rechaza grupos inventados", async () => {
    const { data, error } = await member.client.rpc("search_more", {
      p_ws: ws,
      p_q: "tornillo",
      p_group: "messages",
      p_limit: 1,
      p_offset: 0,
    });
    assert.equal(error, null, "search_more responde");
    assert.equal((data ?? []).length, 1, "la primera página trae uno");
    const { data: second } = await member.client.rpc("search_more", {
      p_ws: ws,
      p_q: "tornillo",
      p_group: "messages",
      p_limit: 1,
      p_offset: 1,
    });
    assert.equal((second ?? []).length, 1, "la segunda trae el otro");
    assert.notEqual(
      data[0]?.id,
      second[0]?.id,
      "son mensajes distintos",
    );

    const bad = await member.client.rpc("search_more", {
      p_ws: ws,
      p_q: "tornillo",
      p_group: "inventado",
    });
    assert.ok(bad.error, "un grupo inventado da error");
  });

  it("con menos de 2 letras los 12 grupos vienen vacíos", async () => {
    const { data, error } = await member.client.rpc("global_search", {
      p_ws: ws,
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
      "memories",
      "lists",
      "list_items",
      "polls",
      "ideas",
      "attachments",
    ]) {
      assert.deepEqual(data[key], [], `${key} debe venir vacío`);
    }
  });

  it("el ajuste de OCR es solo de admins y por defecto no encola nada", async () => {
    // Sin fila, leer no falla: simplemente no hay ajuste (OCR apagado).
    const { data: empty } = await member.client
      .from("workspace_search_settings")
      .select("ocr_enabled")
      .eq("workspace_id", ws);
    assertNoRows(empty, "sin ajuste guardado no hay fila");

    // Un miembro raso no lo activa.
    assertDenied(
      await member.client.from("workspace_search_settings").insert({
        workspace_id: ws,
        ocr_enabled: true,
        updated_by: member.id,
      }),
      "un miembro no activa el OCR",
    );

    // Una imagen subida sin OCR activado no encola trabajo.
    const before = await admin
      .from("ai_jobs")
      .select("id")
      .eq("workspace_id", ws)
      .eq("type", "ocr_image");
    assert.equal(before.error, null, "leer trabajos no falla");
    const countBefore = (before.data ?? []).length;

    await member.client.from("messages").insert({
      workspace_id: ws,
      chat_id: "general",
      author_id: member.id,
      author_name: "Member",
      ...messagePayload({
        text: "foto sin OCR",
        attachments: [imageAttachment(ws, "sin-ocr.png")],
      }),
    });
    const after = await admin
      .from("ai_jobs")
      .select("id")
      .eq("workspace_id", ws)
      .eq("type", "ocr_image");
    assert.equal(
      (after.data ?? []).length,
      countBefore,
      "sin OCR activado no se encola nada",
    );

    // El admin lo activa y la próxima imagen sí encola UN trabajo.
    assertAllowed(
      await owner.client.from("workspace_search_settings").insert({
        workspace_id: ws,
        ocr_enabled: true,
        updated_by: owner.id,
      }),
      "un admin activa el OCR",
    );
    await member.client.from("messages").insert({
      workspace_id: ws,
      chat_id: "general",
      author_id: member.id,
      author_name: "Member",
      ...messagePayload({
        text: "foto con OCR",
        attachments: [imageAttachment(ws, "con-ocr.png")],
      }),
    });
    const { data: indexed } = await admin
      .from("message_attachments")
      .select("id")
      .eq("workspace_id", ws)
      .eq("name", "con-ocr.png")
      .limit(1)
      .single();
    const { data: jobs } = await admin
      .from("ai_jobs")
      .select("id, payload")
      .eq("workspace_id", ws)
      .eq("type", "ocr_image");
    assert.ok(
      (jobs ?? []).some((job) => job.payload?.attachment_id === indexed.id),
      "la imagen con OCR deja su trabajo encolado",
    );
  });
});
