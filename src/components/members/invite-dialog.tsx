"use client";

import * as React from "react";
import { Check, Copy, Crown, QrCode, Share2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { MenuItem } from "@/components/ui/menu-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { useCreateInvite } from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import type { InviteItem } from "@/types/organizer";

const ROLE_OPTIONS: readonly {
  value: InviteItem["role"];
  label: string;
  detail: string;
}[] = [
  { value: "member", label: "Miembro", detail: "Participa en chats, tareas y eventos" },
  { value: "admin", label: "Administrador", detail: "Además invita y gestiona el espacio" },
];

async function makeQrDataUrl(text: string): Promise<string | null> {
  try {
    const { default: QRCode } = await import("qrcode");
    return await QRCode.toDataURL(text, { margin: 1, width: 220 });
  } catch {
    return null;
  }
}

export function InviteDialog({
  open,
  wsId,
  onClose,
}: {
  open: boolean;
  wsId: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const createInvite = useCreateInvite(wsId);
  const user = useSessionStore((state) => state.user);
  const [role, setRole] = React.useState<InviteItem["role"]>("member");
  const [roleOpen, setRoleOpen] = React.useState(false);
  const [invite, setInvite] = React.useState<InviteItem | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setRole("member");
    setRoleOpen(false);
    setInvite(null);
    setQr(null);
    setError(null);
    setCopied(false);
  }, [open]);

  const link =
    invite !== null && typeof window !== "undefined"
      ? `${window.location.origin}/invite?code=${invite.code}`
      : "";

  async function handleCreate(formEvent: React.FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (wsId === null || user === null) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    setError(null);
    try {
      const created = await createInvite.mutateAsync({
        uid: user.uid,
        role,
        maxUses: null,
      });
      setInvite(created);
      setQr(null);
      void makeQrDataUrl(
        typeof window !== "undefined"
          ? `${window.location.origin}/invite?code=${created.code}`
          : created.code,
      ).then(setQr);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo crear la invitación.");
    }
  }

  async function handleCopy(): Promise<void> {
    if (link === "" || typeof navigator === "undefined" || navigator.clipboard === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Portapapeles no disponible: el link sigue visible para copiar a mano.
    }
  }

  async function handleShare(): Promise<void> {
    if (link === "") return;
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      try {
        await navigator.share({ title: "Invitación a Loki", text: "Únete a mi espacio", url: link });
        return;
      } catch {
        // Cancelado por la persona: se queda en el diálogo.
        return;
      }
    }
    await handleCopy();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label="Invitar al espacio">
        <DialogTitle>Invitar al espacio</DialogTitle>
        <DialogDescription>Quien tenga el link entra con ese rol.</DialogDescription>
        {invite === null ? (
          <form onSubmit={(formEvent) => void handleCreate(formEvent)} className="flex flex-col gap-4">
            <div>
              <span id="invite-role-label" className={labelClassName}>
                Rol
              </span>
              <Popover open={roleOpen} onOpenChange={setRoleOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-labelledby="invite-role-label"
                    aria-haspopup="menu"
                    aria-expanded={roleOpen}
                    className={`${inputClassName} flex items-center gap-3 text-left`}
                  >
                    <Icon
                      icon={role === "admin" ? Crown : User}
                      size={20}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {role === "admin" ? "Administrador" : "Miembro"}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-2">
                  <div role="menu" aria-label="Rol de la invitación" className="flex flex-col gap-1">
                    {ROLE_OPTIONS.map((option) => {
                      const selected = role === option.value;
                      return (
                        <MenuItem
                          key={option.value}
                          icon={option.value === "admin" ? Crown : User}
                          description={option.detail}
                          role="menuitemradio"
                          aria-checked={selected}
                          aria-label={option.label}
                          onClick={() => {
                            setRole(option.value);
                            setRoleOpen(false);
                          }}
                        >
                          <span className="flex items-center gap-2">
                            {option.label}
                            {selected ? (
                              <Icon icon={Check} size={20} className="shrink-0 text-accent" />
                            ) : null}
                          </span>
                        </MenuItem>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
              <p className="mt-1 text-meta leading-5 text-muted-foreground">
                Las invitaciones no caducan.
              </p>
            </div>
            {error !== null ? (
              <p role="alert" className="text-meta text-danger">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={createInvite.isPending} className="w-full">
              {createInvite.isPending ? "Creando…" : "Crear invitación"}
            </Button>
          </form>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <p
              aria-label={`Código ${invite.code}`}
              className="rounded-lg bg-surface-soft px-6 py-3 font-mono text-title font-semibold tracking-[0.3em] text-foreground"
            >
              {invite.code}
            </p>
            {qr !== null ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt={`QR para unirse con ${invite.code}`} width={220} height={220} />
            ) : (
              <span aria-hidden="true" className="flex h-[120px] w-[120px] items-center justify-center rounded-lg bg-surface-soft">
                <Icon icon={QrCode} size={22} />
              </span>
            )}
            <p className="w-full truncate text-center text-body-sm text-muted-foreground">{link}</p>
            <div className="flex w-full gap-2">
              <Button type="button" variant="secondary" onClick={() => void handleCopy()} className="flex-1">
                <Icon icon={copied ? Check : Copy} size={20} />
                {copied ? "Copiado" : "Copiar link"}
              </Button>
              <Button type="button" onClick={() => void handleShare()} className="flex-1">
                <Icon icon={Share2} size={20} />
                Compartir
              </Button>
            </div>
            {error !== null ? (
              <p role="alert" className="text-meta text-danger">
                {error}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
