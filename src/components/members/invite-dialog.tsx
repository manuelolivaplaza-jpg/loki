"use client";

import * as React from "react";
import { Check, Copy, QrCode, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { useCreateInvite } from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import type { ExpiryOption } from "@/lib/data/invites";
import type { InviteItem } from "@/types/organizer";
import { cn } from "@/lib/utils";

const EXPIRY_OPTIONS: readonly { value: ExpiryOption; label: string }[] = [
  { value: "1d", label: "1 día" },
  { value: "7d", label: "7 días" },
  { value: "never", label: "Nunca" },
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
  const [expiry, setExpiry] = React.useState<ExpiryOption>("7d");
  const [invite, setInvite] = React.useState<InviteItem | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setRole("member");
    setExpiry("7d");
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
        expiry,
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
              <label htmlFor="invite-role" className={labelClassName}>
                Rol
              </label>
              <select
                id="invite-role"
                name="role"
                value={role}
                onChange={(formEvent) => setRole(formEvent.target.value as InviteItem["role"])}
                className={inputClassName}
              >
                <option value="member">Miembro</option>
                <option value="admin">Administrador</option>
              </select>
            </div>
            <div>
              <span id="invite-expiry-label" className={labelClassName}>
                Caduca
              </span>
              <div role="group" aria-labelledby="invite-expiry-label" className="flex gap-2">
                {EXPIRY_OPTIONS.map((option) => {
                  const active = expiry === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setExpiry(option.value)}
                      className={cn(
                        "h-9 flex-1 rounded-full text-body-sm outline-none interactive",
                        active
                          ? "bg-foreground font-semibold text-background dark:bg-white dark:text-black"
                          : "bg-surface-soft text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
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
