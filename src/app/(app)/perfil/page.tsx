"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { kindLabel } from "@/components/workspaces/workspace-options";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceStore, useWorkspaces } from "@/stores/workspace-store";
import { AVATAR_FALLBACK_COLOR, getAvatarInitial } from "@/types/models";

export default function PerfilPage(): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const { workspaces, currentWorkspace, isLoading } = useWorkspaces();
  const setCurrent = useWorkspaceStore((state) => state.setCurrent);

  const displayName =
    profile?.displayName.trim() !== "" &&
    profile?.displayName !== undefined &&
    profile.displayName !== null
      ? profile.displayName
      : (user?.displayName?.trim() !== "" ? user?.displayName : null) ??
        "Usuario";
  const email = profile?.email ?? user?.email ?? "Sin correo";
  const initial =
    profile?.avatarInitial ??
    getAvatarInitial(user?.displayName ?? null, user?.email ?? null);
  const color = profile?.avatarColor ?? AVATAR_FALLBACK_COLOR;
  // Mientras carga nunca se muestra "Sin espacio": texto de espera sobrio.
  const loadingSpaces = isLoading && workspaces.length === 0;

  async function handleSelectSpace(wsId: string): Promise<void> {
    if (user === null || wsId === currentWorkspace?.wsId) {
      return;
    }
    await setCurrent(user.uid, wsId);
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 md:py-8">
      <SectionLabel>Perfil</SectionLabel>
      <section aria-label="Información de perfil">
        <Card>
          <CardRow minHeight="15" className="py-3">
            <Avatar initial={initial} color={color} size={44} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-semibold leading-6 text-foreground">
                {displayName}
              </span>
              <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                {email}
              </span>
            </span>
            <Icon icon={ChevronRight} size={20} className="text-muted-foreground" />
          </CardRow>
          <CardDivider />
          <CardRow>
            <span className="min-w-0 flex-1 text-body text-foreground">
              Espacio actual
            </span>
            <span className="truncate text-body-sm text-muted-foreground">
              {loadingSpaces
                ? "Cargando…"
                : currentWorkspace !== null
                  ? `${currentWorkspace.emoji} ${currentWorkspace.name}`
                  : "Sin espacio"}
            </span>
            <Icon icon={ChevronRight} size={20} className="text-muted-foreground" />
          </CardRow>
        </Card>
      </section>

      <section aria-label="Espacios" className="mt-6">
        <SectionLabel>Espacios</SectionLabel>
        <Card>
          {loadingSpaces ? (
            <CardRow>
              <span
                aria-hidden="true"
                className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-soft"
              />
              <span className="min-w-0 flex-1">
                <span
                  aria-hidden="true"
                  className="block h-5 w-32 animate-pulse rounded-full bg-surface-soft"
                />
              </span>
            </CardRow>
          ) : workspaces.length === 0 ? (
            <CardRow>
              <span className="min-w-0 flex-1 text-body-sm text-muted-foreground">
                Todavía no tienes espacios.
              </span>
            </CardRow>
          ) : (
            workspaces.map((item, index) => (
              <React.Fragment key={item.wsId}>
                {index > 0 ? <CardDivider /> : null}
                <button
                  type="button"
                  aria-label={`Cambiar a espacio ${item.name}`}
                  aria-current={
                    item.wsId === currentWorkspace?.wsId ? "true" : undefined
                  }
                  onClick={() => void handleSelectSpace(item.wsId)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-lg px-4 py-3 text-left outline-none interactive"
                >
                  <Avatar emoji={item.emoji} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">
                      {item.name}
                    </span>
                    <span className="block truncate text-meta leading-5 text-muted-foreground">
                      {kindLabel(item.kind)}
                    </span>
                  </span>
                  <Icon
                    icon={ChevronRight}
                    size={20}
                    className="shrink-0 text-muted-foreground"
                  />
                </button>
              </React.Fragment>
            ))
          )}
        </Card>
      </section>
    </div>
  );
}
