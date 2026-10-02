"use client";

import * as React from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { handleShapeError, normalizeHandle } from "@/lib/agents/handle";
import { useAgentMutations, useCreateAgent } from "@/hooks/use-agents";
import { AGENT_PROVIDERS, type AgentAllowedCallers, type AgentProvider } from "@/types/agents";
import { AgentPingStatus } from "@/components/agents/agent-ping-status";
import { cn } from "@/lib/utils";

export type ConnectSpace = { id: string; name: string; emoji: string };

const AVATARS = ["🤖", "🦾", "🧠", "✨", "🐙", "🦊", "🐸", "⚡"];

const inputClassName =
  "h-11 w-full rounded-sm bg-surface-soft px-3 text-body text-foreground outline-none placeholder:text-muted-foreground";
const labelClassName = "mb-1 block text-meta font-medium text-muted-foreground";

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
 * Asistente "Conectar agente" (crear): hoja inferior en móvil, diálogo amplio
 * en escritorio (el Dialog ya lo es). Pasos: 1 agente, 2 conexión (URL y
 * secreto), 3 token entrante (se muestra una vez), 4 espacios y permisos,
 * 5 probar. Todos los proveedores están cableados (webhook firmado de
 * referencia + grokbot/hermes/a2a configurables, ver docs/AGENTES.md).
 */
export function AgentConnectDialog(props: {
  open: boolean;
  uid: string | null;
  spaces: ConnectSpace[];
  defaultSpaceId: string | null;
  onClose: () => void;
  onCreated?: () => void;
}): React.JSX.Element {
  const { open, uid, spaces, defaultSpaceId, onClose, onCreated } = props;
  const [step, setStep] = React.useState(1);
  const [provider, setProvider] = React.useState<AgentProvider>("generic_webhook");
  const [name, setName] = React.useState("");
  const [handle, setHandle] = React.useState("");
  const [avatar, setAvatar] = React.useState(AVATARS[0] ?? "🤖");
  const [description, setDescription] = React.useState("");
  const [dispatchUrl, setDispatchUrl] = React.useState("");
  const [outboundSecret, setOutboundSecret] = React.useState("");
  const [connectionId, setConnectionId] = React.useState<string | null>(null);
  const [token, setToken] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [chosenSpaces, setChosenSpaces] = React.useState<string[]>([]);
  const [callers, setCallers] = React.useState<AgentAllowedCallers>("owner_only");
  const [allowContext, setAllowContext] = React.useState(true);
  const [contextMessages, setContextMessages] = React.useState(10);
  const [allowPublish, setAllowPublish] = React.useState(true);
  const [allowPropose, setAllowPropose] = React.useState(true);
  const [pingRunId, setPingRunId] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  const creator = useCreateAgent(uid);
  const mutations = useAgentMutations(uid);
  const busy = creator.creating || mutations.saving;
  const error = formError ?? creator.error ?? mutations.error;

  React.useEffect(() => {
    if (open) {
      setStep(1);
      setConnectionId(null);
      setToken(null);
      setPingRunId(null);
      setFormError(null);
      setCopied(false);
      if (defaultSpaceId !== null) setChosenSpaces([defaultSpaceId]);
    }
  }, [open, defaultSpaceId]);

  const providerInfo = AGENT_PROVIDERS.find((entry) => entry.value === provider);
  const handleError = handleShapeError(handle);
  const canStep1 = name.trim() !== "" && handleError === null;

  async function handleCreate(): Promise<void> {
    setFormError(null);
    if (!canStep1 || uid === null) return;
    try {
      const created = await creator.create({
        provider,
        name: name.trim().slice(0, 60),
        handle: normalizeHandle(handle),
        description: description.trim().slice(0, 280),
        avatarEmoji: avatar,
        workspaceId: chosenSpaces[0] ?? undefined,
        grant: chosenSpaces.length > 0
          ? {
            allowedCallers: callers,
            allowContext,
            contextMessages,
            allowPublish,
            allowProposeActions: allowPropose,
          }
          : undefined,
      });
      setConnectionId(created.id);
      // Grants extra (el primero ya lo creó la Edge).
      for (const wsId of chosenSpaces.slice(1)) {
        try {
          await mutations.addGrant({
            connectionId: created.id,
            workspaceId: wsId,
            allowedCallers: callers,
            allowContext,
            contextMessages,
            allowPublish,
            allowProposeActions: allowPropose,
          });
        } catch {
          // Si un espacio falla, sigue con los demás; se agrega después.
          mutations.clearError();
        }
      }
      onCreated?.();
      setStep(2);
    } catch {
      // El mensaje ya quedó en creator.error.
    }
  }

  async function handleSaveOutbound(next: boolean): Promise<void> {
    setFormError(null);
    if (connectionId === null) return;
    if (dispatchUrl.trim() !== "" && !/^https:\/\//i.test(dispatchUrl.trim())) {
      setFormError("La URL de disparo debe empezar con https://.");
      return;
    }
    try {
      await mutations.setOutbound(connectionId, {
        dispatchUrl: dispatchUrl.trim(),
        outboundSecret,
      });
      setOutboundSecret("");
      if (next) setStep(3);
    } catch {
      // El mensaje ya quedó en mutations.error.
    }
  }

  async function handleRotate(): Promise<void> {
    setFormError(null);
    if (connectionId === null) return;
    try {
      const fresh = await mutations.rotateInbound(connectionId);
      setToken(fresh);
      setCopied(false);
    } catch {
      // El mensaje ya quedó en mutations.error.
    }
  }

  async function handleCopyToken(): Promise<void> {
    if (token === null) return;
    if (await copyText(token)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  async function handleShareToken(): Promise<void> {
    if (token === null) return;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "Token de agente Loki",
          text: `Token entrante de @${normalizeHandle(handle)} (se muestra una sola vez)`,
          url: undefined,
        });
        return;
      } catch {
        return;
      }
    }
    await handleCopyToken();
  }

  async function handlePing(): Promise<void> {
    setFormError(null);
    if (connectionId === null) return;
    const wsId = chosenSpaces[0] ?? defaultSpaceId ?? spaces[0]?.id ?? null;
    if (wsId === null) {
      setFormError("Elige al menos un espacio para probar.");
      return;
    }
    try {
      const run = await mutations.ping({ connectionId, workspaceId: wsId });
      setPingRunId(run.id);
    } catch {
      // El mensaje ya quedó en mutations.error.
    }
  }

  function toggleSpace(wsId: string): void {
    setChosenSpaces((prev) =>
      prev.includes(wsId) ? prev.filter((id) => id !== wsId) : [...prev, wsId]
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label="Conectar agente" className="md:max-w-[520px]">
        <DialogTitle>Conectar agente</DialogTitle>
        <DialogDescription>
          {step === 1 ? "Paso 1 de 5: tu agente y cómo mencionarlo." : null}
          {step === 2 ? "Paso 2 de 5: dónde despertar a tu agente." : null}
          {step === 3 ? "Paso 3 de 5: token entrante (se muestra una vez)." : null}
          {step === 4 ? "Paso 4 de 5: espacios y permisos." : null}
          {step === 5 ? "Paso 5 de 5: probar la conexión." : null}
        </DialogDescription>

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <fieldset>
              <legend className={labelClassName}>Proveedor</legend>
              <div className="flex flex-col gap-2">
                {AGENT_PROVIDERS.map((entry) => (
                  <label
                    key={entry.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-sm border p-3",
                      provider === entry.value ? "border-accent bg-surface-soft" : "border-border",
                      !entry.ready && provider !== entry.value && "opacity-70",
                    )}
                  >
                    <input
                      type="radio"
                      name="agent-provider"
                      value={entry.value}
                      checked={provider === entry.value}
                      onChange={() => setProvider(entry.value)}
                      className="mt-1 h-4 w-4 accent-[#00B4D8]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-medium text-foreground">
                        {entry.label}
                        {!entry.ready ? " (pronto)" : null}
                      </span>
                      <span className="block text-body-sm text-muted-foreground">
                        {entry.detail}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {providerInfo !== undefined && !providerInfo.ready ? (
                <p className="mt-2 text-body-sm text-muted-foreground">
                  Puedes dejarlo registrado con sus permisos; el adaptador se conecta en el prompt 13.
                </p>
              ) : provider === "grokbot" ? (
                <p className="mt-2 text-body-sm text-muted-foreground">
                  La rutina recibe la tarea + callback + token en el cuerpo; sus instrucciones deben
                  mandar el resultado de vuelta al callback (ver docs/AGENTES.md).
                </p>
              ) : provider === "hermes" ? (
                <p className="mt-2 text-body-sm text-muted-foreground">
                  Sin API oficial verificada: usa el webhook genérico (o A2A según su docs).
                </p>
              ) : null}
            </fieldset>
            <div>
              <label htmlFor="agent-name" className={labelClassName}>Nombre visible</label>
              <input
                id="agent-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Mi bot"
                maxLength={60}
                autoComplete="off"
                className={inputClassName}
              />
            </div>
            <div>
              <label htmlFor="agent-handle" className={labelClassName}>Handle (para mencionar)</label>
              <input
                id="agent-handle"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="mi-bot"
                maxLength={32}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className={inputClassName}
              />
              {handle !== "" ? (
                <p className={cn("mt-1 text-body-sm", handleError === null ? "text-muted-foreground" : "text-danger")}>
                  {handleError ?? `Se mencionará como @${normalizeHandle(handle)}`}
                </p>
              ) : null}
            </div>
            <div>
              <span className={labelClassName}>Avatar</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar del agente">
                {AVATARS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    role="radio"
                    aria-checked={avatar === emoji}
                    aria-label={`Avatar ${emoji}`}
                    onClick={() => setAvatar(emoji)}
                    className={cn(
                      "flex h-11 w-11 items-center justify-center rounded-full text-xl outline-none interactive",
                      avatar === emoji ? "bg-surface-soft ring-2 ring-accent" : "bg-surface",
                    )}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor="agent-desc" className={labelClassName}>Descripción (opcional)</label>
              <input
                id="agent-desc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Qué sabe hacer tu agente"
                maxLength={280}
                autoComplete="off"
                className={inputClassName}
              />
            </div>
            <div>
              <span className={labelClassName}>Espacios (puedes sumar más después)</span>
              {spaces.length === 0 ? (
                <p className="text-body-sm text-muted-foreground">Aún no tienes espacios.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {spaces.map((space) => (
                    <label key={space.id} className="flex cursor-pointer items-center gap-3 rounded-sm bg-surface-soft px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={chosenSpaces.includes(space.id)}
                        onChange={() => toggleSpace(space.id)}
                        className="h-5 w-5 accent-[#00B4D8]"
                      />
                      <span aria-hidden="true" className="text-lg">{space.emoji}</span>
                      <span className="min-w-0 flex-1 truncate text-body text-foreground">{space.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            {error !== null ? (
              <p role="alert" className="text-body-sm leading-5 text-danger">{error}</p>
            ) : null}
            <Button type="button" disabled={!canStep1 || busy} onClick={() => void handleCreate()} className="w-full">
              {busy ? "Creando…" : "Crear y seguir"}
            </Button>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-4">
            <p className="text-body-sm leading-5 text-muted-foreground">
              Pega la URL https donde Loki despierta a tu agente y, si tu proveedor
              pide clave, el secreto. Se guarda cifrado y <strong>nunca</strong> se vuelve a mostrar.
            </p>
            <div>
              <label htmlFor="agent-url" className={labelClassName}>URL de disparo (https)</label>
              <input
                id="agent-url"
                value={dispatchUrl}
                onChange={(event) => setDispatchUrl(event.target.value)}
                placeholder="https://…"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                className={inputClassName}
              />
            </div>
            <div>
              <label htmlFor="agent-secret" className={labelClassName}>Secreto saliente (opcional)</label>
              <input
                id="agent-secret"
                type="password"
                value={outboundSecret}
                onChange={(event) => setOutboundSecret(event.target.value)}
                placeholder="Se guarda cifrado, no se muestra más"
                autoComplete="new-password"
                className={inputClassName}
              />
            </div>
            {error !== null ? (
              <p role="alert" className="text-body-sm leading-5 text-danger">{error}</p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Button type="button" disabled={busy} onClick={() => void handleSaveOutbound(true)} className="w-full">
                {busy ? "Guardando…" : "Guardar y seguir"}
              </Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setStep(3)} className="w-full">
                Omitir por ahora
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-4">
            <p className="text-body-sm leading-5 text-muted-foreground">
              El token entrante identifica a tu agente cuando responde a Loki.
              Se muestra <strong>una sola vez</strong>: cópialo ahora. Si lo pierdes,
              genera uno nuevo (el anterior deja de valer).
            </p>
            {token === null ? (
              <Button type="button" disabled={busy} onClick={() => void handleRotate()} className="w-full">
                {busy ? "Generando…" : "Generar token"}
              </Button>
            ) : (
              <>
                <p
                  aria-label="Token entrante (se muestra una sola vez)"
                  className="break-all rounded-sm bg-surface-soft p-3 font-mono text-body-sm text-foreground select-all"
                >
                  {token}
                </p>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={() => void handleCopyToken()} className="min-h-11 flex-1">
                    <Icon icon={copied ? Check : Copy} size={20} />
                    {copied ? "¡Copiado!" : "Copiar"}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => void handleShareToken()} className="min-h-11 flex-1">
                    <Icon icon={Share2} size={20} />
                    Compartir
                  </Button>
                </div>
              </>
            )}
            {error !== null ? (
              <p role="alert" className="text-body-sm leading-5 text-danger">{error}</p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setStep(2)} className="min-h-11 flex-1">
                Atrás
              </Button>
              <Button type="button" disabled={busy} onClick={() => setStep(4)} className="min-h-11 flex-1">
                Seguir
              </Button>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="flex flex-col gap-4">
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
            <p className="rounded-sm bg-surface-soft p-3 text-body-sm leading-5 text-muted-foreground">
              Tu agente ve solo tu instrucción y, si lo activas, los últimos mensajes
              del chat. Nunca ve otros chats ni tus DMs, salvo que lo invoques ahí y
              lo permitas. Corre con tu plan del proveedor y es tu responsabilidad.
            </p>
            {error !== null ? (
              <p role="alert" className="text-body-sm leading-5 text-danger">{error}</p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setStep(3)} className="min-h-11 flex-1">
                Atrás
              </Button>
              <Button
                type="button"
                disabled={busy || connectionId === null}
                onClick={() => void (async () => {
                  if (connectionId === null) return;
                  setFormError(null);
                  try {
                    const { listGrants } = await import("@/lib/data/agents");
                    const existing = await listGrants(connectionId);
                    const byWs = new Map(existing.map((grant) => [grant.workspaceId, grant]));
                    for (const wsId of chosenSpaces) {
                      const current = byWs.get(wsId);
                      if (current !== undefined) {
                        await mutations.updateGrant(current.id, {
                          allowedCallers: callers,
                          allowContext,
                          contextMessages,
                          allowPublish,
                          allowProposeActions: allowPropose,
                        });
                      } else {
                        await mutations.addGrant({
                          connectionId,
                          workspaceId: wsId,
                          allowedCallers: callers,
                          allowContext,
                          contextMessages,
                          allowPublish,
                          allowProposeActions: allowPropose,
                        });
                      }
                    }
                    setStep(5);
                  } catch {
                    // El mensaje ya quedó en mutations.error.
                  }
                })()}
                className="min-h-11 flex-1"
              >
                Guardar y probar
              </Button>
            </div>
          </div>
        ) : null}

        {step === 5 ? (
          <div className="flex flex-col gap-4">
            <p className="text-body-sm leading-5 text-muted-foreground">
              Manda una tarea de prueba y espera el retorno, con el estado visible.
            </p>
            {pingRunId === null ? (
              <Button type="button" disabled={busy} onClick={() => void handlePing()} className="w-full">
                {busy ? "Enviando…" : "Probar conexión"}
              </Button>
            ) : (
              <AgentPingStatus runId={pingRunId} uid={uid} />
            )}
            {error !== null ? (
              <p role="alert" className="text-body-sm leading-5 text-danger">{error}</p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => void handlePing()} disabled={busy} className="min-h-11 flex-1">
                Probar de nuevo
              </Button>
              <Button type="button" onClick={onClose} className="min-h-11 flex-1">
                Terminar
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Permisos de un grant (reusado en el wizard y en la edición). */
export function PermissionsForm(props: {
  callers: AgentAllowedCallers;
  onCallers: (value: AgentAllowedCallers) => void;
  allowContext: boolean;
  onAllowContext: (value: boolean) => void;
  contextMessages: number;
  onContextMessages: (value: number) => void;
  allowPublish: boolean;
  onAllowPublish: (value: boolean) => void;
  allowPropose: boolean;
  onAllowPropose: (value: boolean) => void;
}): React.JSX.Element {
  const {
    callers, onCallers, allowContext, onAllowContext, contextMessages,
    onContextMessages, allowPublish, onAllowPublish, allowPropose, onAllowPropose,
  } = props;
  return (
    <div className="flex flex-col gap-3">
      <fieldset>
        <legend className={labelClassName}>Quién puede invocarlo</legend>
        <div className="flex flex-col gap-1.5">
          {(
            [
              { value: "owner_only", label: "Solo yo", detail: "Nadie más puede usarlo." },
              { value: "space_members", label: "Miembros del espacio", detail: "Cualquiera del espacio puede mencionarlo." },
              { value: "listed", label: "Solo elegidos", detail: "Úsalo por ahora como solo yo; la lista fina llega con el chat." },
            ] as const
          ).map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-3 rounded-sm bg-surface-soft px-3 py-2.5">
              <input
                type="radio"
                name="agent-callers"
                value={option.value}
                checked={callers === option.value}
                onChange={() => onCallers(option.value)}
                className="mt-1 h-4 w-4 accent-[#00B4D8]"
              />
              <span>
                <span className="block text-body text-foreground">{option.label}</span>
                <span className="block text-body-sm text-muted-foreground">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-sm bg-surface-soft px-3 py-2.5">
        <span className="text-body text-foreground">Puede leer el contexto del chat</span>
        <input
          type="checkbox"
          checked={allowContext}
          onChange={(event) => onAllowContext(event.target.checked)}
          className="h-5 w-5 accent-[#00B4D8]"
          aria-label="Puede leer el contexto del chat"
        />
      </label>
      {allowContext ? (
        <div>
          <label htmlFor="agent-context-n" className={labelClassName}>
            Mensajes de contexto: {contextMessages}
          </label>
          <input
            id="agent-context-n"
            type="range"
            min={0}
            max={50}
            value={contextMessages}
            onChange={(event) => onContextMessages(Number(event.target.value))}
            className="w-full"
          />
        </div>
      ) : null}
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-sm bg-surface-soft px-3 py-2.5">
        <span className="text-body text-foreground">Publica en el chat</span>
        <input
          type="checkbox"
          checked={allowPublish}
          onChange={(event) => onAllowPublish(event.target.checked)}
          className="h-5 w-5 accent-[#00B4D8]"
          aria-label="Publica en el chat"
        />
      </label>
      {!allowPublish ? (
        <p className="text-body-sm text-muted-foreground">Apagado: el resultado lo ves solo tú.</p>
      ) : null}
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-sm bg-surface-soft px-3 py-2.5">
        <span className="text-body text-foreground">Puede proponer acciones</span>
        <input
          type="checkbox"
          checked={allowPropose}
          onChange={(event) => onAllowPropose(event.target.checked)}
          className="h-5 w-5 accent-[#00B4D8]"
          aria-label="Puede proponer acciones"
        />
      </label>
    </div>
  );
}
