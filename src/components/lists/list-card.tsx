"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { ArrowRight } from "lucide-react";
import { useListItems, useCheckListItem } from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import { cn } from "@/lib/utils";

/**
 * Tarjeta viva de lista compartida en el chat (mensaje 'card'): muestra el
 * título, el progreso y los primeros ítems; permite marcar desde el chat.
 * Todo pasa por texto plano (nunca HTML).
 */
export function ListCard({ listId }: { listId: string }): React.JSX.Element {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const itemsQuery = useListItems(listId);
  const checkItem = useCheckListItem(listId);

  const items = itemsQuery.data ?? [];
  const open = items.filter((item) => !item.checked);
  const doneCount = items.length - open.length;

  if (itemsQuery.isPending && items.length === 0) {
    return (
      <span aria-label="Cargando lista" className="block h-20 animate-pulse rounded-xl bg-surface-soft" />
    );
  }
  if (itemsQuery.isError && items.length === 0) {
    return <span className="text-body-sm text-muted-foreground">Lista no disponible.</span>;
  }

  return (
    <div className="flex min-w-52 flex-col gap-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface" aria-hidden="true">
        <div
          className="h-full rounded-full bg-success"
          style={{ width: items.length === 0 ? "0%" : `${Math.round((doneCount / items.length) * 100)}%` }}
        />
      </div>
      <p className="text-meta tabular-nums leading-4 text-muted-foreground">
        {doneCount}/{items.length} listos
      </p>
      <ul className="flex flex-col gap-1">
        {open.slice(0, 5).map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => {
                if (user === null) return;
                void checkItem.mutateAsync({ uid: user.uid, id: item.id, checked: true });
              }}
              aria-label={`Marcar ${item.text}`}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left outline-none interactive"
            >
              <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-divider" />
              <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
                {item.quantity !== "" ? `${item.quantity}${item.unit !== "" ? ` ${item.unit}` : ""} ` : ""}
                {item.text}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open.length > 5 ? (
        <p className="text-meta leading-4 text-muted-foreground">+{open.length - 5} más</p>
      ) : null}
      <button
        type="button"
        onClick={() => router.push(`/proyectos?tab=listas&list=${encodeURIComponent(listId)}`)}
        className={cn(
          "flex min-h-11 items-center justify-center gap-1 rounded-full",
          "bg-surface-soft text-body-sm font-semibold text-foreground outline-none interactive",
        )}
      >
        Abrir lista
        <Icon icon={ArrowRight} size={20} />
      </button>
    </div>
  );
}
