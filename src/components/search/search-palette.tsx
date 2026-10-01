"use client";

/**
 * Paleta de búsqueda global (Cmd/Ctrl+K y lupa).
 *
 * Montaje único en `AppShell`: overlay + input con grupos de resultados
 * (Mensajes, Notas de voz, Tareas, Proyectos, Eventos y Personas), acciones
 * rápidas y recientes cuando la consulta está vacía. Teclado: ↑↓ navegar,
 * Enter abrir, Esc cerrar. Las coincidencias se resaltan con `<mark>`.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CalendarPlus,
  ClipboardList,
  FolderKanban,
  FolderPlus,
  History,
  MessageCircle,
  Search,
  Sparkles,
  UserPlus,
  Users,
  X,
  Mic,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "@/components/ui/icon";
import {
  EMPTY_RESULTS,
  getRecents,
  highlight,
  pushRecent,
  searchAll,
  type RecentItem,
  type RecentKind,
  type SearchResults,
} from "@/lib/data/search";
import { useSearchStore } from "@/stores/search-store";
import { cn } from "@/lib/utils";

/** Espera tras la última tecla antes de llamar a la RPC. */
const SEARCH_DEBOUNCE_MS = 220;

type ActionKind =
  | "message"
  | "task"
  | "project"
  | "event"
  | "action"
  | "recent"
  | "transcription";

type PaletteItem = {
  key: string;
  kind: ActionKind;
  recentKind: RecentKind;
  title: string;
  subtitle: string;
  href: string;
  icon: LucideIcon;
  /** Texto donde se resaltan las coincidencias (por defecto el título). */
  highlightText: string;
  /** Emoji en vez de icono (proyectos). */
  emoji?: string;
};

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
];

const ROLE_LABELS: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  member: "Miembro",
};

/** Normaliza para filtrar acciones (minúsculas y sin tildes). */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function formatEventDate(iso: string): string {
  if (iso === "") return "Evento";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Evento";
  return date.toLocaleDateString("es", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Texto con las coincidencias envueltas en `<mark>`. */
function Marked({ query, text }: { query: string; text: string }): React.JSX.Element {
  const parts = highlight(query, text);
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark
            key={index}
            className="rounded-sm bg-accent/20 font-semibold text-inherit"
          >
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        ),
      )}
    </>
  );
}

type PaletteSection = {
  label: string;
  items: PaletteItem[];
};

function recentToItem(recent: RecentItem): PaletteItem {
  const action = QUICK_ACTIONS.find((item) => item.href === recent.href);
  return {
    key: `recent:${recent.href}`,
    kind: "recent",
    recentKind: recent.kind,
    title: recent.title,
    subtitle: recent.subtitle,
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
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResults>(EMPTY_RESULTS);
  const [recents, setRecents] = React.useState<RecentItem[]>([]);
  const [active, setActive] = React.useState(0);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const requestRef = React.useRef(0);
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement>());

  const close = React.useCallback(() => setOpen(false), [setOpen]);

  // Al abrir: consulta limpia, resultados vacíos y recientes del espacio.
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults(EMPTY_RESULTS);
    setError(null);
    setActive(0);
    requestRef.current += 1;
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
  }, [open]);

  // Búsqueda con debounce (a partir de 2 letras).
  React.useEffect(() => {
    if (!open || wsId === null) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      requestRef.current += 1;
      setResults(EMPTY_RESULTS);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    const id = requestRef.current + 1;
    requestRef.current = id;
    const timer = setTimeout(() => {
      void searchAll(wsId, trimmed)
        .then((next) => {
          if (requestRef.current !== id) return;
          setResults(next);
          setSearching(false);
        })
        .catch(() => {
          if (requestRef.current !== id) return;
          setResults(EMPTY_RESULTS);
          setSearching(false);
          setError("No se pudo buscar. Inténtalo de nuevo.");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, wsId, query]);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length >= 2;

  const sections: PaletteSection[] = React.useMemo(() => {
    if (!hasQuery) {
      const out: PaletteSection[] = [];
      if (recents.length > 0) {
        out.push({ label: "Recientes", items: recents.map(recentToItem) });
      }
      out.push({
        label: "Acciones",
        items: QUICK_ACTIONS.map((action) => ({
          key: `action:${action.key}`,
          kind: "action",
          recentKind: "action",
          title: action.title,
          subtitle: action.subtitle,
          href: action.href,
          icon: action.icon,
          highlightText: action.title,
        })),
      });
      return out;
    }
    const norm = normalize(trimmedQuery);
    const out: PaletteSection[] = [];
    if (results.messages.length > 0) {
      out.push({
        label: "Mensajes",
        items: results.messages.map((hit) => ({
          key: `message:${hit.id}`,
          kind: "message",
          recentKind: "message",
          title: hit.text === "" ? "(sin texto)" : hit.text,
          subtitle: `${hit.authorName} · ${hit.chatName}`,
          href: `/chat/c?id=${encodeURIComponent(hit.chatId)}`,
          icon: MessageCircle,
          highlightText: hit.text,
        })),
      });
    }
    if (results.transcriptions.length > 0) {
      out.push({
        label: "Notas de voz",
        items: results.transcriptions.map((hit) => ({
          key: `transcription:${hit.id}`,
          kind: "transcription",
          recentKind: "message",
          title: hit.text === "" ? "(sin texto)" : hit.text,
          subtitle:
            hit.authorName === ""
              ? "Transcripción"
              : `${hit.authorName} · transcripción`,
          // Sin mensaje (dictado suelto): al chat de Loki, que es donde se
          // puede volver a escuchar. Con mensaje: al chat de la nota.
          href:
            hit.chatId !== null && hit.chatId !== ""
              ? `/chat/c?id=${encodeURIComponent(hit.chatId)}`
              : "/chat/loki-ia",
          icon: Mic,
          highlightText: hit.text,
        })),
      });
    }
    if (results.tasks.length > 0) {
      out.push({
        label: "Tareas",
        items: results.tasks.map((hit) => ({
          key: `task:${hit.id}`,
          kind: "task",
          recentKind: "task",
          title: hit.title,
          subtitle: hit.projectName === "" ? "Tarea" : hit.projectName,
          href: `/proyectos?project=${encodeURIComponent(hit.projectId)}&task=${encodeURIComponent(hit.id)}`,
          icon: ClipboardList,
          highlightText: hit.title,
        })),
      });
    }
    if (results.projects.length > 0) {
      out.push({
        label: "Proyectos",
        items: results.projects.map((hit) => ({
          key: `project:${hit.id}`,
          kind: "project",
          recentKind: "project",
          title: hit.name,
          subtitle: "Proyecto",
          href: `/proyectos?project=${encodeURIComponent(hit.id)}`,
          icon: FolderKanban,
          highlightText: hit.name,
          emoji: hit.emoji,
        })),
      });
    }
    if (results.events.length > 0) {
      out.push({
        label: "Eventos",
        items: results.events.map((hit) => ({
          key: `event:${hit.id}`,
          kind: "event",
          recentKind: "event",
          title: hit.title,
          subtitle: formatEventDate(hit.startsAt),
          href: "/calendario",
          icon: CalendarDays,
          highlightText: hit.title,
        })),
      });
    }
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
      href: action.href,
      icon: action.icon,
      highlightText: action.title,
    }));
    if (actions.length > 0) {
      out.push({ label: "Acciones", items: actions });
    }
    return out;
  }, [hasQuery, trimmedQuery, results, recents]);

  // Personas: informativas (sin destino propio), fuera de la navegación.
  const people = hasQuery ? results.people : [];

  const flat: PaletteItem[] = React.useMemo(
    () => sections.flatMap((section) => section.items),
    [sections],
  );

  // Al cambiar los resultados se vuelve al primero.
  React.useEffect(() => {
    setActive(0);
  }, [query, results]);

  const safeActive = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);

  // La fila activa siempre queda visible.
  React.useEffect(() => {
    if (safeActive < 0) return;
    rowRefs.current.get(flat[safeActive]?.key ?? "")?.scrollIntoView({
      block: "nearest",
    });
  }, [safeActive, flat]);

  function choose(item: PaletteItem): void {
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

  function handleKey(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
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

  const totalHits =
    results.messages.length +
    results.transcriptions.length +
    results.tasks.length +
    results.projects.length +
    results.events.length +
    results.people.length;

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
            placeholder="Buscar mensajes, tareas, proyectos…"
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
          id="search-results"
          role="listbox"
          aria-label="Resultados"
          className="max-h-[55vh] overflow-y-auto pb-2"
        >
          {searching ? (
            <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
              Buscando…
            </p>
          ) : error !== null ? (
            <p role="alert" className="px-4 py-6 text-center text-body-sm text-danger">
              {error}
            </p>
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
                      onMouseMove={() => {
                        if (index !== active) setActive(index);
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none",
                        isActive ? "bg-surface-soft" : "bg-transparent",
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
                            <Marked query={trimmedQuery} text={item.highlightText} />
                          ) : (
                            item.title
                          )}
                        </span>
                        <span className="block truncate text-meta leading-5 text-muted-foreground">
                          {item.subtitle}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}

          {people.length > 0 ? (
            <div>
              <p className="px-4 pb-1 pt-3 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                Personas
              </p>
              {people.map((person) => (
                <div
                  key={person.userId}
                  className="flex w-full items-center gap-3 px-4 py-2.5"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-soft"
                  >
                    <Icon icon={Users} size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-foreground">
                      <Marked query={trimmedQuery} text={person.displayName} />
                    </span>
                    <span className="block truncate text-meta leading-5 text-muted-foreground">
                      {ROLE_LABELS[person.role] ?? "Miembro"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {!hasQuery && recents.length === 0 ? (
            <p className="px-4 py-3 text-center text-meta text-muted-foreground">
              Escribe al menos 2 letras para buscar en el espacio.
            </p>
          ) : null}
        </div>

        <div className="hidden items-center justify-between border-t border-divider px-4 py-2 text-meta text-muted-foreground sm:flex">
          <span>↑↓ navegar · Enter abrir · Esc cerrar</span>
          <span>⌘K / Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
