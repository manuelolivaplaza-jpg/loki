"use client";

import * as React from "react";
import { Pin, PinOff, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { QueryRetry } from "@/components/ui/query-retry";
import { SectionLabel } from "@/components/ui/section-label";
import {
  useCreateShoppingList,
  useShoppingLists,
  useUpdateShoppingList,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import type { ShoppingList } from "@/types/organizer";
import { cn } from "@/lib/utils";

const KIND_OPTIONS: readonly { value: ShoppingList["kind"]; label: string }[] = [
  { value: "groceries", label: "Compras" },
  { value: "chores", label: "Quehaceres" },
  { value: "checklist", label: "Checklist" },
];

const KIND_LABELS: Record<ShoppingList["kind"], string> = {
  groceries: "Compras",
  chores: "Quehaceres",
  checklist: "Checklist",
};

/**
 * Pestaña Listas: tarjetas con emoji, tipo, fijadas primero y "faltan N".
 */
export function ListsTab({
  wsId,
  onOpen,
}: {
  wsId: string | null;
  onOpen: (list: ShoppingList) => void;
}): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const listsQuery = useShoppingLists(wsId);
  const createList = useCreateShoppingList(wsId);
  const updateList = useUpdateShoppingList();
  const [formOpen, setFormOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [kind, setKind] = React.useState<ShoppingList["kind"]>("groceries");
  const [error, setError] = React.useState<string | null>(null);

  const lists = listsQuery.data ?? [];

  async function handleCreate(formEvent: React.FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (user === null) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    setError(null);
    try {
      const id = await createList.mutateAsync({ uid: user.uid, title, kind });
      setTitle("");
      setFormOpen(false);
      const created = lists.find((item) => item.id === id);
      if (created !== undefined) onOpen(created);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo crear la lista.");
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between px-2">
        <SectionLabel>Listas del espacio</SectionLabel>
        <IconButton variant="solid" aria-label="Nueva lista" onClick={() => setFormOpen((v) => !v)}>
          <Icon icon={Plus} size={20} />
        </IconButton>
      </div>
      {formOpen ? (
        <form onSubmit={(event) => void handleCreate(event)} className="mt-2 flex flex-col gap-2 px-2">
          <input
            type="text"
            autoFocus
            aria-label="Título de la lista"
            placeholder="Súper del sábado"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            className="h-11 rounded-sm bg-surface-soft px-3 text-body-sm text-foreground outline-none"
          />
          <div className="flex gap-2" role="radiogroup" aria-label="Tipo de lista">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                onClick={() => setKind(option.value)}
                className={cn(
                  "h-9 flex-1 rounded-full text-body-sm font-medium outline-none",
                  kind === option.value
                    ? "bg-foreground text-background dark:bg-white dark:text-black"
                    : "bg-surface-soft text-muted-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {error !== null ? (
            <p role="alert" className="text-body-sm text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={createList.isPending}
            className="min-h-11 rounded-full bg-foreground px-4 text-body-sm font-semibold text-background outline-none interactive disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {createList.isPending ? "Creando…" : "Crear lista"}
          </button>
        </form>
      ) : null}
      {listsQuery.isPending && lists.length === 0 ? (
        <div aria-label="Cargando listas" className="mt-2 flex flex-col gap-2">
          {[0, 1].map((index) => (
            <span
              key={index}
              aria-hidden="true"
              className="block h-16 animate-pulse rounded-lg bg-surface-soft"
            />
          ))}
        </div>
      ) : listsQuery.isError && lists.length === 0 ? (
        <QueryRetry
          message="No se pudieron cargar las listas."
          onRetry={() => void listsQuery.refetch()}
        />
      ) : lists.length === 0 && !formOpen ? (
        <EmptyState
          icon={Plus}
          title="Sin listas todavía"
          description="Crea la del súper, los quehaceres o lo que sea."
        />
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {lists.map((list) => (
            <li key={list.id}>
              <Card
                className={cn(
                  "flex w-full items-center gap-3 p-4 text-left outline-none interactive",
                  "cursor-pointer",
                )}
                role="button"
                tabIndex={0}
                aria-label={`${list.title}, faltan ${list.open} de ${list.total}`}
                onClick={() => onOpen(list)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onOpen(list);
                }}
              >
                <span aria-hidden="true" className="text-title">
                  {list.emoji}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-semibold text-foreground">
                    {list.title}
                  </span>
                  <span className="block text-meta leading-4 text-muted-foreground">
                    {KIND_LABELS[list.kind]}
                    {list.total > 0 ? ` · faltan ${list.open} de ${list.total}` : " · vacía"}
                  </span>
                </span>
                <IconButton
                  variant="ghost"
                  aria-label={list.pinned ? "No fijar" : "Fijar"}
                  onClick={(event) => {
                    event.stopPropagation();
                    void updateList.mutateAsync({ id: list.id, patch: { pinned: !list.pinned } });
                  }}
                >
                  <Icon icon={list.pinned ? PinOff : Pin} size={20} />
                </IconButton>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
