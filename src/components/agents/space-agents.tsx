"use client";

import * as React from "react";
import { Bot } from "lucide-react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { Toggle } from "@/components/ui/toggle";
import { useAgentMutations, useSpaceAgents } from "@/hooks/use-agents";
import { cn } from "@/lib/utils";

function whoCanUse(callers: string): string {
  if (callers === "space_members") return "Lo puede usar cualquier miembro";
  if (callers === "listed") return "Lo pueden usar solo elegidos";
  return "Lo puede usar solo su dueño";
}

/**
 * "Agentes en este espacio": de quién es cada uno y quién puede usarlo.
 * Los admins pueden desactivar (gobernanza) sin ver secretos ni
 * reconfigurar: eso solo lo hace el dueño en "Mis agentes".
 */
export function SpaceAgents(props: {
  workspaceId: string | null;
  uid: string | null;
  isSpaceAdmin: boolean;
  memberNames: Map<string, string>;
}): React.JSX.Element {
  const { workspaceId, uid, isSpaceAdmin, memberNames } = props;
  const query = useSpaceAgents(workspaceId);
  const mutations = useAgentMutations(uid);
  const items = query.data ?? [];

  return (
    <section aria-label="Agentes en este espacio">
      <SectionLabel>Agentes en este espacio</SectionLabel>
      <Card>
        {query.isPending ? (
          <CardRow minHeight="12">
            <span className="text-body-sm text-muted-foreground">Cargando agentes…</span>
          </CardRow>
        ) : query.error !== null ? (
          <CardRow minHeight="12">
            <span role="alert" className="text-body-sm text-danger">
              No se pudieron cargar los agentes.
            </span>
          </CardRow>
        ) : items.length === 0 ? (
          <CardRow minHeight="14">
            <span className="min-w-0 flex-1">
              <span className="block text-body text-foreground">Sin agentes todavía</span>
              <span className="block text-body-sm text-muted-foreground">
                Cuando un miembro habilite su agente aquí, aparecerá en esta lista.
              </span>
            </span>
          </CardRow>
        ) : (
          items.map((item, index) => {
            const ownerName = item.ownerId === uid
              ? "ti"
              : (memberNames.get(item.ownerId) ?? "un miembro");
            const blocked = item.grant.adminDisabled || !item.grant.enabled;
            return (
              <React.Fragment key={item.grant.id}>
                {index > 0 ? <CardDivider /> : null}
                <CardRow>
                  <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-soft text-xl">
                    {item.connection.avatarEmoji !== "" ? item.connection.avatarEmoji : <Icon icon={Bot} size={20} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-foreground">
                      {item.connection.name}{" "}
                      <span className="text-mention">@{item.connection.handle}</span>
                    </span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      De {ownerName} · {whoCanUse(item.grant.allowedCallers)}
                      {blocked ? " · Desactivado" : null}
                    </span>
                  </span>
                  {isSpaceAdmin ? (
                    <Toggle
                      checked={!item.grant.adminDisabled}
                      onCheckedChange={(checked) => {
                        void mutations.setAdminDisabled(item.grant.id, !checked).catch(() => undefined);
                      }}
                      label={`Agente ${item.connection.handle} habilitado en el espacio`}
                    />
                  ) : (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-1 text-meta leading-4",
                        blocked ? "bg-surface text-muted-foreground" : "bg-success/15 text-success",
                      )}
                    >
                      {blocked ? "Apagado" : "Activo"}
                    </span>
                  )}
                </CardRow>
              </React.Fragment>
            );
          })
        )}
        {mutations.error !== null ? (
          <>
            <CardDivider />
            <CardRow minHeight="12">
              <span role="alert" className="text-body-sm leading-5 text-danger">
                {mutations.error}
              </span>
            </CardRow>
          </>
        ) : null}
      </Card>
    </section>
  );
}
