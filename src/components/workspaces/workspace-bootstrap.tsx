"use client";

import { useWorkspaces } from "@/stores/workspace-store";

/**
 * Carga única de los espacios del usuario para todo el shell.
 * Se monta una sola vez en `AppShell`: los selectores (sidebar, headers,
 * perfil) leen el mismo store en caché en vez de disparar cada uno su carga.
 */
export function WorkspaceBootstrap(): null {
  useWorkspaces();
  return null;
}
