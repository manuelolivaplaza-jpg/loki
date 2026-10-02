"use client";

/**
 * Pantalla de búsqueda completa (móvil primero, sirve en escritorio).
 *
 * La abre la lupa del header móvil (`mobile-header.tsx`): chips de filtro
 * desplazables, resultados grandes fáciles de tocar, teclado del sistema con
 * botón "Buscar" (el formulario lo cierra al enviar) y el botón atrás del
 * sistema cierra (es una ruta: `/buscar`). Búsquedas recientes y sugerencias
 * cuando la consulta está vacía, "ver más" por grupo y "Preguntar a Loki"
 * al final.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Search, Sparkles, X } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import {
  buildLokiQuestion,
  getRecents,
  pushRecent,
  SEARCH_SUGGESTIONS,
  type RecentItem,
  type SearchGroupKey,
} from "@/lib/data/search";
import {
  Marked,
  TYPE_CHIPS,
  buildResultSections,
  type ResultItem,
} from "@/components/search/search-sections";
import { useSearchResults } from "@/hooks/use-search";
import { useSearchStore } from "@/stores/search-store";
import { useWorkspaces } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

export function SearchScreen(): React.JSX.Element {  const router = useRouter();
  const { currentWorkspaceId } = useWorkspaces();
  const setLokiQuestion = useSearchStore((state) => state.setLokiQuestion);
  const [value, setValue] = React.useState("");
  const [chip, setChip] = React.useState("all");
  const [recents, setRecents] = React.useState<RecentItem[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const activeChip = TYPE_CHIPS.find((item) => item.key === chip) ?? TYPE_CHIPS[0];
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
  } = useSearchResults(currentWorkspaceId, value, { types: activeChip?.types ?? null });

  React.useEffect(() => {
    setRecents(currentWorkspaceId === null ? [] : getRecents(currentWorkspaceId));
  }, [currentWorkspaceId]);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = value.trim();
  const highlightQuery = parsed.text === "" ? trimmed : parsed.text;
  const sections = hasQuery
    ? buildResultSections(results, highlightQuery)
    : [];
  const showAskLoki = hasQuery && !searching && error === null && totalHits > 0;

  function open(item: ResultItem): void {
    if (item.href === null || currentWorkspaceId === null) return;
    pushRecent(currentWorkspaceId, {
      kind: item.recentKind,
      title: item.title,
      subtitle: item.subtitle,
      href: item.href,
    });
    router.push(item.href);
  }

  function askLoki(): void {
    if (currentWorkspaceId === null || totalHits === 0) return;
    setLokiQuestion({ id: crypto.randomUUID(), text: buildLokiQuestion(trimmed, results) });
    router.push("/chat/loki-ia");
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col bg-background pb-[env(safe-area-inset-bottom)]">
      <header className="sticky top-0 z-40 border-b border-divider bg-background/95 backdrop-blur">
        <div className="flex items-center gap-1 px-2 pt-[env(safe-area-inset-top)]">
          <IconButton variant="floating" aria-label="Volver" onClick={() => router.back()}>
            <Icon icon={ArrowLeft} size={24} />
          </IconButton>
          <h1 className="min-w-0 flex-1 text-body font-semibold text-foreground">
            Buscar
          </h1>
        </div>
        <form
          role="search"
          className="flex items-center gap-2 px-4 pb-2"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            inputRef.current?.blur();
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-soft px-4">
            <Icon icon={Search} size={20} className="shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="search"
              enterKeyHint="search"
              aria-label="Buscar en el espacio"
              placeholder="Mensajes, archivos, listas…"
              value={value}
              onChange={(formEvent) => setValue(formEvent.target.value)}
              autoComplete="off"
              className="h-12 min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {value !== "" ? (
              <button
                type="button"
                aria-label="Limpiar búsqueda"
                onClick={() => setValue("")}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
              >
                <Icon icon={X} size={20} />
              </button>
            ) : null}
          </div>
        </form>
        <div
          role="toolbar"
          aria-label="Filtrar por tipo"
          className="flex gap-1.5 overflow-x-auto px-4 pb-3"
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
                  "shrink-0 rounded-full px-4 py-2 text-body-sm font-medium outline-none interactive",
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
      </header>

      {parsed.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3" aria-label="Filtros activos">
          {parsed.labels.map((label) => (
            <span
              key={label}
              className="rounded-full bg-accent/15 px-3 py-1.5 text-body-sm font-medium text-accent"
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex-1 px-2 pb-6">
        {searching && totalHits === 0 ? (
          <div aria-label="Buscando" className="flex flex-col gap-2 px-2 py-3">
            {[0, 1, 2, 3].map((index) => (
              <span
                key={index}
                aria-hidden="true"
                className="block h-16 animate-pulse rounded-xl bg-surface-soft"
              />
            ))}
          </div>
        ) : error !== null ? (
          <div className="px-4 py-8 text-center">
            <p role="alert" className="text-body text-danger">
              {error}
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 min-h-11 rounded-full bg-surface-soft px-6 text-body font-medium text-foreground outline-none interactive"
            >
              Reintentar
            </button>
          </div>
        ) : !hasQuery ? (
          <div className="px-2 py-3">
            {recents.length > 0 ? (
              <>
                <p className="px-2 pb-1 pt-2 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                  Recientes
                </p>
                {recents.map((recent) => (
                  <button
                    key={recent.href}
                    type="button"
                    onClick={() => router.push(recent.href)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left outline-none interactive active:bg-surface-soft"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-foreground">
                        {recent.title}
                      </span>
                      <span className="block truncate text-body-sm text-muted-foreground">
                        {recent.subtitle}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : null}
            <p className="px-2 pb-1 pt-2 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
              Prueba con
            </p>
            <div className="flex flex-wrap gap-2 px-2">
              {SEARCH_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setValue((prev) => `${prev}${prev.endsWith(" ") || prev === "" ? "" : " "}${suggestion}`);
                    inputRef.current?.focus();
                  }}
                  className="min-h-11 rounded-full bg-surface-soft px-4 text-body-sm font-medium text-foreground outline-none interactive"
                >
                  {suggestion.trim() === "" ? suggestion : `«${suggestion.trim()}»`}
                </button>
              ))}
            </div>
            <p className="px-2 py-4 text-center text-body-sm text-muted-foreground">
              Escribe al menos 2 letras para buscar en todo el espacio.
            </p>
          </div>
        ) : totalHits === 0 && sections.length === 0 ? (
          <p className="px-4 py-8 text-center text-body text-muted-foreground">
            Sin resultados para «{trimmed}».
          </p>
        ) : (
          sections.map((section) => (
            <div key={section.key}>
              <p className="px-2 pb-1 pt-4 text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                {section.label}
              </p>
              {section.items.map((item) =>
                item.href === null ? (
                  <div
                    key={item.key}
                    className="flex min-h-14 w-full items-center gap-3 rounded-xl px-2 py-2.5"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-soft text-title"
                    >
                      <Icon icon={item.icon} size={22} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-foreground">
                        <Marked query={highlightQuery} text={item.highlightText} />
                      </span>
                      <span className="block truncate text-body-sm text-muted-foreground">
                        {item.subtitle}
                      </span>
                    </span>
                  </div>
                ) : (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => open(item)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left outline-none interactive active:bg-surface-soft"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-soft text-title"
                    >
                      {item.emoji !== undefined && item.emoji !== "" ? (
                        <span className="text-xl">{item.emoji}</span>
                      ) : (
                        <Icon icon={item.icon} size={22} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-foreground">
                        <Marked query={highlightQuery} text={item.highlightText} />
                      </span>
                      <span className="block truncate text-body-sm text-muted-foreground">
                        {item.subtitle}
                      </span>
                      {item.detail !== null ? (
                        <span className="block truncate text-body-sm text-muted-foreground">
                          <Marked query={highlightQuery} text={item.detail} />
                        </span>
                      ) : null}
                    </span>
                  </button>
                ),
              )}
              {section.group === null || more[section.group].exhausted ? null : (
                <GroupMore
                  group={section.group}
                  loading={more[section.group].loading}
                  onMore={loadMore}
                />
              )}
            </div>
          ))
        )}

        {showAskLoki ? (
          <div className="px-2 py-4">
            <button
              type="button"
              onClick={askLoki}
              className="flex min-h-14 w-full items-center gap-3 rounded-xl bg-surface-soft px-4 py-3 text-left outline-none interactive"
            >
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background dark:bg-white dark:text-black"
              >
                <Icon icon={Sparkles} size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-foreground">
                  Preguntar a Loki
                </span>
                <span className="block truncate text-body-sm text-muted-foreground">
                  Responde usando estos resultados como contexto
                </span>
              </span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GroupMore({
  group,
  loading,
  onMore,
}: {
  group: SearchGroupKey;
  loading: boolean;
  onMore: (group: SearchGroupKey) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onMore(group)}
      disabled={loading}
      className="ml-12 min-h-11 rounded-full px-4 text-body font-medium text-accent outline-none interactive disabled:opacity-60"
    >
      {loading ? "Cargando…" : "Ver más"}
    </button>
  );
}
