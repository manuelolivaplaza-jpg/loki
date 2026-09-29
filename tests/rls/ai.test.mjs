/**
 * RLS del chat privado de Loki IA (ai_chats / ai_messages) y comprobacion de
 * que la tabla de mensajes de espacio y la de IA tienen la misma regla para
 * el type 'ai': lo escribe la service role (Edge Function de T23), nunca el
 * cliente.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import {
  adminClient,
  assertAllowed,
  assertDenied,
  assertNoRows,
  assertNoRowsAffected,
  createTestUser,
  purgeTestData,
} from "./_helpers.mjs";

describe("RLS: chat privado de Loki IA", () => {
  let admin;
  let owner;
  let stranger;
  let aiChatId;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("ai-owner", "Owner");
    stranger = await createTestUser("ai-stranger", "Stranger");

    const { data, error } = await owner.client
      .from("ai_chats")
      .insert({ title: "Loki IA" })
      .select("id, user_id, title")
      .maybeSingle();
    assertAllowed({ error }, "crear mi chat de IA");
    assert.equal(data.user_id, owner.id);
    assert.equal(data.title, "Loki IA");
    aiChatId = data.id;
  });

  after(async () => {
    await purgeTestData();
  });

  it("veo mi chat de IA y puedo renombrarlo", async () => {
    const { data, error } = await owner.client
      .from("ai_chats")
      .select("id, title")
      .eq("id", aiChatId)
      .maybeSingle();
    assertAllowed({ error }, "leer mi chat de IA");
    assert.equal(data.title, "Loki IA");

    const renamed = await owner.client
      .from("ai_chats")
      .update({ title: "Loki IA · familia" })
      .eq("id", aiChatId)
      .select("title")
      .maybeSingle();
    assertAllowed({ error: renamed.error }, "renombrar mi chat de IA");
    assert.equal(renamed.data.title, "Loki IA · familia");
  });

  it("el chat de IA de otro usuario no es visible ni editable", async () => {
    const read = await stranger.client
      .from("ai_chats")
      .select("id")
      .eq("id", aiChatId);
    assertAllowed({ error: read.error }, "consultar el chat de IA ajeno");
    assertNoRows(read.data, "el chat de IA ajeno no debe verse");

    const rename = await stranger.client
      .from("ai_chats")
      .update({ title: "secuestrado" })
      .eq("id", aiChatId)
      .select("title");
    assertNoRowsAffected(rename, "renombrar el chat de IA de otro");

    const remove = await stranger.client
      .from("ai_chats")
      .delete()
      .eq("id", aiChatId)
      .select("id");
    assertNoRowsAffected(remove, "borrar el chat de IA de otro");
  });

  it("puedo enviar preguntas (type 'user') en mi chat de IA", async () => {
    const { data, error } = await owner.client
      .from("ai_messages")
      .insert({ chat_id: aiChatId, type: "user", content: "¿qué tal?" })
      .select("id, type, content")
      .maybeSingle();
    assertAllowed({ error }, "enviar una pregunta a Loki");
    assert.equal(data.type, "user");
    assert.equal(data.content, "¿qué tal?");
  });

  it("escribir type 'ai' esta denegado al cliente; la service role si puede", async () => {
    const denied = await owner.client
      .from("ai_messages")
      .insert({ chat_id: aiChatId, type: "ai", content: "respuesta falsa" });
    assertDenied({ error: denied.error }, "insertar type 'ai' desde el cliente");

    // Control: la Edge Function de T23 escribe con service role.
    const { data, error } = await admin
      .from("ai_messages")
      .insert({ chat_id: aiChatId, type: "ai", content: "respuesta real" })
      .select("id, type")
      .maybeSingle();
    assertAllowed({ error }, "insertar type 'ai' con service role");
    assert.equal(data.type, "ai");
  });

  it("leer los mensajes de IA de otro esta denegado y no puedo escribir ahi", async () => {
    const read = await stranger.client
      .from("ai_messages")
      .select("id")
      .eq("chat_id", aiChatId);
    assertAllowed({ error: read.error }, "consultar los mensajes de IA ajenos");
    assertNoRows(read.data, "los mensajes de IA ajenos no deben verse");

    // Crear un chat propio y meter dentro el id del ajeno: la RLS lo rechaza.
    const { data: mine, error: chatError } = await stranger.client
      .from("ai_chats")
      .insert({ title: "Loki IA" })
      .select("id")
      .maybeSingle();
    assertAllowed({ error: chatError }, "crear mi propio chat de IA");

    const crossWrite = await stranger.client
      .from("ai_messages")
      .insert({ chat_id: aiChatId, type: "user", content: "hola?" });
    assertDenied({ error: crossWrite.error }, "escribir en el chat de IA de otro");
    assert.ok(mine.id);
  });

  it("los mensajes de IA no se pueden editar ni borrar desde el cliente", async () => {
    const edit = await owner.client
      .from("ai_messages")
      .update({ content: "editado" })
      .eq("chat_id", aiChatId)
      .eq("type", "user")
      .select("content");
    assertNoRowsAffected(edit, "editar un mensaje de IA");

    const remove = await owner.client
      .from("ai_messages")
      .delete()
      .eq("chat_id", aiChatId)
      .eq("type", "user")
      .select("id");
    assertNoRowsAffected(remove, "borrar un mensaje de IA");
  });
});
