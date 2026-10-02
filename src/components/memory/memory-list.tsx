"use client";

import * as React from "react";
import { Brain, Plus, Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { QueryRetry } from "@/components/ui/query-retry";
import { SectionLabel } from "@/components/ui/section-label";
import { MemoryRow } from "@/components/memory/memory-row";
import { MemorySheet } from "@/components/memory/memory-sheet";
import {
  useDeleteMemory,
  useMemories,
  usePinMemory,
  useShareMemory,
} from "@/hooks/use-memories";
import { useMembers } from "@/hooks/use-chat";
import { memoryCategoryLabel } from "@/lib/memory/memory";
import { useSessionStore } from "@/stores/session-store";
import type { MemoryItem, MemorySearchHit } from "@/types/organizer";
import { cn } from "@/lib/utils";

/** Fila de un resultado de búsqueda (misma forma, sin gestos). */
function MemoryHitRow({
  hit,
  onOpen,
}: {
  hit: MemorySearchHit;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  const hidden = hit.sensitive;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(hit.id)}
        aria-label={
          hidden
            ? "Recuerdo sensible oculto, ábrelo para verlo"
            : `${memoryCategoryLabel(hit.category)}. ${hit.content}`
        }
        className="flex min-h-12 w-full items-start gap-3 rounded-xl bg-surface-soft px-3 py-3 text-left outline-none interactive"
      >
        <span className="min-w-0 flex-1">
          <span
            className={cn("block text-body-sm leading-5 text-foreground", hidden && "select-none")}
            style={hidden ? { filter: "blur(6px)" } : undefined}
            aria-hidden={hidden}
          >
            {hit.content}
          </span>
          <span className="block text-meta leading-4 text-muted-foreground">
            {[
              memoryCategoryLabel(hit.category),
              hit.authorName,
              ...(hit.pinned ? ["Fijado"] : []),
            ].join(" · ")}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Pantalla Memoria del espacio: buscador arriba y la lista de recuerdos.
 *
 * Móvil: deslizar a la izquierda borra y mantener pulsado edita. Escritorio:
 * las acciones salen al pasar el ratón y hay atajos (Supr borra, Espacio
 * fija, Enter abre). Los sensibles salen tapados hasta que alguien confirma
 * "Mostrar", y se vuelven a tapar al salir de la pantalla.
 */
export function MemoryList({ wsId }: { wsId: string }): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const uid = user?.uid ?? null;
  const [query, setQuery] = React.useState("");
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MemoryItem | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<MemoryItem | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const state = useMemories(wsId, query);
  const membersQuery = useMembers(wsId);
  const removeMemory = useDeleteMemory(wsId);
  const pinMemory = usePinMemory(wsId);
  const shareMemoryMutation = useShareMemory(wsId);

  const names = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const member of membersQuery.data ?? []) {
      map.set(member.uid, member.displayName);
    }
    return map;
  }, [membersQuery.data]);

  const adminUids = React.useMemo(() => {
    const out = new Set<string>();
    for (const member of membersQuery.data ?? []) {
      if (member.role === "owner" || member.role === "admin") out.add(member.uid);
    }
    return out;
  }, [membersQuery.data]);

  const authorName = (id: string | null): string => {
    if (id === null) return "Alguien";
    if (id === uid) return "tú";
    return names.get(id) ?? "Alguien";
  };

  const rows = state.isSearching ? [] : state.memories;
  const total = state.isSearching ? state.hits.length : state.memories.length;

  function handleDelete(memory: MemoryItem): void {
    // Dos toques: el primero muestra "¿Borrar?" (mismo patrón que el resto).
    if (confirmDelete === null || confirmDelete.id !== memory.id) {
      setConfirmDelete(memory);
      return;
    }
    setConfirmDelete(null);
    setError(null);
    removeMemory.mutate(memory.id, {
      onError: (err) => setError(err.message),
    });
  }

  function handleTogglePin(memory: MemoryItem): void {
    setError(null);
    pinMemory.mutate(
      { id: memory.id, pinned: !memory.pinned },
      { onError: (err) => setError(err.message) },
    );
  }

  function handleShare(memory: MemoryItem): void {
    setError(null);
    shareMemoryMutation.mutate(memory.id, {
      onError: (err) => setError(err.message),
    });
  }

  function handleEdit(memory: MemoryItem): void {
    setEditing(memory);
    setSheetOpen(true);
  }

  function openMemory(id: string): void {
    const found = state.memories.find((memory) => memory.id === id);
    if (found === undefined) return;
    handleEdit(found);
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-center justify-between gap-2 px-1 pt-2">
        <SectionLabel>Memoria del espacio</SectionLabel>
        <IconButton
          variant="solid"
          aria-label="Nuevo recuerdo"
          onClick={() => {
            setEditing(null);
            setSheetOpen(true);
          }}
        >
          <Icon icon={Plus} size={20} />
        </IconButton>
      </div>

      {/* Buscador arriba: la misma búsqueda full-text que usa Loki, sin IA. */}
      <div className="mt-2 flex items-center gap-2 rounded-xl bg-surface-soft px-3">
        <Icon icon={Search} size={20} className="shrink-0 text-muted-foreground" />
        <input
          type="search"
          aria-label="Buscar en la memoria"
          placeholder="Buscar en la memoria…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={80}
          className="h-12 min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
        />
        {query !== "" ? (
          <button
            type="button"
            aria-label="Limpiar búsqueda"
            onClick={() => setQuery("")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
          >
            <Icon icon={X} size={20} />
          </button>
        ) : null}
      </div>

      {error !== null ? (
        <p role="alert" className="mt-2 text-body-sm text-danger">
          {error}
        </p>
      ) : null}
      {confirmDelete !== null ? (
        <div className="mt-2 flex items-center gap-2 rounded-xl bg-surface-soft px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">
            ¿Borrar “{confirmDelete.content.slice(0, 40)}”?
          </span>
          <button
            type="button"
            onClick={() => {
              handleDelete(confirmDelete);
            }}
            className="min-h-11 rounded-full bg-danger px-4 text-body-sm font-semibold text-white outline-none interactive-solid"
          >
            Borrar
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(null)}
            className="min-h-11 rounded-full px-3 text-body-sm font-medium text-muted-foreground outline-none interactive"
          >
            Cancelar
          </button>
        </div>
      ) : null}

      {state.isPending && total === 0 ? (
        <div aria-label="Cargando recuerdos" className="mt-3 flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              aria-hidden="true"
              className="block h-16 animate-pulse rounded-xl bg-surface-soft"
            />
          ))}
        </div>
      ) : state.isError && total === 0 ? (
        <QueryRetry
          message="No se pudieron cargar los recuerdos."
          onRetry={state.retry}
        />
      ) : total === 0 ? (
        <EmptyState
          icon={Brain}
          title={state.isSearching ? "Sin coincidencias" : "Memoria vacía"}
          description={
            state.isSearching
              ? "Prueba con otra palabra: aquí está lo que el espacio recuerda."
              : "Pídele a Loki «recuerda que…» o usa + para guardar algo útil del espacio."
          }
          action={
            state.isSearching
              ? undefined
              : {
                  label: "Guardar un recuerdo",
                  onClick: () => {
                    setEditing(null);
                    setSheetOpen(true);
                  },
                }
          }
        />
      ) : (
        <Card className="mt-3 flex flex-col gap-2 p-2">
          {state.isSearching ? (
            state.hits.map((hit) => (
              <MemoryHitRow key={hit.id} hit={hit} onOpen={openMemory} />
            ))
          ) : (
            rows.map((memory) => (
              <MemoryRow
                key={memory.id}
                memory={memory}
                authorName={authorName(memory.createdBy)}
                isMine={memory.createdBy !== null && memory.createdBy === uid}
                canManage={
                  (memory.createdBy !== null && memory.createdBy === uid) ||
                  (uid !== null && adminUids.has(uid))
                }
                onEdit={handleEdit}
                onDelete={handleDelete}
                onTogglePin={handleTogglePin}
                onShare={handleShare}
              />
            ))
          )}
        </Card>
      )}

      {state.isSearching && state.hits.length > 0 ? (
        <p className="mt-2 text-meta text-muted-foreground">
          {state.hits.length} {state.hits.length === 1 ? "coincidencia" : "coincidencias"}
        </p>
      ) : null}

      <MemorySheet
        open={sheetOpen}
        wsId={wsId}
        memory={editing}
        // Tras guardar, la lista ya está al día por Realtime.
        onClose={() => {
          setSheetOpen(false);
          setEditing(null);
        }}
      />
    </div>
  );
}