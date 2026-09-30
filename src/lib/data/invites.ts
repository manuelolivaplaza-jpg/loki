"use client";

/**
 * Invitaciones y administración de miembros sobre Supabase.
 *
 * Crear/revocar invitaciones es de admins (`is_space_admin`); cambiar roles y
 * expulsar es del propietario (RLS de `workspace_members`). Unirse va por la
 * RPC segura `accept_invite(code)`, que devuelve espacio y nombre.
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/supabase";
import type { InviteItem } from "@/types/organizer";

type InviteRow = Database["public"]["Tables"]["invites"]["Row"];

function toTimestampOrNull(iso: string | null): Timestamp | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function toInvite(row: InviteRow): InviteItem {
  return {
    id: row.id,
    code: row.code,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    role: row.role as InviteItem["role"],
    expiresAt: toTimestampOrNull(row.expires_at),
    maxUses: row.max_uses,
    uses: row.uses,
    revokedAt: toTimestampOrNull(row.revoked_at),
    createdAt: Timestamp.fromDate(new Date(row.created_at)),
  };
}

function inviteErrorMessage(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) return fallback;
  const code = (error as { code?: unknown }).code;
  if (code === "42501") return "Solo los administradores pueden hacer eso.";
  const message = String((error as { message?: unknown }).message ?? "");
  if (/no existe/i.test(message)) return "Ese código no existe. Revisa que esté bien escrito.";
  if (/caduc/i.test(message)) return "Esa invitación caducó.";
  if (/revoc/i.test(message)) return "Esa invitación fue revocada.";
  if (/usó todas/i.test(message)) return "Esa invitación ya se usó todas las veces.";
  return fallback;
}

const INVITE_COLUMNS =
  "id, code, workspace_id, created_by, role, expires_at, max_uses, uses, revoked_at, created_at";

export async function listInvites(wsId: string): Promise<InviteItem[]> {
  const { data, error } = await getSupabaseClient()
    .from("invites")
    .select(INVITE_COLUMNS)
    .eq("workspace_id", wsId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error !== null) {
    throw new Error("No se pudieron cargar las invitaciones.");
  }
  return ((data ?? []) as InviteRow[]).map(toInvite);
}

export async function createInvite(
  wsId: string,
  uid: string,
  input: { role?: InviteItem["role"]; maxUses?: number | null },
): Promise<InviteItem> {
  // Las invitaciones no caducan: entran cuando quieran con ese rol.
  const { data, error } = await getSupabaseClient()
    .from("invites")
    .insert({
      workspace_id: wsId,
      created_by: uid,
      role: input.role ?? "member",
      expires_at: null,
      max_uses: input.maxUses ?? null,
    })
    .select(INVITE_COLUMNS)
    .single();
  if (error !== null) {
    throw new Error(inviteErrorMessage(error, "No se pudo crear la invitación."));
  }
  return toInvite(data as InviteRow);
}

export async function revokeInvite(id: string): Promise<void> {
  // Sin permiso la RLS devuelve 0 filas sin error: se comprueba.
  const { data, error } = await getSupabaseClient()
    .from("invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error !== null) {
    throw new Error(inviteErrorMessage(error, "No se pudo revocar la invitación."));
  }
  if ((data ?? []).length === 0) {
    throw new Error("Solo los administradores pueden hacer eso.");
  }
}

export async function deleteInvite(id: string): Promise<void> {
  const { data, error } = await getSupabaseClient()
    .from("invites")
    .delete()
    .eq("id", id)
    .select("id");
  if (error !== null) {
    throw new Error(inviteErrorMessage(error, "No se pudo eliminar la invitación."));
  }
  if ((data ?? []).length === 0) {
    throw new Error("Solo los administradores pueden hacer eso.");
  }
}

export type AcceptInviteResult = {
  workspaceId: string;
  workspaceName: string;
  joined: boolean;
};

/** Unirse con código (login previo). La RPC valida y devuelve el espacio. */
export async function acceptInvite(code: string): Promise<AcceptInviteResult> {
  const clean = code.trim().toUpperCase();
  if (clean === "") throw new Error("Pega el código de invitación.");
  const { data, error } = await getSupabaseClient().rpc("accept_invite", {
    p_code: clean,
  });
  if (error !== null) {
    throw new Error(inviteErrorMessage(error, "No se pudo unir al espacio."));
  }
  const row = data as { workspace_id?: unknown; workspace_name?: unknown; joined?: unknown } | null;
  if (
    row === null ||
    typeof row.workspace_id !== "string" ||
    typeof row.workspace_name !== "string"
  ) {
    throw new Error("No se pudo unir al espacio.");
  }
  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    joined: row.joined === true,
  };
}

/** Cambiar el rol de un miembro (solo el propietario). */
export async function setMemberRole(
  wsId: string,
  uid: string,
  role: "member" | "admin",
): Promise<void> {
  const { data, error } = await getSupabaseClient()
    .from("workspace_members")
    .update({ role })
    .eq("workspace_id", wsId)
    .eq("user_id", uid)
    .select("user_id");
  if (error !== null) {
    throw new Error(inviteErrorMessage(error, "No se pudo cambiar el rol."));
  }
  if ((data ?? []).length === 0) {
    throw new Error("Solo el propietario puede cambiar roles.");
  }
}

/** Expulsar a un miembro del espacio (solo el propietario). */
export async function removeMember(wsId: string, uid: string): Promise<void> {
  const { data, error } = await getSupabaseClient()
    .from("workspace_members")
    .delete()
    .eq("workspace_id", wsId)
    .eq("user_id", uid)
    .select("user_id");
  if (error !== null) {
    throw new Error(inviteErrorMessage(error, "No se pudo expulsar al miembro."));
  }
  if ((data ?? []).length === 0) {
    throw new Error("Solo el propietario puede expulsar.");
  }
}
