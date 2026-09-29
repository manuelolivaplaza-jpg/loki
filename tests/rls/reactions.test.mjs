/**
 * RLS de reacciones, marcas de leídos, ensure_posts_chat y push_tokens.
 *
 * Las reacciones son filas propias (message_reactions) en lugar del mapa
 * `reactions: {emoji: uid[]}` embebido en el mensaje, asi que la regla "solo
 * puedo alternar MI uid" se comprueba en la propia fila. Lo mismo con los
 * leídos: una fila por usuario y chat.
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

describe("RLS: reacciones, leidos, posts y tokens", () => {
  let admin;
  let owner;
  let member;
  let stranger;
  let ws;
  let target;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("react-owner", "Owner");
    member = await createTestUser("react-member", "Member");
    stranger = await createTestUser("react-stranger", "Stranger");

    ws = await createWorkspaceWith(owner.client, workspaceName("Reacciones"));
    await addMember(admin, ws, member.id, "member", "Member");

    const { data, error } = await admin
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "general",
          author_id: member.id,
          author_name: "Member",
          text: "mensaje para reaccionar",
        }),
      )
      .select("id")
      .maybeSingle();
    if (error) throw error;
    target = data.id;
  });

  after(async () => {
    await purgeTestData();
  });

  // --- reacciones -----------------------------------------------------------

  it("reaccionar con mi propio uid esta permitido y la reaccion se ve", async () => {
    const { data, error } = await member.client
      .from("message_reactions")
      .insert({ message_id: target, user_id: member.id, emoji: "👍" })
      .select("message_id, user_id, emoji")
      .maybeSingle();
    assertAllowed({ error }, "reaccionar con mi uid");
    assert.equal(data.user_id, member.id);
    assert.equal(data.emoji, "👍");

    // El compañero con acceso ve la misma reacción.
    const { data: seen, error: seenError } = await owner.client
      .from("message_reactions")
      .select("user_id, emoji")
      .eq("message_id", target);
    assertAllowed({ error: seenError }, "leer reacciones de un chat con acceso");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].user_id, member.id);
  });

  it("reaccionar con el uid de otro esta denegado", async () => {
    const { error } = await member.client
      .from("message_reactions")
      .insert({ message_id: target, user_id: owner.id, emoji: "🔥" });
    assertDenied({ error }, "reaccionar con el uid de otro");
  });

  it("reaccionar en un chat ajeno esta denegado", async () => {
    const { data: otherWs, error: wsError } = await admin
      .from("workspaces")
      .insert({ name: workspaceName("Ajeno"), emoji: "🏠", created_by: owner.id })
      .select("id")
      .maybeSingle();
    assertAllowed({ error: wsError }, "crear espacio ajeno con service role");

    const { data: otherChat } = await admin
      .from("chats")
      .insert({
        workspace_id: otherWs.id,
        id: "general",
        type: "group",
        name: "General",
        member_ids: [],
        created_by: owner.id,
      })
      .select("workspace_id, id")
      .maybeSingle();
    const { data: otherMessage } = await admin
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: otherChat.workspace_id,
          chat_id: otherChat.id,
          author_id: owner.id,
          author_name: "Owner",
          text: "mensaje de otro espacio",
        }),
      )
      .select("id")
      .maybeSingle();

    const { error } = await member.client
      .from("message_reactions")
      .insert({ message_id: otherMessage.id, user_id: member.id, emoji: "👍" });
    assertDenied({ error }, "reaccionar en un chat de otro espacio");
  });

  it("quitar mi reaccion esta permitido; la de otro, no", async () => {
    await admin
      .from("message_reactions")
      .insert({ message_id: target, user_id: owner.id, emoji: "🎉" });

    const mine = await member.client
      .from("message_reactions")
      .delete()
      .eq("message_id", target)
      .eq("user_id", member.id)
      .eq("emoji", "👍")
      .select("user_id");
    assertAllowed({ error: mine.error }, "quitar mi reaccion");
    assert.equal(mine.data.length, 1);

    const foreign = await member.client
      .from("message_reactions")
      .delete()
      .eq("message_id", target)
      .eq("user_id", owner.id)
      .eq("emoji", "🎉")
      .select("user_id");
    assertNoRowsAffected(foreign, "quitar la reaccion de otro");
  });

  it("un no miembro no ve las reacciones de un chat ajeno", async () => {
    const { data, error } = await stranger.client
      .from("message_reactions")
      .select("user_id")
      .eq("message_id", target);
    assertAllowed({ error }, "listar reacciones siendo Strange");
    assertNoRows(data, "las reacciones ajenas no deben verse");
  });

  it("el like de una publicacion aparece en la vista post_likes", async () => {
    const { data: post, error: postError } = await member.client
      .from("messages")
      .insert(
        messagePayload({
          workspace_id: ws,
          chat_id: "posts",
          author_id: member.id,
          author_name: "Member",
          text: "post con like",
          type: "post",
        }),
      )
      .select("id")
      .maybeSingle();
    assertAllowed({ error: postError }, "crear el post");

    const liked = await member.client
      .from("message_reactions")
      .insert({ message_id: post.id, user_id: member.id, emoji: "❤️" });
    assertAllowed({ error: liked.error }, "dar like con mi uid");

    const { data: likes, error: likesError } = await member.client
      .from("post_likes")
      .select("post_id, user_id")
      .eq("post_id", post.id);
    assertAllowed({ error: likesError }, "leer post_likes");
    assert.equal(likes.length, 1);
    assert.equal(likes[0].user_id, member.id);

    // Con un emoji distinto no cuenta como like.
    await member.client
      .from("message_reactions")
      .insert({ message_id: post.id, user_id: member.id, emoji: "👍" });
    const { data: stillOne } = await member.client
      .from("post_likes")
      .select("post_id")
      .eq("post_id", post.id);
    assert.equal(stillOne.length, 1, "solo el corazon cuenta como like");
  });

  // --- chat_reads -----------------------------------------------------------

  it("cada uno escribe su marca de leido y la de otro esta denegada", async () => {
    const own = await member.client
      .from("chat_reads")
      .upsert({ workspace_id: ws, chat_id: "general", user_id: member.id })
      .select("user_id, last_read_at")
      .maybeSingle();
    assertAllowed({ error: own.error }, "escribir mi marca de leido");
    assert.ok(own.data.last_read_at);

    const foreign = await member.client
      .from("chat_reads")
      .insert({ workspace_id: ws, chat_id: "general", user_id: owner.id });
    assertDenied({ error: foreign.error }, "escribir la marca de leido de otro");
  });

  it("un miembro con acceso ve la marca de otro; un Strange no", async () => {
    const asMember = await owner.client
      .from("chat_reads")
      .select("user_id")
      .eq("workspace_id", ws)
      .eq("chat_id", "general");
    assert.equal(asMember.data.length, 1, "solo debe verse la marca de member");
    assert.equal(asMember.data[0].user_id, member.id);

    const asStranger = await stranger.client
      .from("chat_reads")
      .select("user_id")
      .eq("workspace_id", ws)
      .eq("chat_id", "general");
    assertAllowed({ error: asStranger.error }, "consultar leidos siendo Strange");
    assertNoRows(asStranger.data, "los leidos ajenos no deben verse");
  });

  it("actualizo y borro mi marca; la de otro no", async () => {
    await owner.client
      .from("chat_reads")
      .upsert({ workspace_id: ws, chat_id: "general", user_id: owner.id });

    const updateForeign = await member.client
      .from("chat_reads")
      .update({ last_read_at: new Date().toISOString() })
      .eq("workspace_id", ws)
      .eq("chat_id", "general")
      .eq("user_id", owner.id)
      .select("user_id");
    assertNoRowsAffected(updateForeign, "actualizar la marca de otro");

    const deleteForeign = await member.client
      .from("chat_reads")
      .delete()
      .eq("workspace_id", ws)
      .eq("chat_id", "general")
      .eq("user_id", owner.id)
      .select("user_id");
    assertNoRowsAffected(deleteForeign, "borrar la marca de otro");

    const deleteOwn = await member.client
      .from("chat_reads")
      .delete()
      .eq("workspace_id", ws)
      .eq("chat_id", "general")
      .eq("user_id", member.id)
      .select("user_id");
    assertAllowed({ error: deleteOwn.error }, "borrar mi propia marca");
    assert.equal(deleteOwn.data.length, 1);
  });

  // --- ensure_posts_chat ----------------------------------------------------

  it("ensure_posts_chat crea el chat que falta y es idempotente", async () => {
    // Espacio sin chat 'posts': se borra con service role para simular uno
    // creado antes de las publicaciones.
    const { data: legacy, error: legacyError } = await admin
      .from("workspaces")
      .insert({ name: workspaceName("Legacy"), emoji: "🏠", created_by: owner.id })
      .select("id")
      .maybeSingle();
    assertAllowed({ error: legacyError }, "crear espacio legacy");
    await addMember(admin, legacy.id, member.id, "member", "Member");

    const first = await member.client.rpc("ensure_posts_chat", {
      p_workspace_id: legacy.id,
    });
    assertAllowed({ error: first.error }, "ensure_posts_chat la primera vez");
    assert.equal(first.data, true, "la primera llamada crea el chat");

    const { data: chat } = await member.client
      .from("chats")
      .select("id, type, name, emoji")
      .eq("workspace_id", legacy.id)
      .eq("id", "posts")
      .maybeSingle();
    assert.equal(chat.type, "posts");
    assert.equal(chat.name, "Publicaciones");
    assert.equal(chat.emoji, "📰");

    const second = await member.client.rpc("ensure_posts_chat", {
      p_workspace_id: legacy.id,
    });
    assertAllowed({ error: second.error }, "ensure_posts_chat la segunda vez");
    assert.equal(second.data, false, "la segunda llamada no crea nada nuevo");

    const { data: chats } = await member.client
      .from("chats")
      .select("id")
      .eq("workspace_id", legacy.id)
      .eq("id", "posts");
    assert.equal(chats.length, 1, "sigue habiendo un unico chat posts");
  });

  it("ensure_posts_chat en un espacio ajeno esta denegado", async () => {
    const { error } = await stranger.client.rpc("ensure_posts_chat", { p_workspace_id: ws });
    assertDenied({ error }, "ensure_posts_chat de un no miembro");
  });

  // --- push_tokens ----------------------------------------------------------

  it("cada uno gestiona solo sus tokens FCM", async () => {
    const mine = await member.client
      .from("push_tokens")
      .upsert({ user_id: member.id, token: "token-de-member", platform: "web" })
      .select("token")
      .maybeSingle();
    assertAllowed({ error: mine.error }, "registrar mi token");
    assert.equal(mine.data.token, "token-de-member");

    const foreign = await member.client
      .from("push_tokens")
      .insert({ user_id: owner.id, token: "token-de-owner", platform: "web" });
    assertDenied({ error: foreign.error }, "registrar el token de otro");

    const list = await stranger.client.from("push_tokens").select("token");
    assertAllowed({ error: list.error }, "listar tokens siendo Strange");
    assertNoRows(list.data, "los tokens ajenos no deben verse");

    const deleteForeign = await member.client
      .from("push_tokens")
      .delete()
      .eq("user_id", owner.id)
      .select("token");
    assertNoRowsAffected(deleteForeign, "borrar el token de otro");
  });
});
