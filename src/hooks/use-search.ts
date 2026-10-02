"use client";

/**
 * Búsqueda con debounce + "ver más" paginado por grupo.
 *
 * Lo usan la paleta de escritorio y la pantalla móvil: misma llamada,
 * mismos filtros deterministas y mismo paginado (`search_more`). Con menos
 * de 2 letras no se consulta nada. Cada `loadMore` pide el siguiente tramo
 * del grupo y lo concatena (sin duplicar por id).
 */

import * as React from "react";
import {
  EMPTY_RESULTS,
  searchAll,
  searchMore,
  type ParsedSearchQuery,
  type SearchGroupKey,
  type SearchGroupMap,
  type SearchResults,
} from "@/lib/data/search";

export const SEARCH_DEBOUNCE_MS = 220;
export const SEARCH_PAGE_SIZE = 8;

export type MoreStatus = {
  loading: boolean;
  /** La última página trajo menos de lo pedido: no hay más. */
  exhausted: boolean;
};

type GroupState = {
  items: unknown[];
  loading: boolean;
  exhausted: boolean;
};

function emptyGroups(): Record<SearchGroupKey, GroupState> {
  const groups = [
    "messages",
    "transcriptions",
    "attachments",
    "lists",
    "list_items",
    "polls",
    "ideas",
    "memories",
    "tasks",
    "projects",
    "events",
    "people",
  ] as const;
  const out = {} as Record<SearchGroupKey, GroupState>;
  for (const group of groups) {
    out[group] = { items: [], loading: false, exhausted: false };
  }
  return out;
}

function itemId(item: unknown): string {
  if (typeof item !== "object" || item === null) return "";
  const record = item as Record<string, unknown>;
  const id = record["id"];
  if (typeof id === "string") return id;
  const userId = record["userId"];
  return typeof userId === "string" ? userId : "";
}

export function useSearchResults(
  wsId: string | null,
  query: string,
  options: { types?: SearchGroupKey[] | null; limit?: number } = {},
): {
  parsed: ParsedSearchQuery;
  results: SearchResults;
  hasQuery: boolean;
  searching: boolean;
  error: string | null;
  totalHits: number;
  more: Record<SearchGroupKey, MoreStatus>;
  loadMore: (group: SearchGroupKey) => void;
  retry: () => void;
} {
  const typesKey = (options.types ?? null)?.join(",") ?? "";
  const limit = options.limit ?? SEARCH_PAGE_SIZE;
  const [results, setResults] = React.useState<SearchResults>(EMPTY_RESULTS);
  const [parsed, setParsed] = React.useState<ParsedSearchQuery>({
    text: "",
    author: null,
    chat: null,
    mine: false,
    from: null,
    to: null,
    labels: [],
  });
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [extra, setExtra] = React.useState<Record<SearchGroupKey, GroupState>>(emptyGroups);
  const [attempt, setAttempt] = React.useState(0);
  const requestRef = React.useRef(0);
  const rawRef = React.useRef("");
  const typesRef = React.useRef<SearchGroupKey[] | null>(options.types ?? null);
  typesRef.current = options.types ?? null;

  const trimmed = query.trim();
  const hasQuery = trimmed.length >= 2;

  // Búsqueda con debounce (a partir de 2 letras).
  React.useEffect(() => {
    if (wsId === null) return;
    if (trimmed.length < 2) {
      requestRef.current += 1;
      setResults(EMPTY_RESULTS);
      setExtra(emptyGroups());
      setSearching(false);
      setError(null);
      setParsed({
        text: trimmed,
        author: null,
        chat: null,
        mine: false,
        from: null,
        to: null,
        labels: [],
      });
      return;
    }
    setSearching(true);
    setError(null);
    const id = requestRef.current + 1;
    requestRef.current = id;
    const timer = setTimeout(() => {
      const types = typesRef.current;
      rawRef.current = trimmed;
      void searchAll(wsId, trimmed, { types, limit })
        .then(({ results: next, parsed: nextParsed }) => {
          if (requestRef.current !== id) return;
          setResults(next);
          setParsed(nextParsed);
          setExtra(emptyGroups());
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, trimmed, typesKey, limit, attempt]);

  // Espejos para que `loadMore` calcule el offset con lo último pintado.
  const extraRef = React.useRef(extra);
  extraRef.current = extra;
  const resultsRef = React.useRef(results);
  resultsRef.current = results;

  const loadMore = React.useCallback(
    (group: SearchGroupKey) => {
      if (wsId === null || wsId === "") return;
      const raw = rawRef.current;
      if (raw.trim().length < 2) return;
      const prev = extraRef.current[group];
      if (prev.loading || prev.exhausted) return;
      setExtra((current) => ({
        ...current,
        [group]: { ...current[group], loading: true },
      }));
      const types = typesRef.current;
      const offset = baseOf(group, resultsRef.current).length + prev.items.length;
      void (async (): Promise<void> => {
        try {
          const items = (await searchMore(wsId, group, raw, {
            types,
            limit,
            offset,
          })) as unknown[];
          setExtra((current) => {
            const seen = new Set([
              ...baseOf(group, resultsRef.current).map(itemId),
              ...current[group].items.map(itemId),
            ]);
            const fresh = items.filter((item) => {
              const id = itemId(item);
              if (id === "" || seen.has(id)) return false;
              seen.add(id);
              return true;
            });
            return {
              ...current,
              [group]: {
                items: [...current[group].items, ...fresh],
                loading: false,
                exhausted: items.length < limit,
              },
            };
          });
        } catch {
          setExtra((current) => ({
            ...current,
            [group]: { ...current[group], loading: false },
          }));
        }
      })();
    },
    [wsId, limit],
  );

  const merged = React.useMemo((): SearchResults => {
    return {
      messages: [
        ...results.messages,
        ...(extra.messages.items as SearchGroupMap["messages"][]),
      ],
      transcriptions: [
        ...results.transcriptions,
        ...(extra.transcriptions.items as SearchGroupMap["transcriptions"][]),
      ],
      attachments: [
        ...results.attachments,
        ...(extra.attachments.items as SearchGroupMap["attachments"][]),
      ],
      lists: [...results.lists, ...(extra.lists.items as SearchGroupMap["lists"][])],
      listItems: [
        ...results.listItems,
        ...(extra.list_items.items as SearchGroupMap["list_items"][]),
      ],
      polls: [...results.polls, ...(extra.polls.items as SearchGroupMap["polls"][])],
      ideas: [...results.ideas, ...(extra.ideas.items as SearchGroupMap["ideas"][])],
      memories: [
        ...results.memories,
        ...(extra.memories.items as SearchGroupMap["memories"][]),
      ],
      tasks: [...results.tasks, ...(extra.tasks.items as SearchGroupMap["tasks"][])],
      projects: [
        ...results.projects,
        ...(extra.projects.items as SearchGroupMap["projects"][]),
      ],
      events: [...results.events, ...(extra.events.items as SearchGroupMap["events"][])],
      people: [...results.people, ...(extra.people.items as SearchGroupMap["people"][])],
    };
  }, [results, extra]);

  const more = React.useMemo((): Record<SearchGroupKey, MoreStatus> => {
    const out = {} as Record<SearchGroupKey, MoreStatus>;
    (Object.keys(extra) as SearchGroupKey[]).forEach((group) => {
      const base = baseOf(group, results).length;
      out[group] = {
        loading: extra[group].loading,
        // Con menos que una página llena en la primera carga, no hay más.
        exhausted: extra[group].exhausted || (base < limit && extra[group].items.length === 0),
      };
    });
    return out;
  }, [extra, results, limit]);

  const totalHits =
    merged.messages.length +
    merged.transcriptions.length +
    merged.attachments.length +
    merged.lists.length +
    merged.listItems.length +
    merged.polls.length +
    merged.ideas.length +
    merged.memories.length +
    merged.tasks.length +
    merged.projects.length +
    merged.events.length +
    merged.people.length;

  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);

  return {
    parsed,
    results: merged,
    hasQuery,
    searching,
    error,
    totalHits,
    more,
    loadMore,
    retry,
  };
}

function baseOf(group: SearchGroupKey, results: SearchResults): unknown[] {
  switch (group) {
    case "messages":
      return results.messages;
    case "transcriptions":
      return results.transcriptions;
    case "attachments":
      return results.attachments;
    case "lists":
      return results.lists;
    case "list_items":
      return results.listItems;
    case "polls":
      return results.polls;
    case "ideas":
      return results.ideas;
    case "memories":
      return results.memories;
    case "tasks":
      return results.tasks;
    case "projects":
      return results.projects;
    case "events":
      return results.events;
    case "people":
      return results.people;
  }
}
