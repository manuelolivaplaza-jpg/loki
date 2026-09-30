"use client";

import * as React from "react";

/**
 * Ventana virtual ligera por intersección (T35, sin librerías nuevas).
 *
 * Las listas de chat y feed ya paginan por cursor (`MESSAGES_PAGE_SIZE`,
 * `POSTS_PAGE_SIZE`); este hook limita además CUÁNTOS nodos se pintan: solo
 * los últimos `limit` elementos. Cuando el centinela superior entra en
 * pantalla, la ventana crece en pasos y avisa con `onGrow` para que la
 * vista pida la página anterior al servidor.
 */

export const LIST_WINDOW_INITIAL = 60;
export const LIST_WINDOW_STEP = 60;

type UseListWindowOptions = {
  /** Total de elementos disponibles (los ya cargados en caché). */
  total: number;
  /** ¿Queda página anterior en el servidor? */
  hasMore: boolean;
  /** Carga la página anterior (cursor). */
  onLoadOlder?: () => Promise<void> | void;
  initial?: number;
  step?: number;
  /** Al cambiar (p. ej. otro chat), la ventana vuelve al tamaño inicial. */
  resetKey?: string;
};

type UseListWindowResult = {
  /** Elementos visibles (los últimos `limit` del total). */
  limit: number;
  /** Ref del centinela superior (crece la ventana + pide página). */
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  /** Ref del centinela inferior (solo agranda la ventana, p. ej. feed). */
  bottomSentinelRef: React.RefObject<HTMLDivElement | null>;
  /** Ref del scroll para conservar la posición al crecer. */
  scrollerRef: React.RefObject<HTMLElement | null>;
  /** ¿Está pidiendo la página anterior? */
  loadingOlder: boolean;
};

export function useListWindow({
  total,
  hasMore,
  onLoadOlder,
  initial = LIST_WINDOW_INITIAL,
  step = LIST_WINDOW_STEP,
  resetKey,
}: UseListWindowOptions): UseListWindowResult {
  const [limit, setLimit] = React.useState(initial);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const topSentinelRef = React.useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = React.useRef<HTMLDivElement | null>(null);
  const scrollerRef = React.useRef<HTMLElement | null>(null);
  const loadingRef = React.useRef(false);

  // Al cambiar de conversación/feed se reinicia la ventana.
  React.useEffect(() => {
    setLimit(initial);
  }, [initial, resetKey]);

  React.useEffect(() => {
    const sentinel = topSentinelRef.current;
    const scroller = scrollerRef.current;
    if (sentinel === null) return;
    const grow = (): void => {
      if (loadingRef.current) return;
      // Sin nada más que pedir y con todo visible, no hay trabajo.
      if (!hasMore && total <= limit) return;
      loadingRef.current = true;
      setLoadingOlder(true);
      const el = scrollerRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      const prevTop = el?.scrollTop ?? 0;
      const done = (): void => {
        setLimit((prev) => prev + step);
        requestAnimationFrame(() => {
          const next = scrollerRef.current;
          if (next !== null && scroller !== null) {
            next.scrollTop = prevTop + (next.scrollHeight - prevHeight);
          }
          setLoadingOlder(false);
          loadingRef.current = false;
        });
      };
      if (hasMore && onLoadOlder !== undefined) {
        void Promise.resolve(onLoadOlder()).then(done, done);
      } else {
        done();
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry === undefined || !entry.isIntersecting) return;
        grow();
      },
      { root: scroller, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadOlder, total, limit, step]);

  // Centinela inferior (feed descendente): solo agranda la ventana, sin
  // pedir página al servidor. Sin scroll interno (`root` null) usa el
  // viewport de la página.
  React.useEffect(() => {
    const sentinel = bottomSentinelRef.current;
    if (sentinel === null) return;
    if (total <= limit) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry === undefined || !entry.isIntersecting) return;
        setLimit((prev) => (total <= prev ? prev : prev + step));
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [total, limit, step]);

  return { limit, topSentinelRef, bottomSentinelRef, scrollerRef, loadingOlder };
}
