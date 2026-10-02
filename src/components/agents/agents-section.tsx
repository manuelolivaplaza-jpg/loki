"use client";

import * as React from "react";
import { Bot, Check, ChevronDown, Copy, Plus, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { Toggle } from "@/components/ui/toggle";
import {
  useAgentGrants,
  useAgentMutations,
  useAgentsConfigured,
  useMyAgents,
} from "@/hooks/use-agents";
import { handleShapeError, normalizeHandle } from "@/lib/agents/handle";
import type {
  AgentAllowedCallers,
  AgentConnection,
  AgentSpaceGrant,
} from "@/types/agents";
import { AgentConnectDialog, PermissionsForm, type ConnectSpace } from "@/components/agents/agent-connect-dialog";
import { AgentPingStatus } from "@/components/agents/agent-ping-status";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<AgentConnection["status"], string> = {
  active: "Activo",
  paused: "Pausado",
  error: "Error",
};

async function copyText(value: string): Promise<boolean> {
  if (value === "" || typeof navigator === "undefined" || navigator.clipboard === undefined) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Configuración → "Mis agentes": conectar, lista con estado/espacios/último
 * uso, pausar, editar y borrar; token entrante (una sola vez) y "Probar
 * conexión" con estado visible. Explica qué datos ve el agente y que es
 * responsabilidad de su dueño.
 */
export function AgentsSection(props: {
  uid: string | null;
  spaces: ConnectSpace[];
  defaultSpaceId: string | null;
}): React.JSX.Element {
  const { uid, spaces, defaultSpaceId } = props;
  const configured = useAgentsConfigured();
  const agents = useMyAgents(uid);
  const mutations = useAgentMutations(uid);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const items = agents.data ?? [];

  return (
    <section aria-label="Mis agentes">
      <SectionLabel>Mis agentes</SectionLabel>
      <Card>
        <CardRow>
          <span className="min-w-0 flex-1">
            <span className="block text-body leading-6 text-foreground">
              {agents.isPending
                ? "Cargando…"
                : items.length === 0
                  ? "Sin agentes conectados"
                  : `${items.length} agente(s)`}
            </span>
            <span className="block text-body-sm leading-5 text-muted-foreground">
              Tu bot personal dentro del chat, con @mención (llega con el prompt 13)
            </span>
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-meta leading-4",
              configured.data === true
                ? "bg-success/15 text-success"
                : "bg-surface text-muted-foreground",
            )}
          >
            {configured.isPending
              ? "Comprobando…"
              : configured.data === true
                ? "Disponible"
                : "Sin configurar"}
          </span>
        </CardRow>
        <CardDivider />
        <CardRow minHeight="12">
          <span className="text-body-sm leading-5 text-muted-foreground">
            Tu agente ve solo lo que le mandas en cada pedido (y el contexto que
            actives). Corre con tu plan del proveedor y es tu responsabilidad.
            Los secretos se guardan cifrados y nunca se vuelven a mostrar.
          </span>
        </CardRow>
        {configured.data === false ? (
          <>
            <CardDivider />
            <CardRow minHeight="12">
              <span className="text-body-sm leading-5 text-muted-foreground">
                Agentes sin configurar en este entorno. Pide al administrador que
                ponga AGENT_TOKEN_KEY.
              </span>
            </CardRow>
          </>
        ) : null}
        {agents.error !== null ? (
          <>
            <CardDivider />
            <CardRow minHeight="12">
              <span role="alert" className="text-body-sm leading-5 text-danger">
                No se pudieron cargar tus agentes.
              </span>
            </CardRow>
          </>
        ) : null}
        {items.map((agent) => (
          <React.Fragment key={agent.id}>
            <CardDivider />
            <AgentRow
              agent={agent}
              uid={uid}
              spaces={spaces}
              expanded={expanded === agent.id}
              onToggle={() => setExpanded((prev) => (prev === agent.id ? null : agent.id))}
            />
          </React.Fragment>
        ))}
        <CardDivider />
        <div className="p-3">
          <Button
            type="button"
            disabled={uid === null || configured.data === false}
            onClick={() => setDialogOpen(true)}
            className="w-full"
          >
            <Icon icon={Plus} size={18} />
            Conectar agente
          </Button>
        </div>
      </Card>
      {mutations.error !== null ? (
        <p role="alert" className="mt-2 text-body-sm leading-5 text-danger">
          {mutations.error}
        </p>
      ) : null}
      <AgentConnectDialog
        open={dialogOpen}
        uid={uid}
        spaces={spaces}
        defaultSpaceId={defaultSpaceId}
        onClose={() => setDialogOpen(false)}
      />
    </section>
  );
}

function AgentRow(props: {
  agent: AgentConnection;
  uid: string | null;
  spaces: ConnectSpace[];
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { agent, uid, spaces, expanded, onToggle } = props;
  const mutations = useAgentMutations(uid);
  const grants = useAgentGrants(expanded ? agent.id : null);
  const spaceNames = (grants.data ?? [])
    .map((grant) => spaces.find((space) => space.id === grant.workspaceId)?.name)
    .filter((name): name is string => typeof name === "string");
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  async function handlePause(next: boolean): Promise<void> {
    setConfirmingDelete(false);
    try {
      await mutations.setStatus(agent.id, next ? "active" : "paused");
    } catch {
      // El error queda en mutations.error.
    }
  }

  async function handleDelete(): Promise<void> {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    try {
      await mutations.remove(agent.id);
    } catch {
      setConfirmingDelete(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`Agente ${agent.name}`}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-none interactive"
      >
        <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-soft text-xl">
          {agent.avatarEmoji !== "" ? agent.avatarEmoji : <Icon icon={Bot} size={20} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-foreground">
            {agent.name} <span className="text-mention">@{agent.handle}</span>
          </span>
          <span className="block truncate text-body-sm text-muted-foreground">
            {spaceNames.length > 0 ? spaceNames.join(", ") : "Sin espacios"} ·{" "}
            {agent.lastUsedAt === null
              ? "Sin uso"
              : `Último uso ${agent.lastUsedAt.toDate().toLocaleDateString("es")}`}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-meta leading-4",
            agent.status === "active"
              ? "bg-success/15 text-success"
              : agent.status === "paused"
                ? "bg-surface text-muted-foreground"
                : "bg-danger/15 text-danger",
          )}
        >
          {STATUS_LABEL[agent.status]}
        </span>
        <Icon
          icon={ChevronDown}
          size={18}
          className={cn("shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
        />
      </button>
      {agent.status === "error" && agent.lastError !== null ? (
        <p role="alert" className="px-4 pb-2 text-body-sm leading-5 text-danger">
          {agent.lastError}
        </p>
      ) : null}
      {expanded ? (
        <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
          <AgentBasics agent={agent} uid={uid} />
          <AgentOutbound agent={agent} uid={uid} />
          <AgentInbound agent={agent} uid={uid} />
          <AgentGrantEditor agent={agent} uid={uid} spaces={spaces} grants={grants.data ?? []} />
          <AgentPing agent={agent} uid={uid} spaces={spaces} />
          <div className="flex items-center justify-between gap-3">
            <span className="text-body text-foreground">Activo</span>
            <Toggle
              checked={agent.status === "active"}
              onCheckedChange={(checked) => void handlePause(checked)}
              label={`Agente ${agent.handle} activo`}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={mutations.saving}
            onClick={() => void handleDelete()}
            className="w-full text-danger"
          >
            {confirmingDelete ? "Toca de nuevo para borrar" : "Borrar agente"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AgentBasics(props: { agent: AgentConnection; uid: string | null }): React.JSX.Element {
  const { agent, uid } = props;
  const mutations = useAgentMutations(uid);
  const [name, setName] = React.useState(agent.name);
  const [handle, setHandle] = React.useState(agent.handle);
  const [description, setDescription] = React.useState(agent.description);
  const shapeError = handleShapeError(handle);
  const dirty = name.trim() !== agent.name || normalizeHandle(handle) !== agent.handle ||
    description.trim() !== (agent.description ?? "");

  async function handleSave(): Promise<void> {
    if (shapeError !== null || name.trim() === "") return;
    try {
      await mutations.update(agent.id, {
        name: name.trim(),
        handle: normalizeHandle(handle),
        description: description.trim(),
      });
    } catch {
      // El error queda en mutations.error.
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-muted-foreground">Nombre</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          className="h-11 w-full rounded-sm bg-surface-soft px-3 text-body text-foreground outline-none"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-muted-foreground">Handle</span>
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          maxLength={32}
          autoCapitalize="none"
          spellCheck={false}
          className="h-11 w-full rounded-sm bg-surface-soft px-3 text-body text-foreground outline-none"
        />
      </label>
      {shapeError !== null ? (
        <p className="text-body-sm text-danger">{shapeError}</p>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-muted-foreground">Descripción</span>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={280}
          className="h-11 w-full rounded-sm bg-surface-soft px-3 text-body text-foreground outline-none"
        />
      </label>
      <Button type="button" variant="secondary" disabled={!dirty || shapeError !== null || mutations.saving} onClick={() => void handleSave()} className="w-full">
        {mutations.saving ? "Guardando…" : "Guardar datos"}
      </Button>
    </div>
  );
}

function AgentOutbound(props: { agent: AgentConnection; uid: string | null }): React.JSX.Element {
  const { agent, uid } = props;
  const mutations = useAgentMutations(uid);
  const [url, setUrl] = React.useState(agent.dispatchUrl);
  const [secret, setSecret] = React.useState("");

  async function handleSave(): Promise<void> {
    try {
      await mutations.setOutbound(agent.id, {
        dispatchUrl: url.trim(),
        outboundSecret: secret,
      });
      setSecret("");
    } catch {
      // El error queda en mutations.error.
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-body font-medium text-foreground">Conexión saliente</p>
      <p className="text-body-sm text-muted-foreground">
        {agent.dispatchUrl !== ""
          ? `URL: ${agent.dispatchUrl}`
          : "Sin URL de disparo."}{" "}
        {agent.hasOutbound ? "Con secreto guardado." : "Sin secreto guardado."}
      </p>
      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://…"
        autoCapitalize="none"
        spellCheck={false}
        inputMode="url"
        aria-label="URL de disparo"
        className="h-11 w-full rounded-sm bg-surface-soft px-3 text-body text-foreground outline-none"
      />
      <input
        type="password"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        placeholder="Nuevo secreto (se cifra, no se muestra)"
        autoComplete="new-password"
        aria-label="Nuevo secreto saliente"
        className="h-11 w-full rounded-sm bg-surface-soft px-3 text-body text-foreground outline-none"
      />
      <Button type="button" variant="secondary" disabled={mutations.saving} onClick={() => void handleSave()} className="w-full">
        Guardar conexión
      </Button>
    </div>
  );
}

function AgentInbound(props: { agent: AgentConnection; uid: string | null }): React.JSX.Element {
  const { agent, uid } = props;
  const mutations = useAgentMutations(uid);
  const [token, setToken] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function handleRotate(): Promise<void> {
    try {
      const fresh = await mutations.rotateInbound(agent.id);
      setToken(fresh);
      setCopied(false);
    } catch {
      // El error queda en mutations.error.
    }
  }

  async function handleCopy(): Promise<void> {
    if (token === null) return;
    if (await copyText(token)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  async function handleShare(): Promise<void> {
    if (token === null) return;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Token de agente Loki", text: `Token de @${agent.handle} (una sola vez)` });
        return;
      } catch {
        return;
      }
    }
    await handleCopy();
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-body font-medium text-foreground">Token entrante</p>
      <p className="text-body-sm text-muted-foreground">
        {agent.hasInbound
          ? "Hay un token vigente (nunca se muestra). Regenerarlo invalida el anterior."
          : "Sin token vigente."}
      </p>
      {token !== null ? (
        <>
          <p aria-label="Token nuevo (se muestra una sola vez)" className="break-all rounded-sm bg-surface-soft p-3 font-mono text-body-sm text-foreground select-all">
            {token}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => void handleCopy()} className="min-h-11 flex-1">
              <Icon icon={copied ? Check : Copy} size={18} />
              {copied ? "¡Copiado!" : "Copiar"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => void handleShare()} className="min-h-11 flex-1">
              <Icon icon={Share2} size={18} />
              Compartir
            </Button>
          </div>
        </>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="secondary" disabled={mutations.saving} onClick={() => void handleRotate()} className="min-h-11 flex-1">
          {agent.hasInbound ? "Regenerar token" : "Generar token"}
        </Button>
        {agent.hasInbound ? (
          <Button
            type="button"
            variant="secondary"
            disabled={mutations.saving}
            onClick={() => void mutations.revokeInbound(agent.id).then(() => setToken(null)).catch(() => undefined)}
            className="min-h-11 flex-1"
          >
            Revocar
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AgentGrantEditor(props: {
  agent: AgentConnection;
  uid: string | null;
  spaces: ConnectSpace[];
  grants: AgentSpaceGrant[];
}): React.JSX.Element {
  const { agent, uid, spaces, grants } = props;
  const mutations = useAgentMutations(uid);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const missing = spaces.filter((space) => !grants.some((grant) => grant.workspaceId === space.id));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-body font-medium text-foreground">Espacios y permisos</p>
      {grants.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">Sin espacios habilitados.</p>
      ) : (
        grants.map((grant) => {
          const space = spaces.find((entry) => entry.id === grant.workspaceId);
          return (
            <div key={grant.id} className="flex flex-col gap-2 rounded-sm bg-surface-soft p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-body text-foreground">
                  {space !== undefined ? `${space.emoji} ${space.name}` : "Espacio"}
                  {grant.adminDisabled ? " (desactivado por un admin)" : null}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <Toggle
                    checked={grant.enabled}
                    onCheckedChange={(checked) => {
                      void mutations.updateGrant(grant.id, { enabled: checked }).catch(() => undefined);
                    }}
                    label={`Agente habilitado en ${space?.name ?? "el espacio"}`}
                  />
                  <button
                    type="button"
                    onClick={() => setEditing((prev) => (prev === grant.id ? null : grant.id))}
                    className="rounded-sm px-2 py-1 text-body-sm text-mention outline-none interactive"
                  >
                    {editing === grant.id ? "Cerrar" : "Permisos"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void mutations.removeGrant(grant.id).catch(() => undefined)}
                    className="rounded-sm px-2 py-1 text-body-sm text-danger outline-none interactive"
                    aria-label={`Quitar de ${space?.name ?? "el espacio"}`}
                  >
                    Quitar
                  </button>
                </div>
              </div>
              {editing === grant.id ? (
                <GrantPermissions grant={grant} uid={uid} />
              ) : null}
            </div>
          );
        })
      )}
      {missing.length > 0 ? (
        adding ? (
          <div className="flex flex-col gap-1.5">
            {missing.map((space) => (
              <button
                key={space.id}
                type="button"
                disabled={mutations.saving}
                onClick={() => {
                  void mutations
                    .addGrant({ connectionId: agent.id, workspaceId: space.id })
                    .then(() => setAdding(false))
                    .catch(() => undefined);
                }}
                className="flex min-h-11 items-center gap-2 rounded-sm bg-surface-soft px-3 text-left text-body text-foreground outline-none interactive"
              >
                <span aria-hidden="true">{space.emoji}</span> {space.name}
              </button>
            ))}
            <Button type="button" variant="secondary" onClick={() => setAdding(false)} className="w-full">
              Cancelar
            </Button>
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setAdding(true)} className="w-full">
            <Icon icon={Plus} size={18} />
            Habilitar en otro espacio
          </Button>
        )
      ) : null}
    </div>
  );
}

function GrantPermissions(props: { grant: AgentSpaceGrant; uid: string | null }): React.JSX.Element {
  const { grant, uid } = props;
  const mutations = useAgentMutations(uid);
  const [callers, setCallers] = React.useState<AgentAllowedCallers>(grant.allowedCallers);
  const [allowContext, setAllowContext] = React.useState(grant.allowContext);
  const [contextMessages, setContextMessages] = React.useState(grant.contextMessages);
  const [allowPublish, setAllowPublish] = React.useState(grant.allowPublish);
  const [allowPropose, setAllowPropose] = React.useState(grant.allowProposeActions);
  const [dailyLimit, setDailyLimit] = React.useState(grant.dailyLimit);

  async function handleSave(): Promise<void> {
    try {
      await mutations.updateGrant(grant.id, {
        allowedCallers: callers,
        allowContext,
        contextMessages,
        allowPublish,
        allowProposeActions: allowPropose,
        dailyLimit,
      });
    } catch {
      // El error queda en mutations.error.
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      <PermissionsForm
        callers={callers}
        onCallers={setCallers}
        allowContext={allowContext}
        onAllowContext={setAllowContext}
        contextMessages={contextMessages}
        onContextMessages={setContextMessages}
        allowPublish={allowPublish}
        onAllowPublish={setAllowPublish}
        allowPropose={allowPropose}
        onAllowPropose={setAllowPropose}
      />
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-muted-foreground">
          Tope diario en este espacio: {dailyLimit}
        </span>
        <input
          type="range"
          min={1}
          max={100}
          value={Math.min(100, dailyLimit)}
          onChange={(event) => setDailyLimit(Number(event.target.value))}
          className="w-full"
          aria-label="Tope diario en este espacio"
        />
      </label>
      <Button type="button" variant="secondary" disabled={mutations.saving} onClick={() => void handleSave()} className="w-full">
        Guardar permisos
      </Button>
    </div>
  );
}

function AgentPing(props: {
  agent: AgentConnection;
  uid: string | null;
  spaces: ConnectSpace[];
}): React.JSX.Element {
  const { agent, uid, spaces } = props;
  const mutations = useAgentMutations(uid);
  const grantsQuery = useAgentGrants(agent.id);
  const [spaceId, setSpaceId] = React.useState<string>("");
  const [runId, setRunId] = React.useState<string | null>(null);
  const grantSpaces = (grantsQuery.data ?? [])
    .map((grant) => spaces.find((space) => space.id === grant.workspaceId))
    .filter((space): space is ConnectSpace => space !== undefined);
  const options = grantSpaces.length > 0 ? grantSpaces : spaces;

  async function handlePing(): Promise<void> {
    const wsId = spaceId !== "" ? spaceId : (options[0]?.id ?? "");
    if (wsId === "") return;
    try {
      const run = await mutations.ping({ connectionId: agent.id, workspaceId: wsId });
      setRunId(run.id);
    } catch {
      // El error queda en mutations.error.
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-body font-medium text-foreground">Probar conexión</p>
      {options.length > 1 ? (
        <label className="flex flex-col gap-1">
          <span className="text-meta font-medium text-muted-foreground">Espacio de la prueba</span>
          <select
            value={spaceId !== "" ? spaceId : (options[0]?.id ?? "")}
            onChange={(event) => setSpaceId(event.target.value)}
            className="h-11 w-full rounded-sm bg-surface-soft px-3 text-body text-foreground outline-none"
          >
            {options.map((space) => (
              <option key={space.id} value={space.id}>
                {space.emoji} {space.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {runId === null ? (
        <Button type="button" variant="secondary" disabled={mutations.saving || options.length === 0} onClick={() => void handlePing()} className="w-full">
          {mutations.saving ? "Enviando…" : "Probar conexión"}
        </Button>
      ) : (
        <AgentPingStatus runId={runId} uid={uid} />
      )}
      {runId !== null ? (
        <Button type="button" variant="secondary" onClick={() => void handlePing()} className="w-full">
          Probar de nuevo
        </Button>
      ) : null}
    </div>
  );
}
