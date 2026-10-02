"use client";

import * as React from "react";
import { Check, Copy, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { inputClassName } from "@/components/auth/auth-ui";
import { usePairCode } from "@/hooks/use-devices";
import { cn } from "@/lib/utils";

const CODE_TTL_MS = 5 * 60 * 1000;

async function makeQrDataUrl(text: string): Promise<string | null> {
  try {
    const { default: QRCode } = await import("qrcode");
    return await QRCode.toDataURL(text, { margin: 1, width: 220 });
  } catch {
    return null;
  }
}

/**
 * Vincular un PC: genera un código corto de un solo uso (5 min) + QR con el
 * código. En el compañero de escritorio se ingresa el código y la Edge
 * `device-pair` le entrega su credencial propia.
 */
export function PairDeviceSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const pairing = usePairCode();
  const [name, setName] = React.useState("Mi PC");
  const [qr, setQr] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!open) return;
    setName("Mi PC");
    setQr(null);
    setCopied(false);
    pairing.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  React.useEffect(() => {
    if (pairing.code === null) {
      setQr(null);
      return undefined;
    }
    let cancelled = false;
    void makeQrDataUrl(`loki-pair:${pairing.code}`).then((url) => {
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [pairing.code]);

  React.useEffect(() => {
    if (!open || pairing.createdAt === null) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, pairing.createdAt]);

  const leftMs =
    pairing.createdAt === null ? 0 : Math.max(0, CODE_TTL_MS - (now - pairing.createdAt));
  const leftSecs = Math.ceil(leftMs / 1000);
  const expired = pairing.code !== null && leftMs <= 0;

  async function handleCopy(): Promise<void> {
    if (pairing.code === null) return;
    try {
      await navigator.clipboard.writeText(pairing.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent aria-label="Vincular un PC">
        <DialogTitle>Vincular un PC</DialogTitle>
        <DialogDescription>
          Genera un código de un solo uso y escríbelo en el compañero de
          escritorio. Vence en 5 minutos.
        </DialogDescription>
        {pairing.code === null ? (
          <form
            className="flex flex-col gap-3 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              pairing.generate(name.trim() === "" ? "Mi PC" : name.trim());
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-meta leading-4 text-muted-foreground">
                Nombre del PC
              </span>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                autoComplete="off"
                className={cn(inputClassName, "min-h-11")}
              />
            </label>
            {pairing.error !== null ? (
              <p role="alert" className="text-body-sm text-danger">
                {pairing.error.message}
              </p>
            ) : null}
            <Button type="submit" disabled={pairing.isPending} className="min-h-11">
              {pairing.isPending ? "Generando…" : "Generar código"}
            </Button>
          </form>
        ) : (
          <div className="flex flex-col items-center gap-3 pt-2">
            {qr !== null ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="QR con el código de vinculación" width={180} height={180} className="rounded-xl border border-divider" />
            ) : (
              <span className="flex h-24 w-24 items-center justify-center rounded-xl bg-surface-soft">
                <Icon icon={MonitorSmartphone} size={32} className="text-muted-foreground" />
              </span>
            )}
            <p
              aria-label={`Código: ${pairing.code}`}
              className="text-center text-4xl font-bold tracking-[0.3em] text-foreground"
            >
              {pairing.code}
            </p>
            <p role="status" className="text-body-sm text-muted-foreground">
              {expired
                ? "Venció: genera otro código."
                : `Vence en ${Math.floor(leftSecs / 60)}:${String(leftSecs % 60).padStart(2, "0")}`}
            </p>
            <div className="flex w-full gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleCopy()}
                className="min-h-11 flex-1"
              >
                <Icon icon={copied ? Check : Copy} size={18} />
                {copied ? "Copiado" : "Copiar"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => pairing.generate(name.trim() === "" ? "Mi PC" : name.trim())}
                disabled={pairing.isPending}
                className="min-h-11 flex-1"
              >
                Generar otro
              </Button>
            </div>
            <p className="text-center text-meta leading-4 text-muted-foreground">
              El PC nunca usa tu contraseña: recibe su propia credencial.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
