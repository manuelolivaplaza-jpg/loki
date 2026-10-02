"use client";

/**
 * Paleta de búsqueda global (Cmd/Ctrl+K y lupa).
 *
 * Montaje único en `AppShell`: overlay + input con chips de tipo, grupos de
 * resultados (mensajes, voz, archivos, listas, ítems, encuestas, ideas,
 * recuerdos, tareas, proyectos, eventos y personas), "ver más" paginado por
 * grupo y el botón "Preguntar a Loki" al final. Teclado: ↑↓ navegar, Tab
 * saltar entre grupos, Enter abrir, Esc cerrar. Las coincidencias se
 * resaltan con `<mark>`.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Brain,
  CalendarPlus,
  ClipboardList,
  FolderPlus,
  History,
  Search,
  Sparkles,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "@/components/ui/icon";
import {
  buildLokiQuestion,
  getRecents,
  pushRecent,
  type RecentItem,
  type SearchGroupKey,
} from "@/lib/data/search";
import {
  Marked,
  TYPE_CHIPS,
  buildResultSections,
  type ResultItem,
  type ResultSection,
} from "@/components/search/search-sections";
import { useSearchResults } from "@/hooks/use-search";
import { useSearchStore } from "@/stores/search-store";
import { cn } from "@/lib/utils";

type QuickAction = {
  key: string;
  title: string;
  subtitle: string;
  href: string;
  icon: LucideIcon;
};

const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    key: "evento",
    title: "Nuevo evento",
    subtitle: "Agenda en el calendario",
    href: "/calendario",
    icon: CalendarPlus,
  },
  {
    key: "tarea",
    title: "Nueva tarea",
    subtitle: "Añade una tarea a un proyecto",
    href: "/proyectos",
    icon: ClipboardList,
  },
  {
    key: "proyecto",
    title: "Nuevo proyecto",
    subtitle: "Organiza tareas en un espacio",
    href: "/proyectos",
    icon: FolderPlus,
  },
  {
    key: "invitar",
    title: "Invitar",
    subtitle: "Suma a alguien a tu espacio",
    href: "/invite",
    icon: UserPlus,
  },
  {
    key: "loki",
    title: "Ir a Loki",
    subtitle: "Tu asistente personal",
    href: "/chat/loki-ia",
    icon: Sparkles,
  },
  {
    key: "memoria",
    title: "Memoria del espacio",
    subtitle: "Lo que el espacio recuerda",
    href: "/memoria",
    icon: Brain,
  },
];

/** Normaliza para filtrar acciones (minúsculas y sin tildes). */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function recentToItem(recent: RecentItem): ResultItem {
  const action = QUICK_ACTIONS.find((item) => item.href === recent.href);
  return {
    key: `recent:${recent.href}`,
    kind: "recent",
    recentKind: recent.kind,
    title: recent.title,
    subtitle: recent.subtitle,
    detail: null,
    href: recent.href,
    icon: action?.icon ?? History,
    highlightText: recent.title,
  };
}

export function SearchPalette({
  wsId,
}: {
  wsId: string | null;
}): React.JSX.Element | null {
  const router = useRouter();
  const open = useSearchStore((state) => state.open);
  const setOpen = useSearchStore((state) => state.setOpen);
  const setLokiQuestion = useSearchStore((state) => state.setLokiQuestion);
  const [query, setQuery] = React.useState("");
  const [chip, setChip] = React.useState("all");
  const [recents, setRecents] = React.useState<RecentItem[]>([]);
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement>());

  const activeChip = TYPE_CHIPS.find((item) => item.key === chip) ?? TYPE_CHIPS[0];
  const types = activeChip?.types ?? null;
  const {
    parsed,
    results,
    hasQuery,
    searching,
    error,
    totalHits,
    more,
    loadMore,
    retry,
  } = useSearchResults(wsId, query, { types });

  const close = React.useCallback(() => setOpen(false), [setOpen]);

  // Al abrir: consulta limpia, chip en Todo y recientes del espacio.
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setChip("all");
    setActive(0);
    setRecents(wsId === null ? [] : getRecents(wsId));
  }, [open, wsId]);

  // Foco + bloqueo del scroll mientras está abierta.
  React.useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open ]);

  const trimmedQuery = query.trim();

  const sections: ResultSection[] = React.useMemo(() => {
    if (!hasQuery) {
      const out: ResultSection[] = [];
      if (recents.length > 0) {
        out.push({
          key: "recents",
          label: "Recientes",
          group: null,
          items: recents.map(recentToItem),
        });
      }
      out.push({
        key: "actions",
        label: "Acciones",
        group: null,
        items: QUICK_ACTIONS.map((action) => ({
          key: `action:${action.key}`,
          kind: "action",
          recentKind: "action",
          title: action.title,
          subtitle: action.subtitle,
          detail: null,
          href: action.href,
          icon: action.icon,
          highlightText: action.title,
        })),
      });
      return out;
    }
    const norm = normalize(trimmedQuery);
    const out = buildResultSections(results, parsed.text === "" ? trimmedQuery : parsed.text);
    const actions = QUICK_ACTIONS.filter(
      (action) =>
        normalize(action.title).includes(norm) ||
        normalize(action.subtitle).includes(norm),
    ).map((action) => ({
      key: `action:${action.key}`,
      kind: "action" as const,
      recentKind: "action" as const,
      title: action.title,
      subtitle: action.subtitle,
      detail: null as string | null,
      href: action.href as string | null,
      icon: action.icon,
      highlightText: action.title,
    }));
    if (actions.length > 0) {
      out.push({ key: "actions", label: "Acciones", group: null, items: actions });
    }
    return out;
  }, [hasQuery, trimmedQuery, results, parsed, recents]);

  const flat: ResultItem[] = React.useMemo(
    () => sections.flatMap((section) => section.items),
    [sections],
  );

  // Inicios de grupo para saltar con Tab.
  const groupStarts = React.useMemo(() => {
    const starts: number[] = [];
    let cursor = 0;
    for (const section of sections) {
      if (section.items.length > 0) starts.push(cursor);
      cursor += section.items.length;
    }
    return starts;
  }, [sections]);

  // Al cambiar los resultados se vuelve al primero.
  React.useEffect(() => {
    setActive(0);
  }, [query, results, chip]);

  const safeActive = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);

  // La fila activa siempre queda visible.
  React.useEffect(() => {
    if (safeActive < 0) return;
    rowRefs.current.get(flat[safeActive]?.key ?? "")?.scrollIntoView({
      block: "nearest",
    });
  }, [safeActive, flat]);

  function choose(item: ResultItem): void {
    if (item.href === null) return;
    if (wsId !== null) {
      pushRecent(wsId, {
        kind: item.recentKind,
        title: item.title,
        subtitle: item.subtitle,
        href: item.href,
      });
    }
    close();
    router.push(item.href);
  }

  function askLoki(): void {
    if (wsId === null || totalHits === 0) return;
    const question = buildLokiQuestion(trimmedQuery, results);
    setLokiQuestion({ id: crypto.randomUUID(), text: question });
    close();
    router.push("/chat/loki-ia");
  }

  function handleKey(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (groupStarts.length === 0) return;
      const forward = !event.shiftKey;
      const current = safeActive < 0 ? 0 : safeActive;
      if (forward) {
        const next = groupStarts.find((start) => start > current);
        setActive(next ?? groupStarts[0] ?? 0);
      } else {
        const prev = [...groupStarts].reverse().find((start) => start < current);
        setActive(prev ?? groupStarts[groupStarts.length - 1] ?? 0);
      }
      return;
    }
    if (flat.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((prev) => (prev + 1) % flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((prev) => (prev - 1 + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = flat[safeActive];
      if (item !== undefined) choose(item);
    }
  }

  if (!open) return null;

  const showAskLoki = hasQuery && !searching && error === null && totalHits > 0;
  const highlightQuery = parsed.text === "" ? trimmedQuery : parsed.text;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Búsqueda"
      className="fixed inset-0 z-50"
    >
      <button
        type="button"
        aria-label="Cerrar búsqueda"
        onClick={close}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div className="relative mx-auto mt-[8vh] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-xl bg-background shadow-overlay">
        <div className="flex items-center gap-2 border-b border-divider px-4">
          <Icon icon={Search} size={20} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-activedescendant={
              safeActive >= 0 && flat[safeActive] !== undefined
                ? `search-item-${flat[safeActive]?.key}`
                : undefined
            }
            aria-label="Buscar"
            placeholder="Buscar mensajes, archivos, listas… (de:, en:, solo míos)"
            value={query}
            onChange={(formEvent) => setQuery(formEvent.target.value)}
            onKeyDown={handleKey}
            autoComplete="off"
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

        <div
          role="toolbar"
          aria-label="Filtrar por tipo"
          className="flex gap-1.5 overflow-x-auto border-b border-divider px-3 py-2"
        >
          {TYPE_CHIPS.map((item) => {
            const selected = item.key === chip;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={selected}
                onClick={() => setChip(item.key)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-body-sm font-medium outline-none interactive",
                  selected
                    ? "bg-foreground text-background"
                    : "bg-surface-soft text-muted-foreground",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {parsed.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-4 pt-2" aria-label="Filtros activos">
            {parsed.labels.map((label) => (
              <span
                key={label}
                className="rounded-full bg-accent/15 px-2.5 py-1 text-meta font-medium text-accent"
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}

        <div
          id="search-results"
          role="listbox"
          aria-label="Resultados"
          className="max-h-[55vh] overflow-y-auto pb-2"
        >
          {searching && totalHits === 0 ? (
            <div aria-label="Buscando" className="flex flex-col gap-2 px-4 py-3">
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  aria-hidden="true"
                  className="block h-12 animate-pulse rounded-lg bg-surface-soft"
                />
              ))}
            </div>
          ) : error !== null ? (
            <div className="px-4 py-6 text-center">
              <p role="alert" className="text-body-sm text-danger">
                {error}
              </p>
              <button
                type="button"
                onClick={retry}
                className="mt-2 rounded-full bg-surface-soft px-4 py-2 text-body-sm font-medium text-foreground outline-none interactive"
              >
                Reintentar
              </button>
            </div>
          ) : hasQuery && totalHits === 0 && sections.length === 0 ? (
            <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
              Sin resultados para «{trimmedQuery}».
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.label}>
                <p className="px-4 pb-1 pt-3 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.label}
                </p>
                {section.items.map((item) => {
                  const index = flat.indexOf(item);
                  const isActive = index === safeActive;
                  const clickable = item.href !== null;
                  return (
                    <button
                      key={item.key}
                      ref={(node) => {
                        if (node === null) {
                          rowRefs.current.delete(item.key);
                        } else {
                          rowRefs.current.set(item.key, node);
                        }
                      }}
                      id={`search-item-${item.key}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => choose(item)}
                      disabled={!clickable}
                      onMouseMove={() => {
                        if (index !== active) setActive(index);
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none",
                        isActive ? "bg-surface-soft" : "bg-transparent",
                        !clickable && "cursor-default",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-soft text-title"
                      >
                        {item.emoji !== undefined && item.emoji !== "" ? (
                          item.emoji
                        ) : (
                          <Icon icon={item.icon} size={20} />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-foreground">
                          {hasQuery && item.kind !== "recent" ? (
                            <Marked query={highlightQuery} text={item.highlightText} />
                          ) : (
                            item.title
                          )}
                        </span>
                        <span className="block truncate text-meta leading-5 text-muted-foreground">
                          {item.subtitle}
                        </span>
                        {item.detail !== null ? (
                          <span className="block truncate text-meta leading-5 text-muted-foreground">
                            {hasQuery ? (
                              <Marked query={highlightQuery} text={item.detail} />
                            ) : (
                              item.detail
                            )}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                {section.group !== null ? (
                  <MoreButton
                    group={section.group}
                    loading={more[section.group].loading}
                    exhausted={more[section.group].exhausted}
                    onMore={() => loadMore(section.group as SearchGroupKey)}
                  />
                ) : null}
              </div>
            ))
          )}

          {showAskLoki ? (
            <div className="px-4 py-3">
              <button
                type="button"
                onClick={askLoki}
                className="flex w-full items-center gap-3 rounded-xl bg-surface-soft px-4 py-3 text-left outline-none interactive"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background dark:bg-white dark:text-black"
                >
                  <Icon icon={Sparkles} size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-foreground">
                    Preguntar a Loki
                  </span>
                  <span className="block truncate text-meta leading-5 text-muted-foreground">
                    Responde usando estos resultados como contexto
                  </span>
                </span>
              </button>
            </div>
          ) : null}

          {!hasQuery && recents.length === 0 ? (
            <p className="px-4 py-3 text-center text-meta text-muted-foreground">
              Escribe al menos 2 letras para buscar en el espacio.
            </p>
          ) : null}
        </div>

        <div className="hidden items-center justify-between border-t border-divider px-4 py-2 text-meta text-muted-foreground sm:flex">
          <span>↑↓ navegar · Tab entre grupos · Enter abrir · Esc cerrar</span>
          <span>⌘K / Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}

function MoreButton({
  group,
  loading,
  exhausted,
  onMore,
}: {
  group: SearchGroupKey;
  loading: boolean;
  exhausted: boolean;
  onMore: () => void;
}): React.JSX.Element | null {
  void group;
  if (exhausted) return null;
  return (
    <button
      type="button"
      onClick={onMore}
      disabled={loading}
      className="ml-[4.25rem] rounded-full px-3 py-1.5 text-body-sm font-medium text-accent outline-none interactive disabled:opacity-60"
    >
      {loading ? "Cargando…" : "Ver más"}
    </button>
  );
}
