/**
 * RLS de chats y mensajes, y los triggers de hilo y de preview del chat.
 * Equivalente a tests/chat.rules.test.mjs (T12), con las diferencias propias
 * de Postgres:
 *   · el id de mensaje lo pone la base (uuid), no el cliente;
 *   · las reacciones, los hilos y los leidos son filas propias, no campos
 *     embebidos en el mensaje;
 *   · no hay borrado fisico de mensajes (el borrado es soft con `deleted`).
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

describe("RLS: chats y mensajes", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  let ws;
  /** ids de los mensajes sembrados con service role, en orden de creacion. */
  let seed;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("chat-owner", "Owner");
    member = await createTestUser("chat-member", "Member");
    stranger = await createTestUser("chat-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Chat"));
    await addMember(admin, ws, member.id, "member", "Member");

    // Un dm solo con owner y member, sembrado con service role porque el
    // cliente puede crearlo pero aqui interesa fijarlo para todos los tests.
    const { error: dmError } = await admin.from("chats").insert({
      workspace_id: ws,
      id: "dm-1",
      type: "dm",
      name: "Owner y Member",
      member_ids: [owner.id, member.id],
      created_by: owner.id,
    });
    if (dmError) throw dmError;

    const { data: ids, error: seedError } = await admin
      .from("messages")
      .insert([
        messagePayload({ workspace_id: ws, chat_id: "general", author_id: member.id, author_name: "Member", text: "hola" }),
        messagePayload({ workspace_id: ws, chat_id: "general", author_id: member.id, author_name: "Member", text: "padre" }),
        messagePayload({ workspace_id: ws, chat_id: "general", author_id: member.id, author_name: "Member", text: "reacciona" }),
      ])
      .select("id");
    if (seedError) throw seedError;
    seed = { first: ids[0].id, parent: ids[1].id, react: ids[2].id };
  });

  after(async () => {
    await purgeTestData();
  });

  // --- lectura --------------------------------------------------------------

  it("un miembro lee el chat general y sus mensajes", async () => {
    const { data: chat } = await member.client
      .from("chats")
      .select("id, type, name")
      .eq("workspace_id", ws)
      .eq("id", "general")
      .maybeSingle();
    assert.equal(chat.type, "group");

    const { data: message } = await member.client
      .from("messages")
      .select("id, text, author_id, type")
      .eq("workspace_id", ws)
      .eq("chat_id", "general")
      .eq("id", seed.first)
      .maybeSingle();
    assert.equal(message.text, "hola");
    assert.equal(message.author_id, member.id);

    const { data: timeline } = await member.client
      .from("messages")
      .select("id, created_at")
      .eq("workspace_id", ws)
      .eq("chat_id", "general")
      .is("thread_parent_id", null)
      .order("created_at", { ascending: false })
      .limit(30);
    assert.ok(timeline.length >= 1);
  });

  it("un no miembro no ve ni el chat ni los mensajes", async () => {
    const chats = await stranger.client.from("chats").select("id").eq("workspace_id", ws);
    assertAllowed(chats, "listar chats siendo Strange");
    assertNoRows(chats.data, "los chats ajenos no deben verse");

    const messages = await stranger.client
      .from("messages")
      .select("id")
      .eq("workspace_id", ws)
      .eq("chat_id", "general");
    assertAllowed(messages, "listar mensajes siendo Strange");
    assertNoRows(messages.data, "los mensajes ajenos no deben verse");
  });

  it("un dm solo es visible para sus member_ids", async () => {
    const asMember = await member.client
      .from("chats")
      .select("id, type")
      .eq("workspace_id", ws)
      .eq("id", "dm-1")
      .maybeSingle();
    assert.equal(asMember.data.type, "dm");

    const asStranger = await stranger.client
      .from("chats")
      .select("id")
      .eq("workspace_id", ws)
      .eq("id", "dm-1");
    assertAllowed(asStranger, "consultar el dm ajeno");
    assertNoRows(asStranger.data, "el dm ajeno no debe verse");
  });

  // --- escritura ------------------------------------------------------------

  it("un miembro envia mensajes y el preview del chat se actualiza solo", async () => {
    const { data, error } = await member.client
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "general",
          author_id: member.id,
          author_name: "Member",
          text: "mensaje nuevo",
        }),
      )
      .select("id, author_id, text")
      .maybeSingle();
    assertAllowed({ error }, "enviar un mensaje propio");
    assert.equal(data.author_id, member.id);

    const { data: chat } = await member.client
      .from("chats")
      .select("last_message, updated_at")
      .eq("workspace_id", ws)
      .eq("id", "general")
      .maybeSingle();
    assert.equal(chat.last_message.text, "mensaje nuevo");
    assert.equal(chat.last_message.authorId, member.id);
    assert.equal(chat.last_message.authorName, "Member");
    assert.equal(chat.last_message.type, "user");
  });

  it("suplantar a otro autor esta denegado", async () => {
    const { error } = await member.client
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "general",
          author_id: owner.id,
          author_name: "Owner",
          text: "suplantado",
        }),
      );
    assertDenied({ error }, "mensaje con author_id ajeno");
  });

  it("type 'ai' esta denegado al cliente pero la service role si puede", async () => {
    const denied = await member.client
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "general",
          author_id: member.id,
          author_name: "Member",
          text: "soy ia",
          type: "ai",
        }),
      );
    assertDenied(denied, "mensaje type 'ai' desde el cliente");

    // Control: es la service role (Edge Function de T23) la que escribe 'ai'.
    const { data, error } = await admin
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "general",
          author_id: member.id,
          author_name: "Loki IA",
          text: "respuesta real",
          type: "ai",
        }),
      )
      .select("id, type")
      .maybeSingle();
    assertAllowed({ error }, "mensaje type 'ai' con service role");
    assert.equal(data.type, "ai");
  });

  it("un no miembro no puede escribir en un chat ajeno", async () => {
    const { error } = await stranger.client
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "general",
          author_id: stranger.id,
          author_name: "Stranger",
          text: "colado",
        }),
      );
    assertDenied({ error }, "mensaje de un no miembro");
  });

  it("no se pueden crear chats su tipo ni fuera del espacio", async () => {
    const wrongType = await member.client.from("chats").insert({
      workspace_id: ws,
      id: "chat-ai",
      type: "ai",
      name: "IA",
      member_ids: [],
      created_by: member.id,
    });
    assertDenied(wrongType, "chat type 'ai' en un espacio");

    const foreign = await stranger.client.from("chats").insert({
      workspace_id: ws,
      id: "colado",
      type: "group",
      name: "Colado",
      member_ids: [],
      created_by: stranger.id,
    });
    assertDenied(foreign, "crear chat en un espacio ajeno");
  });

  it("no se puede escribir el preview del chat desde el cliente", async () => {
    const { error } = await member.client
      .from("chats")
      .update({
        last_message: {
          text: "preview falso",
          authorId: member.id,
          authorName: "Member",
          type: "user",
          createdAt: new Date().toISOString(),
        },
      })
      .eq("workspace_id", ws)
      .eq("id", "general")
      .select("id");
    assertDenied({ error }, "escribir last_message a mano");
  });

  // --- edicion y borrado ----------------------------------------------------

  it("el autor edita su texto; otro miembro no", async () => {
    const byAuthor = await member.client
      .from("messages")
      .update({ text: "editado por su autor", edited_at: new Date().toISOString() })
      .eq("id", seed.first)
      .select("text")
      .maybeSingle();
    assertAllowed(byAuthor, "el autor edita su mensaje");
    assert.equal(byAuthor.data.text, "editado por su autor");

    const byOther = await owner.client
      .from("messages")
      .update({ text: "editado por otro" })
      .eq("id", seed.first)
      .select("text");
    assertNoRowsAffected(byOther, "otro miembro edita mi mensaje");
  });

  it("editar columnas prohibidas esta denegado (author_id, created_at, thread_count)", async () => {
    const authorSwap = await member.client
      .from("messages")
      .update({ author_id: owner.id })
      .eq("id", seed.first)
      .select("author_id");
    assertDenied(authorSwap, "cambiar author_id");

    const createdAt = await member.client
      .from("messages")
      .update({ created_at: "2000-01-01T00:00:00Z" })
      .eq("id", seed.first)
      .select("created_at");
    assertDenied(createdAt, "cambiar created_at");

    // El cliente no puede escribirse su propio +1 de hilo: eso lo hace el
    // trigger messages_bump_thread.
    const threadCount = await member.client
      .from("messages")
      .update({ thread_count: 7, last_reply_at: new Date().toISOString() })
      .eq("id", seed.parent)
      .select("thread_count");
    assertDenied(threadCount, "cambiar thread_count a mano");
  });

  it("el autor hace el borrado en suave y no hay borrado fisico", async () => {
    const soft = await member.client
      .from("messages")
      .update({ deleted: true, text: "" })
      .eq("id", seed.first)
      .select("deleted, text")
      .maybeSingle();
    assertAllowed(soft, "el autor borra en suave su mensaje");
    assert.equal(soft.data.deleted, true);

    const hard = await member.client
      .from("messages")
      .delete()
      .eq("id", seed.first)
      .select("id");
    assertNoRowsAffected(hard, "borrado fisico de un mensaje");
  });

  // --- hilos y preview ------------------------------------------------------

  it("una respuesta incrementa thread_count del padre y no toca last_message", async () => {
    const before = await member.client
      .from("messages")
      .select("last_message")
      .eq("workspace_id", ws)
      .eq("id", "general")
      .maybeSingle();

    const reply = await member.client
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "general",
          author_id: member.id,
          author_name: "Member",
          text: "primera respuesta",
          thread_parent_id: seed.parent,
        }),
      )
      .select("id, thread_parent_id")
      .maybeSingle();
    assertAllowed({ error: reply.error }, "responder en un hilo");

    const { data: parent } = await member.client
      .from("messages")
      .select("thread_count, last_reply_at")
      .eq("id", seed.parent)
      .maybeSingle();
    assert.equal(parent.thread_count, 1);
    assert.ok(parent.last_reply_at, "last_reply_at debe quedar informado");

    const after = await member.client
      .from("chats")
      .select("last_message")
      .eq("workspace_id", ws)
      .eq("id", "general")
      .maybeSingle();
    assert.deepEqual(
      after.last_message,
      before.last_message,
      "una respuesta de hilo no debe cambiar el preview del chat",
    );

    // La segunda respuesta, de otro autor, suma otro +1 (el trigger, no el
    // cliente). Va con el cliente del owner porque author_id debe ser el suyo.
    const { error: secondError } = await owner.client.from("messages").insert(
      messagePayload({
        workspace_id: ws,
        chat_id: "general",
        author_id: owner.id,
        author_name: "Owner",
        text: "segunda respuesta",
        thread_parent_id: seed.parent,
      }),
    );
    assertAllowed({ error: secondError }, "segunda respuesta en el hilo");
    const { data: parent2 } = await member.client
      .from("messages")
      .select("thread_count")
      .eq("id", seed.parent)
      .maybeSingle();
    assert.equal(parent2.thread_count, 2);
  });

  it("el padre del hilo tiene que estar en el mismo chat", async () => {
    const { error } = await member.client.from("messages").insert(
      messagePayload({
        workspace_id: ws,
        chat_id: "dm-1",
        author_id: member.id,
        author_name: "Member",
        text: "hilo cruzado",
        thread_parent_id: seed.parent,
      }),
    );
    assertDenied({ error }, "hilo con padre de otro chat");
  });

  it("un mensaje 'system' no toca el preview del chat", async () => {
    const { data: before } = await member.client
      .from("chats")
      .select("last_message")
      .eq("workspace_id", ws)
      .eq("id", "general")
      .maybeSingle();

    const { error } = await member.client.from("messages").insert(
      messagePayload({
        workspace_id: ws,
        chat_id: "general",
        author_id: member.id,
        author_name: "Member",
        text: "Loki esta desactivada",
        type: "system",
      }),
    );
    assertAllowed({ error }, "mensaje de sistema");

    const { data: after } = await member.client
      .from("chats")
      .select("last_message")
      .eq("workspace_id", ws)
      .eq("id", "general")
      .maybeSingle();
    assert.deepEqual(
      after.last_message,
      before.last_message,
      "un mensaje system no debe cambiar el preview del chat",
    );
  });

  it("publicar un post si actualiza el preview y alimenta la vista posts", async () => {
    const { data: post, error } = await member.client
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "posts",
          author_id: member.id,
          author_name: "Member",
          text: "primer post",
          type: "post",
        }),
      )
      .select("id, type")
      .maybeSingle();
    assertAllowed({ error }, "publicar un post");
    assert.equal(post.type, "post");

    const { data: chat } = await member.client
      .from("chats")
      .select("last_message")
      .eq("workspace_id", ws)
      .eq("id", "posts")
      .maybeSingle();
    assert.equal(chat.last_message.text, "primer post");
    assert.equal(chat.last_message.type, "post");

    // La vista posts (security_invoker) solo expone type 'post' sin padre.
    const { data: feed } = await member.client
      .from("posts")
      .select("id, text")
      .eq("workspace_id", ws);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].id, post.id);

    // Y el feed tampoco se ve desde fuera del espacio.
    const { data: foreignFeed } = await stranger.client
      .from("posts")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(foreignFeed, "el feed de posts ajeno no debe verse");
  });

  it("un comentario de un post es un hilo y no aparece en el feed", async () => {
    const { data: feedBefore } = await member.client
      .from("posts")
      .select("id")
      .eq("workspace_id", ws);
    const postId = feedBefore[0].id;

    const { data: comment, error } = await owner.client
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "posts",
          author_id: owner.id,
          author_name: "Owner",
          text: "comentario",
          thread_parent_id: postId,
        }),
      )
      .select("id")
      .maybeSingle();
    assertAllowed({ error }, "comentar un post");

    const { data: feedAfter } = await member.client.from("posts").select("id").eq("workspace_id", ws);
    assert.equal(feedAfter.length, 1, "el comentario no debe entrar en el feed");
    assert.equal(feedAfter[0].id, postId);

    const { data: post } = await member.client
      .from("posts")
      .select("thread_count, last_reply_at")
      .eq("id", postId)
      .maybeSingle();
    assert.equal(post.thread_count, 1);
    assert.ok(post.last_reply_at);
    assert.notEqual(comment.id, postId);
  });
});
