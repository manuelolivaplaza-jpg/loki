"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { CalendarPlus, Lightbulb, Send } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { MenuItem } from "@/components/ui/menu-card";
import { Pill } from "@/components/ui/pill";
import { SectionLabel } from "@/components/ui/section-label";
import { Toggle } from "@/components/ui/toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { fade } from "@/lib/motion";
import { AVATAR_COLORS, DEFAULT_AVATAR_COLOR } from "@/types/models";

const COLOR_TOKENS: ReadonlyArray<{ name: string; swatchClass: string }> = [
  { name: "background", swatchClass: "bg-background" },
  { name: "surface", swatchClass: "bg-surface" },
  { name: "surface-soft", swatchClass: "bg-surface-soft" },
  { name: "surface-2", swatchClass: "bg-surface-2" },
  { name: "foreground", swatchClass: "bg-foreground" },
  { name: "muted-foreground", swatchClass: "bg-muted-foreground" },
  { name: "divider", swatchClass: "bg-divider" },
  { name: "accent", swatchClass: "bg-accent" },
  { name: "accent-foreground", swatchClass: "bg-accent-foreground" },
  { name: "mention", swatchClass: "bg-mention" },
  { name: "success", swatchClass: "bg-success" },
  { name: "warning", swatchClass: "bg-warning" },
  { name: "danger", swatchClass: "bg-danger" },
];

const TYPE_SCALE: ReadonlyArray<{ name: string; className: string; sample: string }> = [
  { name: "text-meta · 13px", className: "text-meta", sample: "Metadata y etiquetas" },
  { name: "text-body-sm · 15px", className: "text-body-sm", sample: "Cuerpo secundario y botones" },
  { name: "text-body · 17px", className: "text-body", sample: "Cuerpo principal y filas" },
  { name: "text-title · 20px", className: "text-title", sample: "Títulos de pantalla" },
  { name: "text-display · 28px", className: "text-display", sample: "Portadas de auth" },
];

const TYPE_WEIGHTS = [
  { label: "Regular 400", className: "font-normal" },
  { label: "Medium 500", className: "font-medium" },
  { label: "Semibold 600", className: "font-semibold" },
] as const;

export default function TokensPage(): React.JSX.Element {
  const [toggleOn, setToggleOn] = React.useState(true);

  return (
    <motion.main
      variants={fade}
      initial="hidden"
      animate="show"
      className="min-h-screen bg-background text-foreground"
    >
      <div className="mx-auto w-full max-w-2xl px-4 pb-16">
        <header className="flex items-center justify-between py-4">
          <div>
            <h1 className="text-title font-semibold tracking-tight">Loki</h1>
            <p className="text-meta text-muted-foreground">
              Sistema de diseño · ver ui/README
            </p>
          </div>
          <ThemeToggle />
        </header>

        <section className="py-6">
          <SectionLabel>Color (tokens, sin hex en pantallas)</SectionLabel>
          <Card>
            {COLOR_TOKENS.map((token, index) => (
              <React.Fragment key={token.name}>
                {index > 0 ? <CardDivider /> : null}
                <CardRow minHeight="12">
                  <span
                    aria-hidden="true"
                    className={`h-8 w-8 shrink-0 rounded-sm ${token.swatchClass}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-sm font-medium">
                      {token.name}
                    </span>
                    <span className="text-meta block text-muted-foreground">
                      bg-{token.name}
                    </span>
                  </span>
                </CardRow>
              </React.Fragment>
            ))}
          </Card>
        </section>

        <section className="py-6">
          <SectionLabel>Tipografía (400 / 500 / 600)</SectionLabel>
          <Card className="p-4">
            {TYPE_SCALE.map((type) => (
              <p key={type.name} className={`${type.className} font-medium text-foreground`}>
                {type.sample}{" "}
                <span className="text-meta font-normal text-muted-foreground">
                  · {type.name}
                </span>
              </p>
            ))}
            <div className="mt-4 flex flex-col gap-2">
              {TYPE_WEIGHTS.map((weight) => (
                <p key={weight.label} className={`text-body-sm text-muted-foreground ${weight.className}`}>
                  {weight.label} · Loki es sobrio por defecto.
                </p>
              ))}
            </div>
          </Card>
        </section>

        <section className="py-6">
          <SectionLabel>Botones pill</SectionLabel>
          <div className="flex flex-wrap items-center gap-3">
            <Button>Publicar</Button>
            <Button variant="secondary">Secundario</Button>
            <Button variant="destructive">Eliminar</Button>
          </div>
        </section>

        <section className="py-6">
          <SectionLabel>Componentes base</SectionLabel>
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <IconButton variant="floating" aria-label="Ejemplo flotante">
                <Icon icon={Send} size={20} />
              </IconButton>
              <IconButton variant="accent" aria-label="Ejemplo acento">
                <Icon icon={CalendarPlus} size={20} />
              </IconButton>
              <IconButton variant="solid" aria-label="Ejemplo sólido">
                <Icon icon={Lightbulb} size={20} />
              </IconButton>
              <Pill
                leading={<Avatar initial="L" color={DEFAULT_AVATAR_COLOR} size={32} />}
                text="Familia"
                onClick={() => undefined}
              />
              <Toggle checked={toggleOn} onCheckedChange={setToggleOn} label="Ejemplo" />
            </div>
            <div className="mt-4">
              <MenuItem icon={Send} onClick={() => undefined}>
                Compartir algo
              </MenuItem>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {AVATAR_COLORS.map((option) => (
                <Avatar key={option.value} initial="L" color={option.value} size={32} />
              ))}
            </div>
          </Card>
        </section>

        <section className="py-6">
          <SectionLabel>Estados</SectionLabel>
          <Card className="p-4">
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center rounded-full bg-success px-3 py-1 text-body-sm font-medium text-success-foreground">
                success
              </span>
              <span className="inline-flex items-center rounded-full bg-warning px-3 py-1 text-body-sm font-medium text-warning-foreground">
                warning
              </span>
              <span className="inline-flex items-center rounded-full bg-danger px-3 py-1 text-body-sm font-medium text-danger-foreground">
                danger
              </span>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <p className="text-meta font-medium text-success">
                Todo bien con success
              </p>
              <p className="text-meta font-medium text-warning">
                Revisa esto con warning
              </p>
              <p className="text-meta font-medium text-danger">
                Algo falló con danger
              </p>
            </div>
          </Card>
        </section>
      </div>
    </motion.main>
  );
}
