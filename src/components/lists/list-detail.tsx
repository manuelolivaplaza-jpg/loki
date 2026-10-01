"use client";

import * as React from "react";
import {
  ArrowDownUp,
  Bell,
  BellOff,
  ChevronDown,
  ChevronLeft,
  Share2,
  Trash2,
} from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { parseQuantity } from "@/lib/chat/intent";
import { suggestListItems } from "@/lib/data/lists";
import {
  enqueueListOp,
  isNetworkError,
  useListOutboxSync,
} from "@/lib/offline/list-outbox";
import { useMembers } from "@/hooks/use-chat";
import {
  useAddListItem,
  useCheckListItem,
  useClearCheckedItems,
  useDeleteListItem,
  useDeleteShoppingList,
  useListItems,
  useListWatchers,
  useSetListWatcher,
  useUpdateListItem,
  useUpdateShoppingList,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import type { ListItem, ShoppingList } from "@/types/organizer";
import { cn } from "@/lib/utils";

async function haptic(): Promise<void> {
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Web sin hápticos.
  }
}

function attribution(
  item: ListItem,
  members: Map<string, string>,
  uid: string | null,
): string {
  const who = (id: string | null): string => {
    if (id === null) return "";
    if (id === uid) return "ti";
    return members.get(id) ?? "";
  };
  const added = who(item.createdBy);
  const checked = item.checked ? who(item.checkedBy) : "";
  if (added !== "" && checked !== "" && added !== checked) {
    return `${added} · ✓ ${checked}`;
  }
  if (checked !== "") return `✓ ${checked}`;
  return added;
}

/** Segunda línea del ítem: pasillo, responsable, fecha y autoría. */
function ItemMeta({
  item,
  members,
  uid,
}: {
  item: ListItem;
  members: Map<string, string>;
  uid: string | null;
}): React.JSX.Element | null {
  const parts: string[] = [];
  if (item.category !== "") parts.push(item.category);
  if (item.assigneeId !== null) {
    const name = item.assigneeId === uid ? "ti" : (members.get(item.assigneeId) ?? "");
    parts.push(name !== "" ? `→ ${name}` : "→ alguien");
  }
  if (item.dueAt !== null) {
    const date = item.dueAt.toDate();
    parts.push(
      date.toLocaleDateString("es-CL", { day: "numeric", month: "short" }),
    );
  }
  const by = attribution(item, members, uid);
  if (by !== "") parts.push(by);
  if (parts.length === 0) return null;
  return (
    <span className="block truncate text-meta leading-4 text-muted-foreground">
      {parts.join(" · ")}
    </span>
  );
}

/**
 * Diálogo de avisos por lista: "cuando agreguen algo" y/o "cuando esté
 * completa", agrupados en una sola push (dedupe por cuarto de hora).
 */
function WatchDialog({
  listTitle,
  watching,
  onAdd,
  onComplete,
  saving,
  onSave,
  onClose,
}: {
  listTitle: string;
  watching: boolean;
  onAdd: boolean;
  onComplete: boolean;
  saving: boolean;
  onSave: (prefs: { onAdd: boolean; onComplete: boolean } | null) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [add, setAdd] = React.useState(onAdd);
  const [complete, setComplete] = React.useState(onComplete);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Avisos de ${listTitle}`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-card p-4 shadow-overlay"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-body font-semibold text-foreground">Avisarme</h3>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Una sola notificación agrupa los cambios de unos minutos.
        </p>
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-body-sm text-foreground">
          <input
            type="checkbox"
            checked={add}
            onChange={(event) => setAdd(event.target.checked)}
            className="h-6 w-6 shrink-0 accent-[var(--accent)]"
          />
          Cuando agreguen algo
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-body-sm text-foreground">
          <input
            type="checkbox"
            checked={complete}
            onChange={(event) => setComplete(event.target.checked)}
            className="h-6 w-6 shrink-0 accent-[var(--accent)]"
          />
          Cuando esté completa
        </label>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave({ onAdd: add, onComplete: complete })}
            className="min-h-11 flex-1 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
          {watching ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => onSave(null)}
              className="min-h-11 flex-1 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive disabled:opacity-60"
            >
              Dejar de avisar
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 flex-1 rounded-full bg-surface-soft px-4 text-body-sm font-semibold text-foreground outline-none interactive"
            >
              Cerrar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Detalle de lista: pantalla completa en móvil, ítems de 48px, agregar
 * rápido con foco persistente, pegar multilínea, swipe (izq borra, der
 * marca), reordenar y sección plegable de hechos. En escritorio: atajos
 * (Enter agrega, Supr borra en edición) y arrastrar con mouse.
 */
export function ListDetail({
  list,
  wsId,
  onBack,
  onShare,
}: {
  list: ShoppingList;
  wsId: string;
  onBack: () => void;
  onShare: (list: ShoppingList) => void;
}): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const uid = user?.uid ?? null;
  const itemsQuery = useListItems(list.id);
  const membersQuery = useMembers(wsId);
  const watchersQuery = useListWatchers(list.id);
  const addItem = useAddListItem(list.id, wsId);
  const checkItem = useCheckListItem(list.id);
  const updateItem = useUpdateListItem(list.id);
  const deleteItem = useDeleteListItem(list.id);
  const clearChecked = useClearCheckedItems(list.id);
  const updateList = useUpdateShoppingList();
  const deleteList = useDeleteShoppingList();
  const setWatcher = useSetListWatcher(list.id);

  const [draft, setDraft] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editText, setEditText] = React.useState("");
  const [reordering, setReordering] = React.useState(false);
  const [doneOpen, setDoneOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [offlineNotice, setOfflineNotice] = React.useState(false);
  const [watchOpen, setWatchOpen] = React.useState(false);
  const [editCategory, setEditCategory] = React.useState("");
  const [editAssignee, setEditAssignee] = React.useState("");
  const [editDue, setEditDue] = React.useState("");
  const { pending: offlinePending } = useListOutboxSync();
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Swipe por ítem: arrastre horizontal con snap.
  const [swipe, setSwipe] = React.useState<{ id: string; x: number } | null>(null);
  const swipeRef = React.useRef<{ id: string; x: number; y: number } | null>(null);
  const longPressRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelLongPress(): void {
    if (longPressRef.current !== null) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }

  const items = itemsQuery.data ?? [];
  const open = items.filter((item) => !item.checked);
  const done = items.filter((item) => item.checked);
  const members = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const member of membersQuery.data ?? []) {
      map.set(member.uid, member.displayName);
    }
    return map;
  }, [membersQuery.data]);
  const watching = (watchersQuery.data ?? []).some((w) => w.userId === uid);
  const myWatcher = (watchersQuery.data ?? []).find((w) => w.userId === uid) ?? null;

  function openEdit(item: ListItem): void {
    setEditingId(item.id);
    setEditText(item.text);
    setEditCategory(item.category);
    setEditAssignee(item.assigneeId ?? "");
    setEditDue(item.dueAt !== null ? item.dueAt.toDate().toISOString().slice(0, 10) : "");
  }

  // Sugerencias con lo usado antes en el espacio (código, no IA).
  React.useEffect(() => {
    if (draft.trim() === "") {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      void suggestListItems(wsId, draft).then(setSuggestions).catch(() => undefined);
    }, 200);
    return () => clearTimeout(timer);
  }, [draft, wsId]);

  async function submitLines(lines: string[]): Promise<void> {
    if (uid === null) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    setError(null);
    // Pegar varias líneas crea varios ítems.
    const clean = lines.map((line) => line.trim()).filter((line) => line !== "");
    if (clean.length === 0) return;
    try {
      for (const line of clean.slice(0, 20)) {
        // "2 kg de pan" se separa sin IA (solo en compras).
        const parsed = list.kind === "groceries" ? parseQuantity(line) : null;
        const input = parsed === null || (parsed.quantity === "" && parsed.unit === "")
          ? { text: line }
          : { text: parsed.text, quantity: parsed.quantity, unit: parsed.unit };
        try {
          await addItem.mutateAsync({ uid, input });
        } catch (err: unknown) {
          // Sin señal: a la cola offline, se sincroniza al volver.
          if (isNetworkError(err)) {
            enqueueListOp({ op: "add", listId: list.id, wsId, uid, input });
            setOfflineNotice(true);
          } else {
            throw err;
          }
        }
      }
      setDraft("");
      setSuggestions([]);
      inputRef.current?.focus();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo agregar.");
    }
  }

  async function handleToggle(item: ListItem): Promise<void> {
    if (uid === null) return;
    try {
      await checkItem.mutateAsync({ uid, id: item.id, checked: !item.checked });
      void haptic();
    } catch (err: unknown) {
      if (isNetworkError(err)) {
        enqueueListOp({
          op: "check",
          listId: list.id,
          wsId,
          uid,
          itemId: item.id,
          checked: !item.checked,
        });
        setOfflineNotice(true);
        void haptic();
        return;
      }
      setError(err instanceof Error ? err.message : "No se pudo marcar.");
    }
  }

  async function handleSaveEdit(item: ListItem): Promise<void> {
    const text = editText.trim();
    if (text === "") {
      setError("El ítem no puede quedar vacío.");
      return;
    }
    const patch: {
      text?: string;
      category?: string;
      assigneeId?: string | null;
      dueAt?: Date | null;
    } = {};
    if (text !== item.text) patch.text = text;
    if (editCategory.trim() !== item.category) patch.category = editCategory.trim().slice(0, 60);
    if ((editAssignee === "" ? null : editAssignee) !== item.assigneeId) {
      patch.assigneeId = editAssignee === "" ? null : editAssignee;
    }
    const dueISO = editDue !== "" ? new Date(`${editDue}T12:00:00`) : null;
    const prevISO = item.dueAt !== null ? item.dueAt.toDate().toISOString().slice(0, 10) : "";
    if (editDue !== prevISO) patch.dueAt = dueISO;
    if (Object.keys(patch).length === 0) {
      setEditingId(null);
      return;
    }
    try {
      await updateItem.mutateAsync({ id: item.id, patch });
      setEditingId(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo editar.");
    }
  }

  async function handleMove(item: ListItem, direction: -1 | 1): Promise<void> {
    const pool = item.checked ? done : open;
    const index = pool.findIndex((entry) => entry.id === item.id);
    const other = pool[index + direction];
    if (other === undefined) return;
    // Punto medio entre vecinos (como en tasks: sin reescribir todo).
    const before = direction === -1 ? pool[index - 2] : other;
    const after = direction === -1 ? other : pool[index + 2];
    const prev = direction === -1
      ? (before?.position ?? other.position - 2048)
      : item.position;
    const next = direction === -1
      ? item.position
      : (after?.position ?? other.position + 2048);
    try {
      await updateItem.mutateAsync({ id: item.id, patch: { position: (prev + next) / 2 } });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo mover.");
    }
  }

  function onTouchStart(item: ListItem, event: React.TouchEvent): void {
    const touch = event.touches[0];
    if (touch === undefined) return;
    swipeRef.current = { id: item.id, x: touch.clientX, y: touch.clientY };
    // Mantener pulsado abre la edición (sin mover el dedo).
    cancelLongPress();
    longPressRef.current = setTimeout(() => {
      openEdit(item);
      void haptic();
    }, 550);
  }

  function onTouchMove(item: ListItem, event: React.TouchEvent): void {
    const start = swipeRef.current;
    const touch = event.touches[0];
    if (start === null || touch === undefined || start.id !== item.id) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) cancelLongPress();
    if (Math.abs(dy) > 24) {
      swipeRef.current = null;
      setSwipe(null);
      return;
    }
    setSwipe({ id: item.id, x: Math.max(-96, Math.min(96, dx)) });
  }

  async function onTouchEnd(item: ListItem): Promise<void> {
    const current = swipe;
    swipeRef.current = null;
    cancelLongPress();
    setSwipe(null);
    if (current === null || current.id !== item.id) return;
    // Izquierda borra, derecha marca.
    if (current.x <= -64) {
      try {
        await deleteItem.mutateAsync(item.id);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "No se pudo borrar.");
      }
    } else if (current.x >= 64) {
      await handleToggle(item);
    }
  }

  function itemRow(item: ListItem): React.JSX.Element {
    const offset = swipe?.id === item.id ? swipe.x : 0;
    const editing = editingId === item.id;
    return (
      <li key={item.id}>
        <div
          draggable={reordering}
          onDragStart={(event) => {
            event.dataTransfer.setData("text/loki-item", item.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={reordering ? (event) => event.preventDefault() : undefined}
          onDrop={
            reordering
              ? (event) => {
                event.preventDefault();
                const fromId = event.dataTransfer.getData("text/loki-item");
                if (fromId === "" || fromId === item.id) return;
                const pool = item.checked ? done : open;
                const from = pool.find((entry) => entry.id === fromId);
                if (from === undefined) return;
                const targetIndex = pool.findIndex((entry) => entry.id === item.id);
                const before = pool[targetIndex - 1];
                const prev = before?.position ?? item.position - 2048;
                void updateItem.mutateAsync({
                  id: fromId,
                  patch: { position: (prev + item.position) / 2 },
                }).catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "No se pudo mover.");
                });
              }
              : undefined
          }
          onTouchStart={(event) => onTouchStart(item, event)}
          onTouchMove={(event) => onTouchMove(item, event)}
          onTouchEnd={() => void onTouchEnd(item)}
          className={cn(
            "flex min-h-12 items-center gap-2 rounded-xl bg-surface-soft px-3 transition-transform",
            offset !== 0 && "transition-none",
          )}
          style={offset !== 0 ? { transform: `translateX(${offset}px)` } : undefined}
        >
          <button
            type="button"
            role="checkbox"
            aria-checked={item.checked}
            aria-label={item.checked ? `Desmarcar ${item.text}` : `Marcar ${item.text}`}
            onClick={() => void handleToggle(item)}
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-full outline-none",
              item.checked ? "text-success" : "text-muted-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border-2",
                item.checked ? "border-success bg-success text-white" : "border-divider",
              )}
            >
              {item.checked ? "✓" : ""}
            </span>
          </button>
          <div className="min-w-0 flex-1 py-2">
            {editing ? (
              <div className="flex flex-col gap-1">
                <input
                  type="text"
                  autoFocus
                  aria-label="Editar ítem"
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  onBlur={() => void handleSaveEdit(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSaveEdit(item);
                    if (event.key === "Escape") setEditingId(null);
                    if (event.key === "Delete" && editText === "") {
                      void deleteItem.mutateAsync(item.id).catch(() => undefined);
                      setEditingId(null);
                    }
                  }}
                  maxLength={200}
                  className="h-11 w-full rounded-sm bg-background px-2 text-body-sm text-foreground outline-none"
                />
                <div className="flex gap-1">
                  <input
                    type="text"
                    aria-label="Categoría o pasillo"
                    placeholder="Pasillo…"
                    value={editCategory}
                    onChange={(event) => setEditCategory(event.target.value)}
                    onBlur={() => void handleSaveEdit(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleSaveEdit(item);
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    maxLength={60}
                    className="h-9 min-w-0 flex-1 rounded-sm bg-background px-2 text-body-sm text-foreground outline-none"
                  />
                  {list.kind === "chores" ? (
                    <>
                      <select
                        aria-label="Responsable"
                        value={editAssignee}
                        onChange={(event) => {
                          setEditAssignee(event.target.value);
                        }}
                        onBlur={() => void handleSaveEdit(item)}
                        className="h-9 min-w-0 flex-1 rounded-sm bg-background px-1 text-body-sm text-foreground outline-none"
                      >
                        <option value="">Sin responsable</option>
                        {(membersQuery.data ?? []).map((member) => (
                          <option key={member.uid} value={member.uid}>
                            {member.displayName}
                          </option>
                        ))}
                      </select>
                      <input
                        type="date"
                        aria-label="Fecha"
                        value={editDue}
                        onChange={(event) => setEditDue(event.target.value)}
                        onBlur={() => void handleSaveEdit(item)}
                        className="h-9 min-w-0 flex-1 rounded-sm bg-background px-1 text-body-sm text-foreground outline-none"
                      />
                    </>
                  ) : null}
                </div>
              </div>
            ) : (
              <button
                type="button"
                aria-label={`Editar ${item.text}`}
                onDoubleClick={() => openEdit(item)}
                onClick={() => openEdit(item)}
                onKeyDown={(event) => {
                  // Escritorio: Espacio marca, Supr borra.
                  if (event.key === " ") {
                    event.preventDefault();
                    void handleToggle(item);
                  }
                  if (event.key === "Delete") {
                    event.preventDefault();
                    void deleteItem.mutateAsync(item.id).catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : "No se pudo borrar.");
                    });
                  }
                }}
                className="block w-full truncate text-left text-body-sm text-foreground outline-none"
              >
                <span className={cn(item.checked && "text-muted-foreground line-through")}>
                  {item.quantity !== "" ? `${item.quantity}${item.unit !== "" ? ` ${item.unit}` : ""} ` : ""}
                  {item.text}
                </span>
                <ItemMeta
                  item={item}
                  members={members}
                  uid={uid}
                />
              </button>
            )}
          </div>
          {reordering ? (
            <span className="flex shrink-0 flex-col">
              <button
                type="button"
                aria-label="Subir"
                onClick={() => void handleMove(item, -1)}
                className="flex h-8 w-11 items-center justify-center rounded-sm text-foreground outline-none"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Bajar"
                onClick={() => void handleMove(item, 1)}
                className="flex h-8 w-11 items-center justify-center rounded-sm text-foreground outline-none"
              >
                ↓
              </button>
            </span>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-center gap-1 py-2">
        <IconButton variant="ghost" aria-label="Volver a listas" onClick={onBack}>
          <Icon icon={ChevronLeft} size={20} />
        </IconButton>
        <span aria-hidden="true" className="text-title">
          {list.emoji}
        </span>
        <h2 className="min-w-0 flex-1 truncate text-title font-semibold text-foreground">
          {list.title}
        </h2>
        <IconButton
          variant="ghost"
          aria-label={reordering ? "Terminar de reordenar" : "Reordenar"}
          onClick={() => setReordering((value) => !value)}
        >
          <Icon icon={ArrowDownUp} size={20} />
        </IconButton>
        <IconButton
          variant="ghost"
          aria-label={watching ? "Dejar de avisarme" : "Avisarme de cambios"}
          onClick={() => setWatchOpen(true)}
        >
          <Icon icon={watching ? BellOff : Bell} size={20} />
        </IconButton>
        <IconButton variant="ghost" aria-label="Compartir en el chat" onClick={() => onShare(list)}>
          <Icon icon={Share2} size={20} />
        </IconButton>
      </div>

      {/* Agregar rápido: siempre visible, cerca del pulgar. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submitLines([draft]);
        }}
        className="sticky top-[68px] z-10 bg-background pb-2"
      >
        <input
          ref={inputRef}
          type="text"
          aria-label="Agregar ítem"
          placeholder={list.kind === "groceries" ? "2 kg de pan…" : "Agregar ítem…"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (pasted.includes("\n")) {
              event.preventDefault();
              void submitLines(pasted.split("\n"));
            }
          }}
          maxLength={200}
          className="h-12 w-full rounded-xl bg-surface-soft px-4 text-body text-foreground outline-none"
        />
        {suggestions.length > 0 ? (
          <ul aria-label="Sugerencias" className="mt-1 flex flex-col gap-1">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="block w-full truncate rounded-lg bg-surface-soft px-4 py-2 text-left text-body-sm text-foreground outline-none"
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>

      {error !== null ? (
        <p role="alert" className="pb-2 text-body-sm text-danger">
          {error}
        </p>
      ) : null}
      {offlineNotice || offlinePending > 0 ? (
        <p role="status" className="pb-2 text-body-sm text-muted-foreground">
          Sin conexión: {offlinePending > 0 ? `${offlinePending} cambio(s) por sincronizar. ` : ""}
          Se guardará al volver la red.
        </p>
      ) : null}
      {watchOpen ? (
        <WatchDialog
          listTitle={list.title}
          watching={watching}
          onAdd={myWatcher?.onAdd ?? true}
          onComplete={myWatcher?.onComplete ?? true}
          saving={setWatcher.isPending}
          onSave={(prefs) => {
            if (uid === null) {
              setError("Tu sesión expiró. Vuelve a iniciar sesión.");
              return;
            }
            void setWatcher
              .mutateAsync({ uid, prefs })
              .then(() => setWatchOpen(false))
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "No se pudo guardar el aviso.");
              });
          }}
          onClose={() => setWatchOpen(false)}
        />
      ) : null}

      {itemsQuery.isPending && items.length === 0 ? (
        <div aria-label="Cargando ítems" className="flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <span key={index} aria-hidden="true" className="block h-12 animate-pulse rounded-xl bg-surface-soft" />
          ))}
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2" aria-label="Por hacer">
            {open.map(itemRow)}
          </ul>
          {done.length > 0 ? (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-expanded={doneOpen}
                  onClick={() => setDoneOpen((value) => !value)}
                  className="flex min-h-11 flex-1 items-center gap-1 text-body-sm font-medium text-muted-foreground outline-none"
                >
                  <Icon
                    icon={ChevronDown}
                    size={20}
                    className={cn("transition-transform", !doneOpen && "-rotate-90")}
                  />
                  Hechos ({done.length})
                </button>
                {doneOpen ? (
                  <button
                    type="button"
                    onClick={() => {
                      void clearChecked.mutateAsync().catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : "No se pudo limpiar.");
                      });
                    }}
                    className="flex min-h-11 items-center gap-1 rounded-full px-3 text-body-sm font-medium text-danger outline-none"
                  >
                    <Icon icon={Trash2} size={20} />
                    Limpiar
                  </button>
                ) : null}
              </div>
              {doneOpen ? (
                <ul className="mt-2 flex flex-col gap-2" aria-label="Hechos">
                  {done.map(itemRow)}
                </ul>
              ) : null}
            </div>
          ) : null}
          {open.length === 0 && done.length === 0 ? (
            <p className="py-6 text-center text-body-sm text-muted-foreground">
              Lista vacía. Agrega lo primero arriba.
            </p>
          ) : null}
        </>
      )}

      <div className="mt-4 flex justify-center gap-4 pb-8">
        <button
          type="button"
          onClick={() => {
            void updateList.mutateAsync({ id: list.id, patch: { pinned: !list.pinned } });
          }}
          className="text-body-sm font-medium text-muted-foreground outline-none"
        >
          {list.pinned ? "No fijar" : "Fijar en Inicio"}
        </button>
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-body-sm font-medium text-danger outline-none"
          >
            Borrar lista
          </button>
        ) : (
          <span className="flex items-center gap-2">
            <span className="text-body-sm text-muted-foreground">¿Seguro?</span>
            <button
              type="button"
              onClick={() => {
                void deleteList.mutateAsync(list.id).then(onBack).catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "No se pudo borrar.");
                  setConfirmDelete(false);
                });
              }}
              className="min-h-11 rounded-full bg-danger px-4 text-body-sm font-medium text-white outline-none"
            >
              Sí, borrar
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="min-h-11 rounded-full px-4 text-body-sm font-medium text-muted-foreground outline-none"
            >
              No
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
