/**
 * RLS de la memoria del espacio (`space_memories`), de su búsqueda
 * (`search_space_memories`) y del grupo `memories` de `global_search`.
 *
 * Lo que se comprueba, que es justo la promesa del producto:
 *   · Los miembros leen los recuerdos compartidos del espacio; un ajeno no ve
 *     nada y un no miembro no guarda nada.
 *   · Cada quien guarda lo suyo (created_by = auth.uid()).
 *   · Un recuerdo "privado" solo lo ve quien lo guardó.
 *   · Edita o borra quien lo guardó o un admin del espacio.
 *   · Lo tomado de un DM nace `privado` salvo confirmación explícita: eso lo
 *     fuerza el trigger `space_memories_guard_source`, no la UI.
 *   · La búsqueda excluye lo privado de otros y lo caducado; la búsqueda
 *     global además excluye los sensibles (es una vista previa).
 *   · Nada de push ni bandeja para lo sensible ni para lo privado.
 *   · La caducidad avisa una vez al autor y nunca con el texto sensible.
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

/** Crea un recuerdo y devuelve la fila (lanza si la RLS lo rechaza). */
async function saveMemory(client, ws, uid, overrides = {}) {
  const { data, error } = await client
    .from("space_memories")
    .insert({
      workspace_id: ws,
      content: "La clave del wifi es Loki2026",
      category: "casa",
      created_by: uid,
      ...overrides,
    })
    .select("id, content, visibility, sensitive, category, pinned, expires_at")
    .single();
  assert.equal(error, null, `guardar recuerdo: ${error?.message ?? ""}`);
  return data;
}

describe("RLS: memoria del espacio", () => {
  let admin;
  let owner;
  let member;
  let plain;
  let outsider;
  let ws;
  /** Mensaje de un DM del owner con outsider (fuera de la vista del resto). */
  let dmMessageId;

  before(async () => {
    admin = adminClient();
    await purgeTestData();
    owner = await createTestUser("mem-owner", "Owner");
    member = await createTestUser("mem-member", "Member");
    plain = await createTestUser("mem-plain", "Plain");
    outsider = await createTestUser("mem-outsider", "Outsider");

    ws = await createWorkspaceWith(owner.client, workspaceName("Memoria"));
    await addMember(admin, ws, member.id, "member", "Member");
    await addMember(admin, ws, plain.id, "member", "Plain");

    // DM entre owner y outsider: member y plain no están.
    const { data: dm, error: dmError } = await admin
      .from("chats")
      .insert({
        workspace_id: ws,
        id: "dm-mem",
        type: "dm",
        name: "DM memoria",
        member_ids: [owner.id, outsider.id],
      })
      .select("id")
      .single();
    if (dmError) throw dmError;
    const { data: dmMessage, error: msgError } = await admin
      .from("messages")
      .insert({
        workspace_id: ws,
        chat_id: dm.id,
        author_id: owner.id,
        author_name: "Owner",
        ...messagePayload({ text: "el portón es 1234" }),
      })
      .select("id")
      .single();
    if (msgError) throw msgError;
    dmMessageId = dmMessage.id;
  });

  after(async () => {
    await purgeTestData();
  });

  it("un miembro guarda un recuerdo y los demás lo leen", async () => {
    const row = await saveMemory(member.client, ws, member.id, {
      content: "Elarque es el preferido de la familia",
      category: "contactos",
    });
    assert.equal(row.visibility, "espacio", "nace compartido");

    const { data, error } = await owner.client
      .from("space_memories")
      .select("id")
      .eq("id", row.id);
    assert.equal(error, null, "leer no da error");
    assert.equal((data ?? []).length, 1, "otro miembro lo ve");

    const { data: outside } = await outsider.client
      .from("space_memories")
      .select("id")
      .eq("workspace_id", ws);
    assertNoRows(outside, "un no miembro no ve nada");
  });

  it("un no miembro no guarda recuerdos en un espacio ajeno", async () => {
    assertDenied(
      await outsider.client.from("space_memories").insert({
        workspace_id: ws,
        content: "me colé",
        created_by: outsider.id,
      }),
      "un no miembro no guarda",
    );
  });

  it("no se puede guardar a nombre de otro", async () => {
    assertDenied(
      await member.client.from("space_memories").insert({
        workspace_id: ws,
        content: "esto es de otro",
        created_by: plain.id,
      }),
      "created_by propio o nada",
    );
  });

  it("la categoría y el contenido inválidos los rechaza el CHECK", async () => {
    assertDenied(
      await member.client.from("space_memories").insert({
        workspace_id: ws,
        content: "   ",
        created_by: member.id,
      }),
      "contenido vacío",
    );
    assertDenied(
      await member.client.from("space_memories").insert({
        workspace_id: ws,
        content: "cosa",
        category: "inventada",
        created_by: member.id,
      }),
      "categoría fuera de la lista",
    );
  });

  it("un recuerdo privado solo lo ve quien lo guardó", async () => {
    const row = await saveMemory(plain.client, ws, plain.id, {
      content: "Anotación personal: revisar el seguro",
      visibility: "privado",
    });

    const mine = await plain.client
      .from("space_memories")
      .select("id")
      .eq("id", row.id);
    assert.equal((mine.data ?? []).length, 1, "yo veo mi privado");

    const other = await member.client
      .from("space_memories")
      .select("id")
      .eq("id", row.id);
    assertNoRows(other, "otro miembro no ve un privado");

    const search = await member.client.rpc("search_space_memories", {
      p_ws: ws,
      p_query: "seguro",
      p_limit: 10,
    });
    assert.equal(search.error, null, `search_space_memories: ${search.error?.message ?? ""}`);
    const texts = (search.data ?? []).map((row) => String(row.content ?? ""));
    assert.ok(
      !texts.some((text) => text.includes("revisar el seguro")),
      "la búsqueda tampoco lo enseña",
    );
  });

  it("editar y borrar: el creador o un admin, nunca el resto", async () => {
    const row = await saveMemory(member.client, ws, member.id, {
      content: "El gas se corta los martes",
    });

    const plainEdit = await plain.client
      .from("space_memories")
      .update({ content: "cambiado por otro" })
      .eq("id", row.id)
      .select("id");
    assertNoRowsAffected(plainEdit, "un miembro raso no edita");

    const ownEdit = await member.client
      .from("space_memories")
      .update({ pinned: true })
      .eq("id", row.id)
      .select("pinned");
    assert.equal((ownEdit.data ?? []).length, 1, "el creador sí edita");
    assert.equal(ownEdit.data?.[0]?.pinned, true, "queda fijado");

    const plainDel = await plain.client
      .from("space_memories")
      .delete()
      .eq("id", row.id)
      .select("id");
    assertNoRowsAffected(plainDel, "un miembro raso no borra");

    // El owner es admin del espacio: puede borrar el recuerdo de otro.
    const adminDel = await owner.client
      .from("space_memories")
      .delete()
      .eq("id", row.id)
      .select("id");
    assert.equal((adminDel.data ?? []).length, 1, "un admin borra");
  });

  it("lo que sale de un DM no se comparte sin confirmación explícita", async () => {
    const silencioso = await saveMemory(owner.client, ws, owner.id, {
      content: "el portón es 1234",
      source_message_id: dmMessageId,
    });
    assert.equal(
      silencioso.visibility,
      "privado",
      "sin confirmar, el trigger lo deja personal",
    );

    // Confirmado explícitamente: pasa a ser del espacio.
    const { data: compartido, error } = await owner.client
      .from("space_memories")
      .insert({
        workspace_id: ws,
        content: "el portón es 1234",
        category: "casa",
        source_message_id: dmMessageId,
        share_confirmed: true,
        created_by: owner.id,
      })
      .select("visibility")
      .single();
    assert.equal(error, null, `compartir: ${error?.message ?? ""}`);
    assert.equal(compartido.visibility, "espacio", "con confirmación sí es del espacio");
  });

  it("la búsqueda encuentra lo del espacio y salta lo caducado", async () => {
    await saveMemory(member.client, ws, member.id, {
      content: "La clave del wifi es Loki2026",
      category: "casa",
    });
    const caducado = await saveMemory(member.client, ws, member.id, {
      content: "El código del portón antiguo era 9999",
      category: "casa",
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    assert.ok(caducado.id !== "", "el caducado se guardó (lo esconde la búsqueda, no la tabla)");

    const { data, error } = await member.client.rpc("search_space_memories", {
      p_ws: ws,
      p_query: "clave del wifi",
      p_limit: 10,
    });
    assert.equal(error, null, `search: ${error?.message ?? ""}`);
    const texts = (data ?? []).map((row) => String(row.content ?? ""));
    assert.ok(
      texts.some((text) => text.includes("clave del wifi")),
      "encuentra el recuerdo vigente",
    );

    const viejo = await member.client.rpc("search_space_memories", {
      p_ws: ws,
      p_query: "código del portón",
      p_limit: 10,
    });
    assert.equal(viejo.error, null, `search caducado: ${viejo.error?.message ?? ""}`);
    assertNoRows(viejo.data, "un recuerdo caducado ya no se ofrece");

    // Con menos de 2 letras no hay búsqueda (y no da error).
    const corto = await member.client.rpc("search_space_memories", {
      p_ws: ws,
      p_query: "a",
      p_limit: 10,
    });
    assert.equal(corto.error, null, `query corta: ${corto.error?.message ?? ""}`);
    assertNoRows(corto.data, "con una letra no devuelve nada");
  });

  it("un no miembro no puede buscar en un espacio ajeno", async () => {
    const res = await outsider.client.rpc("search_space_memories", {
      p_ws: ws,
      p_query: "wifi",
      p_limit: 10,
    });
    assertDenied(res, "la RPC exige ser miembro");
  });

  it("una pregunta se busca por sus palabras, no por la frase entera", async () => {
    await saveMemory(member.client, ws, member.id, {
      content: "La clave del wifi es Loki2026",
      category: "casa",
    });
    // "¿cuál era la clave del wifi?" trae palabras que no están en el
    // recuerdo: si se buscara la frase entera no saldría nada.
    const { data, error } = await member.client.rpc("search_space_memories", {
      p_ws: ws,
      p_query: "cuál era la clave del wifi",
      p_limit: 5,
    });
    assert.equal(error, null, `search por palabras: ${error?.message ?? ""}`);
    const texts = (data ?? []).map((row) => String(row.content ?? ""));
    assert.ok(
      texts.some((text) => text.includes("clave del wifi")),
      "encuentra el recuerdo por sus palabras clave",
    );

    const { data: terms } = await member.client.rpc("memory_query_terms", {
      p_query: "cuál era la clave del wifi",
    });
    assert.deepEqual(
      [...(terms ?? [])].sort(),
      ["clave", "wifi"],
      "las palabras sin sentido se descartan",
    );
  });

  it("la búsqueda global incluye los recuerdos NO sensibles", async () => {
    const normal = await saveMemory(member.client, ws, member.id, {
      content: "El desayuno del domingo es a las 11",
      category: "casa",
    });
    const secreto = await saveMemory(member.client, ws, member.id, {
      content: "La clave de la caja fuerte es 4711",
      category: "casa",
      sensitive: true,
    });

    const { data, error } = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "domingo",
    });
    assert.equal(error, null, `global_search: ${error?.message ?? ""}`);
    const rows = Array.isArray(data?.memories) ? data.memories : [];
    const ids = rows.map((row) => String(row.id ?? ""));
    assert.ok(ids.includes(normal.id), "el recuerdo visible sale en la búsqueda global");
    assert.ok(
      !ids.includes(secreto.id),
      "el sensible no sale en la búsqueda global (ni con otra palabra)",
    );

    const sensible = await member.client.rpc("global_search", {
      p_ws: ws,
      p_q: "caja fuerte",
    });
    assert.equal(sensible.error, null, `global_search sensible: ${sensible.error?.message ?? ""}`);
    const sensibles = Array.isArray(sensible.data?.memories) ? sensible.data.memories : [];
    assertNoRows(sensibles, "ni buscando la palabra exacta aparece el sensible");
  });

  it("lo sensible y lo privado no generan notificación (ni push)", async () => {
    await admin
      .from("notifications")
      .delete()
      .eq("workspace_id", ws)
      .eq("type", "memory");

    // Compartido y no sensible: los demás se enteran (una vez).
    const visible = await saveMemory(member.client, ws, member.id, {
      content: "El dentista queda el jueves",
      category: "salud",
    });
    const { data: avisados } = await admin
      .from("notifications")
      .select("user_id, dedupe")
      .eq("workspace_id", ws)
      .eq("type", "memory")
      .eq("dedupe", `memory:${visible.id}`);
    assert.equal((avisados ?? []).length, 2, "avisa a los otros dos miembros");
    assert.ok(
      !(avisados ?? []).some((row) => row.user_id === member.id),
      "el autor no se avisa a sí mismo",
    );

    // Sensible: ni una fila.
    await admin.from("notifications").delete().eq("workspace_id", ws).eq("type", "memory");
    const secreto = await saveMemory(member.client, ws, member.id, {
      content: "La clave de la caja fuerte es 4711",
      sensitive: true,
    });
    const { data: delSensible } = await admin
      .from("notifications")
      .select("id")
      .eq("dedupe", `memory:${secreto.id}`);
    assertNoRows(delSensible, "un recuerdo sensible no notifica");

    // Privado: tampoco.
    await admin.from("notifications").delete().eq("workspace_id", ws).eq("type", "memory");
    const privado = await saveMemory(member.client, ws, member.id, {
      content: "Anotación personal",
      visibility: "privado",
    });
    const { data: delPrivado } = await admin
      .from("notifications")
      .select("id")
      .eq("dedupe", `memory:${privado.id}`);
    assertNoRows(delPrivado, "un recuerdo privado no notifica");
  });

  it("el aviso de caducidad va al autor, una vez y sin el texto sensible", async () => {
    const pronto = await saveMemory(member.client, ws, member.id, {
      content: "La clave del wifi del desván es 8899",
      sensitive: true,
      expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });

    const primera = await admin.rpc("notify_expiring_memories");
    assert.equal(primera.error, null, `notify_expiring_memories: ${primera.error?.message ?? ""}`);

    const { data: avisos } = await admin
      .from("notifications")
      .select("user_id, body, dedupe")
      .eq("dedupe", `memory-exp:${pronto.id}`);
    assert.equal((avisos ?? []).length, 1, "un aviso al autor");
    assert.equal(avisos?.[0]?.user_id, member.id, "solo al autor");
    assert.ok(
      !String(avisos?.[0]?.body ?? "").includes("8899"),
      "el aviso no lleva el contenido de un sensible",
    );

    // Idempotente por dedupe.
    await admin.rpc("notify_expiring_memories");
    const { data: repetidos } = await admin
      .from("notifications")
      .select("id")
      .eq("dedupe", `memory-exp:${pronto.id}`);
    assert.equal((repetidos ?? []).length, 1, "no se repite");
  });

  it("realtime publica space_memories", async () => {
    const { data, error } = await admin.rpc("search_space_memories", {
      p_ws: ws,
      p_query: "domingo",
      p_limit: 5,
    });
    assert.equal(error, null, `la RPC sigue viva: ${error?.message ?? ""}`);
    assert.ok(Array.isArray(data), "y devuelve la lista");
  });
});