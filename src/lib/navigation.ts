"use client";

import { usePathname } from "next/navigation";

/**
 * Normaliza un pathname para que las comparaciones exactas funcionen igual
 * en web y en el build Capacitor (trailingSlash: true), donde usePathname()
 * puede devolver "/chat/", "/chat/c/", "/inicio/", etc.
 * Quita las barras finales salvo en la raíz "/".
 */
export function normalizePathname(pathname: string | null): string | null {
  if (pathname === null || pathname === undefined) return null;
  if (pathname === "" || pathname === "/") return pathname;
  const normalized = pathname.replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

/**
 * Envuelve usePathname() de next/navigation y devuelve la ruta normalizada
 * (sin barra final, salvo "/"). Usar en lugar de usePathname() en todo src/.
 */
export function useAppPathname(): string | null {
  return normalizePathname(usePathname());
}

/**
 * Comparación de links activos tolerante a la barra final:
 * "/inicio" e "/inicio/" activan el item con href "/inicio".
 */
export function isActiveHref(
  pathname: string | null,
  href: string,
): boolean {
  const current = normalizePathname(pathname);
  const target = normalizePathname(href);
  if (current === null || target === null) return false;
  return current === target || current.startsWith(`${target}/`);
}
