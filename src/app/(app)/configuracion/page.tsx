"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { LogOut } from "lucide-react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { ThemeSegmented } from "@/components/shell/theme-segmented";
import { Toggle } from "@/components/ui/toggle";
import { signOutUser } from "@/lib/auth/actions";
import { isAiEnabled } from "@/lib/chat/mentions";
import { cn } from "@/lib/utils";

export default function ConfiguracionPage(): React.JSX.Element {
  const router = useRouter();
  const { theme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  // TODO(fase-2): persistir estas preferencias en Firestore.
  const [pushEnabled, setPushEnabled] = React.useState(true);
  const [digestEnabled, setDigestEnabled] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  // T18: el estado de Loki sale del flag de build NEXT_PUBLIC_AI_ENABLED
  // (inlined en el bundle, sin hydration mismatch). Es de solo lectura: la
  // clave y el proveedor viven en el backend (`functions/`, apagado en fase
  // 1-2), no en el cliente.
  const aiEnabled = isAiEnabled();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const themeLabel =
    mounted && (theme === "dark" || resolvedTheme === "dark")
      ? "Oscuro"
      : "Claro";

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOutUser();
    } finally {
      setSigningOut(false);
      router.replace("/login");
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 px-4 py-6 md:py-8">
      <section aria-label="Apariencia">
        <SectionLabel>Apariencia</SectionLabel>
        <Card className="p-2">
          <CardRow minHeight="14" className="px-2">
            <span className="min-w-0 flex-1 text-body text-foreground">
              Tema
            </span>
            <span className="text-body-sm text-muted-foreground">
              {themeLabel}
            </span>
          </CardRow>
          <CardDivider className="mx-2" />
          <div className="px-2 pb-2 pt-2">
            <ThemeSegmented />
          </div>
        </Card>
      </section>

      <section aria-label="Notificaciones">
        <SectionLabel>Notificaciones</SectionLabel>
        <Card>
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Notificaciones push
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Avisos de actividad en tus espacios
              </span>
            </span>
            <Toggle
              checked={pushEnabled}
              onCheckedChange={setPushEnabled}
              label="Notificaciones push"
            />
          </CardRow>
          <CardDivider />
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Resumen diario
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Un correo al día con lo importante
              </span>
            </span>
            <Toggle
              checked={digestEnabled}
              onCheckedChange={setDigestEnabled}
              label="Resumen diario"
            />
          </CardRow>
        </Card>
      </section>

      <section aria-label="Loki IA">
        <SectionLabel>Loki IA</SectionLabel>
        <Card>
          <CardRow>
            <span className="min-w-0 flex-1">
              <span className="block text-body leading-6 text-foreground">
                Asistente personal
              </span>
              <span className="block text-body-sm leading-5 text-muted-foreground">
                Pregúntale a Loki por tus días, tu semana o un recordatorio
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-meta leading-4",
                aiEnabled
                  ? "bg-success/15 text-success"
                  : "bg-surface text-muted-foreground",
              )}
            >
              {aiEnabled ? "Activada" : "Desactivada"}
            </span>
          </CardRow>
          {!aiEnabled ? (
            <>
              <CardDivider />
              <CardRow minHeight="12">
                <span className="text-body-sm leading-5 text-muted-foreground">
                  Mientras Loki esté desactivada responde con un mensaje
                  simulado y avisa en el chat cuando la mencionas con
                  @loki.
                </span>
              </CardRow>
            </>
          ) : null}
        </Card>
      </section>

      <section aria-label="Cuenta">
        <SectionLabel>Cuenta</SectionLabel>
        <Card>
          <button
            type="button"
            aria-label="Cerrar sesion"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
            className="flex min-h-14 w-full items-center gap-3 rounded-lg px-4 text-left text-body font-medium text-danger outline-none interactive disabled:opacity-60"
          >
            <Icon icon={LogOut} size={22} />
            {signingOut ? "Cerrando..." : "Cerrar sesión"}
          </button>
        </Card>
      </section>
    </div>
  );
}
