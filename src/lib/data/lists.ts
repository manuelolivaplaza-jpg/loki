"use client";

/**
 * Listas compartidas sobre Supabase: CRUD de listas e ítems, vigilancia por
 * lista, autocompletado con ítems usados en el espacio y compartir al chat
 * como tarjeta viva (mensaje 'card').
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/supabase";
import type { ListItem, ListWatcher, ShoppingList } from "@/types/organizer";

type ListRow = Database["public"]["Tables"]["lists"]["Row"];
type ItemRow = Database["public"]["Tables"]["list_items"]["Row"];

function toTimestamp(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function toTimestampOrNull(iso: string | null): Timestamp | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

const LIST_COLUMNS =
  "id, workspace_id, title, emoji, color, kind, pinned, archived, created_by, created_at, updated_at";

const ITEM_COLUMNS =
  "id, list_id, workspace_id, text, quantity, unit, category, checked, checked_by, checked_at, assignee_id, due_at, position, created_by, created_at, updated_at";

function toList(row: ListRow, open: number, total: number): ShoppingList {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    emoji: row.emoji,
    color: row.color,
    kind: row.kind as ShoppingList["kind"],
    pinned: row.pinned,
    archived: row.archived,
    createdBy: row.created_by ?? "",
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
    open,
    total,
  };
}

function toItem(row: ItemRow): ListItem {
  return {
    id: row.id,
    listId: row.list_id,
    workspaceId: row.workspace_id,
    text: row.text,
    quantity: row.quantity,
    unit: row.unit,
    category: row.category,
    checked: row.checked,
    checkedBy: row.checked_by,
    checkedAt: toTimestampOrNull(row.checked_at),
    assigneeId: row.assignee_id,
    dueAt: toTimestampOrNull(row.due_at),
    position: row.position,
    createdBy: row.created_by ?? "",
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

export async function listShoppingLists(wsId: string): Promise<ShoppingList[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("lists")
    .select(LIST_COLUMNS)
    .eq("workspace_id", wsId)
    .eq("archived", false)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error !== null) {
    throw new Error("No se pudieron cargar las listas.");
  }
  const rows = (data ?? []) as ListRow[];
  // Conteo abierto/total por lista (una sola ronda).
  const counts = new Map<string, { open: number; total: number }>();
  if (rows.length > 0) {
    const { data: items } = await client
      .from("list_items")
      .select("list_id, checked")
      .in("list_id", rows.map((row) => row.id));
    for (const item of (items ?? []) as { list_id: string; checked: boolean }[]) {
      const entry = counts.get(item.list_id) ?? { open: 0, total: 0 };
      entry.total += 1;
      if (!item.checked) entry.open += 1;
      counts.set(item.list_id, entry);
    }
  }
  return rows.map((row) => {
    const entry = counts.get(row.id) ?? { open: 0, total: 0 };
    return toList(row, entry.open, entry.total);
  });
}

export async function createShoppingList(
  wsId: string,
  uid: string,
  input: { title: string; emoji?: string; color?: string; kind?: ShoppingList["kind"] },
): Promise<string> {
  const title = input.title.trim().slice(0, 120);
  if (title === "") throw new Error("Ponle un título a la lista.");
  const { data, error } = await getSupabaseClient()
    .from("lists")
    .insert({
      workspace_id: wsId,
      title,
      emoji: input.emoji ?? "🛒",
      color: input.color ?? "#1d9bf0",
      kind: input.kind ?? "checklist",
      created_by: uid,
    })
    .select("id")
    .single();
  if (error !== null || data === null) {
    throw new Error("No se pudo crear la lista.");
  }
  return (data as { id: string }).id;
}

export async function updateShoppingList(
  id: string,
  patch: { title?: string; emoji?: string; color?: string; pinned?: boolean; archived?: boolean },
): Promise<void> {
  const { error } = await getSupabaseClient().from("lists").update(patch).eq("id", id);
  if (error !== null) {
    throw new Error("No se pudo guardar la lista.");
  }
}

export async function deleteShoppingList(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("lists").delete().eq("id", id);
  if (error !== null) {
    throw new Error("No se pudo borrar la lista.");
  }
}

export async function listItems(listId: string): Promise<ListItem[]> {
  const { data, error } = await getSupabaseClient()
    .from("list_items")
    .select(ITEM_COLUMNS)
    .eq("list_id", listId)
    .order("checked", { ascending: true })
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(500);
  if (error !== null) {
    throw new Error("No se pudieron cargar los ítems.");
  }
  return ((data ?? []) as ItemRow[]).map(toItem);
}

export type NewListItem = {
  text: string;
  quantity?: string;
  unit?: string;
  category?: string;
  assigneeId?: string | null;
  dueAt?: Date | null;
};

export async function addListItem(
  listId: string,
  wsId: string,
  uid: string,
  input: NewListItem,
): Promise<string> {
  const text = input.text.trim().slice(0, 200);
  if (text === "") throw new Error("Escribe el ítem primero.");
  const client = getSupabaseClient();
  // Casi-duplicado seguido (doble toque / dos personas): se fusiona.
  const { data: dup } = await client
    .from("list_items")
    .select("id")
    .eq("list_id", listId)
    .eq("checked", false)
    .ilike("text", text)
    .gte("created_at", new Date(Date.now() - 60_000).toISOString())
    .limit(1)
    .maybeSingle();
  if (dup !== null) return (dup as { id: string }).id;
  const { data: last } = await client
    .from("list_items")
    .select("position")
    .eq("list_id", listId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = last !== null && typeof (last as { position: unknown }).position === "number"
    ? Number((last as { position: number }).position) + 1024
    : 1024;
  const { data, error } = await client
    .from("list_items")
    .insert({
      list_id: listId,
      workspace_id: wsId,
      text,
      quantity: input.quantity ?? "",
      unit: input.unit ?? "",
      category: input.category ?? "",
      assignee_id: input.assigneeId ?? null,
      due_at: input.dueAt?.toISOString() ?? null,
      position,
      created_by: uid,
    })
    .select("id")
    .single();
  if (error !== null || data === null) {
    throw new Error("No se pudo agregar el ítem.");
  }
  return (data as { id: string }).id;
}

export async function setItemChecked(
  id: string,
  uid: string,
  checked: boolean,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("list_items")
    .update({
      checked,
      checked_by: checked ? uid : null,
      checked_at: checked ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error !== null) {
    throw new Error("No se pudo marcar el ítem.");
  }
}

export async function updateListItem(
  id: string,
  patch: { text?: string; quantity?: string; unit?: string; category?: string; assigneeId?: string | null; dueAt?: Date | null; position?: number },
): Promise<void> {
  const data: {
    text?: string;
    quantity?: string;
    unit?: string;
    category?: string;
    assignee_id?: string | null;
    due_at?: string | null;
    position?: number;
  } = {};
  if (patch.text !== undefined) {
    const text = patch.text.trim().slice(0, 200);
    if (text === "") throw new Error("El ítem no puede quedar vacío.");
    data["text"] = text;
  }
  if (patch.quantity !== undefined) data["quantity"] = patch.quantity;
  if (patch.unit !== undefined) data["unit"] = patch.unit;
  if (patch.category !== undefined) data["category"] = patch.category;
  if (patch.assigneeId !== undefined) data["assignee_id"] = patch.assigneeId;
  if (patch.dueAt !== undefined) data["due_at"] = patch.dueAt?.toISOString() ?? null;
  if (patch.position !== undefined) data["position"] = patch.position;
  const { error } = await getSupabaseClient().from("list_items").update(data).eq("id", id);
  if (error !== null) {
    throw new Error("No se pudo editar el ítem.");
  }
}

export async function deleteListItem(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("list_items").delete().eq("id", id);
  if (error !== null) {
    throw new Error("No se pudo borrar el ítem.");
  }
}

export async function clearCheckedItems(listId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("list_items")
    .delete()
    .eq("list_id", listId)
    .eq("checked", true);
  if (error !== null) {
    throw new Error("No se pudieron limpiar los hechos.");
  }
}

/** Títulos usados antes en el espacio (autocompletado, código no IA). */
export async function suggestListItems(wsId: string, query: string): Promise<string[]> {
  const q = query.trim();
  if (q === "") return [];
  const { data, error } = await getSupabaseClient()
    .from("list_items")
    .select("text")
    .eq("workspace_id", wsId)
    .ilike("text", `%${q}%`)
    .limit(50);
  if (error !== null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of (data ?? []) as { text: string }[]) {
    const key = row.text.trim().toLowerCase();
    if (key !== "" && !seen.has(key)) {
      seen.add(key);
      out.push(row.text.trim());
    }
    if (out.length >= 6) break;
  }
  return out;
}

export async function getListWatchers(listId: string): Promise<ListWatcher[]> {
  const { data, error } = await getSupabaseClient()
    .from("list_watchers")
    .select("user_id, list_id, on_add, on_complete")
    .eq("list_id", listId);
  if (error !== null) return [];
  return ((data ?? []) as {
    user_id: string;
    list_id: string;
    on_add: boolean;
    on_complete: boolean;
  }[]).map((row) => ({
    userId: row.user_id,
    listId: row.list_id,
    onAdd: row.on_add,
    onComplete: row.on_complete,
  }));
}

export async function setListWatcher(
  uid: string,
  listId: string,
  prefs: { onAdd: boolean; onComplete: boolean } | null,
): Promise<void> {
  const client = getSupabaseClient();
  if (prefs === null) {
    const { error } = await client
      .from("list_watchers")
      .delete()
      .eq("user_id", uid)
      .eq("list_id", listId);
    if (error !== null) throw new Error("No se pudo quitar el aviso.");
    return;
  }
  const { error } = await client.from("list_watchers").upsert(
    { user_id: uid, list_id: listId, on_add: prefs.onAdd, on_complete: prefs.onComplete },
    { onConflict: "user_id,list_id" },
  );
  if (error !== null) throw new Error("No se pudo guardar el aviso.");
}

export type Unsubscribe = () => void;

/** Ítems en vivo de una lista (sin bucles). */
export function listenListItems(listId: string, cb: (items: ListItem[]) => void): Unsubscribe {
  const supabase = getSupabaseClient();
  const channel = supabase.channel(`loki:list-items:${listId}`);
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "list_items", filter: `list_id=eq.${listId}` },
    () => {
      void listItems(listId).then(cb).catch(() => undefined);
    },
  );
  channel.subscribe();
  void listItems(listId).then(cb).catch(() => undefined);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void supabase.removeChannel(channel);
  };
}

/** Listas en vivo del espacio (sin bucles). */
export function listenShoppingLists(wsId: string, cb: (lists: ShoppingList[]) => void): Unsubscribe {
  const supabase = getSupabaseClient();
  const channel = supabase.channel(`loki:lists:${wsId}`);
  const reload = (): void => {
    void listShoppingLists(wsId).then(cb).catch(() => undefined);
  };
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "lists", filter: `workspace_id=eq.${wsId}` },
    reload,
  );
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "list_items", filter: `workspace_id=eq.${wsId}` },
    reload,
  );
  channel.subscribe();
  reload();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void supabase.removeChannel(channel);
  };
}
