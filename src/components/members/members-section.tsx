"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDivider } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
/** Diálogo de invitación por code splitting: solo se descarga al invitar. */
const InviteDialog = dynamic(
  () => import("@/components/members/invite-dialog").then((mod) => mod.InviteDialog),
  { ssr: false },
);
import {
  formatLastSeen,
  AvatarWithPresence,
} from "@/components/presence/presence-dot";
import { useMembers } from "@/hooks/use-chat";
import { usePresence, type PresenceMemberState } from "@/hooks/use-presence";
import {
  useDeleteInvite,
  useInvites,
  useRemoveMember,
  useRevokeInvite,
  useSetMemberRole,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";

const ROLE_LABELS = {
  owner: "Propietario",
  admin: "Administrador",
  member: "Miembro",
} as const;

/**
 * Línea de presencia bajo el rol: estado personalizado (emoji + texto)
 * y "En línea" o "Última vez hace…". Sin dato no pinta nada.
 */
function MemberPresence({ state }: { state: PresenceMemberState | null }): React.JSX.Element | null {
  if (state === null) return null;
  const status =
    state.statusEmoji !== "" || state.statusText !== ""
      ? `${state.statusEmoji} ${state.statusText}`.trim()
      : null;
  const lastSeen = state.online ? "En línea" : formatLastSeen(state.lastSeen);
  if (status === null && lastSeen === null) return null;
  return (
    <span className="block truncate text-meta leading-5 text-muted-foreground">
      {[status, lastSeen === "En línea" ? "En línea" : lastSeen === null ? null : `Última vez ${lastSeen}`]
        .filter((part) => part !== null)
        .join(" · ")}
    </span>
  );
}

/** Miembros del espacio: invitar (admins), roles y expulsión (owner). */
export function MembersSection(): React.JSX.Element | null {
  const user = useSessionStore((state) => state.user);
  const { currentWorkspaceId } = useWorkspaces();
  const membersQuery = useMembers(currentWorkspaceId);
  const invitesQuery = useInvites(currentWorkspaceId);
  const { onlineIds, states } = usePresence(currentWorkspaceId, user?.uid ?? null);
  const setRole = useSetMemberRole();
  const removeMember = useRemoveMember();
  const revokeInvite = useRevokeInvite();
  const deleteInvite = useDeleteInvite();

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmExpel, setConfirmExpel] = React.useState<string | null>(null);

  const members = membersQuery.data ?? [];
  const invites = (invitesQuery.data ?? []).filter((invite) => invite.revokedAt === null);
  const myRole = members.find((member) => member.uid === user?.uid)?.role ?? null;
  const canInvite = myRole === "owner" || myRole === "admin";
  const canManage = myRole === "owner";

  if (currentWorkspaceId === null) return null;

  async function handleRole(uid: string, role: "member" | "admin"): Promise<void> {
    if (currentWorkspaceId === null) return;
    setError(null);
    try {
      await setRole.mutateAsync({ wsId: currentWorkspaceId, uid, role });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el rol.");
    }
  }

  async function handleExpel(uid: string): Promise<void> {
    if (currentWorkspaceId === null) return;
    if (confirmExpel !== uid) {
      setConfirmExpel(uid);
      return;
    }
    setConfirmExpel(null);
    setError(null);
    try {
      await removeMember.mutateAsync({ wsId: currentWorkspaceId, uid });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo expulsar al miembro.");
    }
  }

  return (
    <section aria-label="Miembros">
      <div className="flex items-center justify-between">
        <SectionLabel>Miembros</SectionLabel>
        {canInvite ? (
          <Button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="mb-2 h-9 px-4 text-body-sm"
          >
            <Icon icon={UserPlus} size={20} />
            Invitar
          </Button>
        ) : null}
      </div>
      <Card>
        {membersQuery.isPending && members.length === 0 ? (
          <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
            Cargando miembros…
          </p>
        ) : (
          members.map((member, index) => {
            const isSelf = member.uid === user?.uid;
            return (
              <React.Fragment key={member.uid}>
                {index > 0 ? <CardDivider /> : null}
                <div className="flex items-center gap-3 px-4 py-3">
                  <AvatarWithPresence
                    initial={member.displayName.charAt(0).toUpperCase()}
                    color={member.avatarColor}
                    size={40}
                    online={onlineIds.has(member.uid)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium leading-6 text-foreground">
                      {member.displayName}
                      {isSelf ? " (tú)" : ""}
                    </span>
                    <span className="block text-meta leading-5 text-muted-foreground">
                      {ROLE_LABELS[member.role] ?? member.role}
                    </span>
                    <MemberPresence state={states.get(member.uid) ?? null} />
                  </span>
                  {canManage && !isSelf && member.role !== "owner" ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <select
                        aria-label={`Rol de ${member.displayName}`}
                        value={member.role === "admin" ? "admin" : "member"}
                        onChange={(formEvent) =>
                          void handleRole(
                            member.uid,
                            formEvent.target.value as "member" | "admin",
                          )
                        }
                        disabled={setRole.isPending}
                        className="h-9 rounded-sm bg-background px-2 text-body-sm text-foreground outline-none dark:bg-surface-2"
                      >
                        <option value="member">Miembro</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button
                        type="button"
                        aria-label={
                          confirmExpel === member.uid
                            ? `Confirma expulsar a ${member.displayName}`
                            : `Expulsar a ${member.displayName}`
                        }
                        onClick={() => void handleExpel(member.uid)}
                        disabled={removeMember.isPending}
                        className="rounded-full px-2 py-1 text-body-sm font-medium text-danger outline-none interactive disabled:opacity-60"
                      >
                        {confirmExpel === member.uid ? "¿Confirmar?" : "Expulsar"}
                      </button>
                    </span>
                  ) : null}
                </div>
              </React.Fragment>
            );
          })
        )}
      </Card>

      {canInvite && invites.length > 0 ? (
        <div className="mt-4">
          <SectionLabel>Invitaciones activas</SectionLabel>
          <Card>
            {invites.map((invite, index) => (
              <React.Fragment key={invite.id}>
                {index > 0 ? <CardDivider /> : null}
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="rounded-sm bg-background px-2 py-1 font-mono text-body-sm font-semibold tracking-[0.2em] text-foreground dark:bg-surface-2">
                    {invite.code}
                  </span>
                  <span className="min-w-0 flex-1 text-meta leading-5 text-muted-foreground">
                    {invite.role === "admin" ? "Administrador" : "Miembro"} · {invite.uses} usos
                    {invite.expiresAt !== null
                      ? ` · hasta ${invite.expiresAt.toDate().toLocaleDateString("es")}`
                      : " · sin caducidad"}
                  </span>
                  <button
                    type="button"
                    aria-label={`Revocar invitación ${invite.code}`}
                    onClick={() => {
                      setError(null);
                      revokeInvite.mutate(invite.id, {
                        onError: (err) => setError(err.message),
                      });
                    }}
                    className="shrink-0 rounded-full px-2 py-1 text-body-sm font-medium text-danger outline-none interactive"
                  >
                    Revocar
                  </button>
                  <button
                    type="button"
                    aria-label={`Eliminar invitación ${invite.code}`}
                    onClick={() => {
                      setError(null);
                      deleteInvite.mutate(invite.id, {
                        onError: (err) => setError(err.message),
                      });
                    }}
                    className="shrink-0 rounded-full px-2 py-1 text-body-sm font-medium text-muted-foreground outline-none interactive"
                  >
                    Borrar
                  </button>
                </div>
              </React.Fragment>
            ))}
          </Card>
        </div>
      ) : null}

      {error !== null ? (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      ) : null}
      <p className="mt-3 px-2 text-meta leading-5 text-muted-foreground">
        Solo los administradores invitan; solo el propietario cambia roles o expulsa.
      </p>

      {inviteOpen ? (
        <InviteDialog
          open={inviteOpen}
          wsId={currentWorkspaceId}
          onClose={() => setInviteOpen(false)}
        />
      ) : null}
    </section>
  );
}
