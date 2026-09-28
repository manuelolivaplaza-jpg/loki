"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

type TokenSwatch = {
  name: string;
  light: string;
  dark: string;
  swatchClass: string;
  textClass?: string;
};

const TOKENS: TokenSwatch[] = [
  { name: "background", light: "#FFFFFF", dark: "#000000", swatchClass: "bg-background border-border-strong" },
  { name: "surface", light: "#F7F9F9", dark: "#0A0A0A", swatchClass: "bg-surface border-border-strong" },
  { name: "surface-2", light: "#EFF3F4", dark: "#111111", swatchClass: "bg-surface-2 border-border-strong" },
  { name: "foreground", light: "#0F1419", dark: "#E7E9EA", swatchClass: "bg-foreground" },
  { name: "muted-foreground", light: "#536471", dark: "#71767B", swatchClass: "bg-muted-foreground" },
  { name: "border", light: "#EFF3F4", dark: "#2F3336", swatchClass: "bg-border border-border-strong" },
  { name: "border-strong", light: "#CFD9DE", dark: "#3E4247", swatchClass: "bg-border-strong" },
  { name: "accent", light: "#00B4D8", dark: "#00B4D8", swatchClass: "bg-accent" },
  { name: "mention", light: "#1D9BF0", dark: "#1D9BF0", swatchClass: "bg-mention" },
  { name: "success", light: "#00BA7C", dark: "#00BA7C", swatchClass: "bg-success" },
  { name: "warning", light: "#FFAD1F", dark: "#FFAD1F", swatchClass: "bg-warning" },
  { name: "danger", light: "#F4212E", dark: "#F4212E", swatchClass: "bg-danger" },
];

const TYPE_WEIGHTS = [
  { label: "Regular 400", className: "font-normal" },
  { label: "Medium 500", className: "font-medium" },
  { label: "Semibold 600", className: "font-semibold" },
] as const;

export default function Home(): React.JSX.Element {
  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="min-h-screen bg-background text-foreground"
    >
      <div className="mx-auto w-full max-w-2xl px-4 pb-16">
        <header className="flex items-center justify-between border-b border-border py-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Loki</h1>
            <p className="text-meta text-muted-foreground">
              Tokens provisionales · estilo X / Grok
            </p>
          </div>
          <ThemeToggle />
        </header>

        <section className="border-b border-border py-8">
          <h2 className="text-base font-semibold">Color</h2>
          <p className="text-meta text-muted-foreground">
            Claro por defecto · oscuro true black con .dark
          </p>
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
            {TOKENS.map((token) => (
              <li
                key={token.name}
                className="flex items-center gap-3 bg-background px-3 py-2.5"
              >
                <span
                  aria-hidden
                  className={`h-8 w-8 shrink-0 rounded-md border ${token.swatchClass}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {token.name}
                  </span>
                  <span className="text-meta block text-muted-foreground">
                    light {token.light} · dark {token.dark}
                  </span>
                </span>
                <code className="text-meta shrink-0 text-muted-foreground">
                  {token.light}
                </code>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-b border-border py-8">
          <h2 className="text-base font-semibold">Tipografía</h2>
          <p className="text-meta text-muted-foreground">
            Inter 400 / 500 / 600 · cuerpo 16px · metadata 13px
          </p>
          <div className="mt-4 space-y-4 rounded-xl border border-border bg-surface p-4">
            {TYPE_WEIGHTS.map((weight) => (
              <div key={weight.label} className="space-y-1">
                <p className="text-meta text-muted-foreground">{weight.label}</p>
                <p className={`text-base ${weight.className}`}>
                  Loki es sobrio por defecto — 16px cuerpo.
                </p>
                <p className={`text-meta text-muted-foreground ${weight.className}`}>
                  Metadata 13px · @loki · hace 2 h
                </p>
              </div>
            ))}
            <p className="text-base">
              Mención en <span className="text-mention">@loki</span> con color
              mention.
            </p>
          </div>
        </section>

        <section className="border-b border-border py-8">
          <h2 className="text-base font-semibold">Botones</h2>
          <p className="text-meta text-muted-foreground">
            Variante default usa accent #00B4D8
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button>Publicar</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
        </section>

        <section className="py-8">
          <h2 className="text-base font-semibold">Estados</h2>
          <p className="text-meta text-muted-foreground">
            success · warning · danger sobrios
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="bg-success text-success-foreground inline-flex items-center rounded-full px-3 py-1 text-sm font-medium">
              success
            </span>
            <span className="bg-warning text-warning-foreground inline-flex items-center rounded-full px-3 py-1 text-sm font-medium">
              warning
            </span>
            <span className="bg-danger text-danger-foreground inline-flex items-center rounded-full px-3 py-1 text-sm font-medium">
              danger
            </span>
          </div>
          <div className="mt-4 space-y-2 rounded-xl border border-border bg-surface p-4">
            <p className="text-meta text-success font-medium">
              Todo bien — success #00BA7C
            </p>
            <p className="text-meta text-warning font-medium">
              Revisá esto — warning #FFAD1F
            </p>
            <p className="text-meta text-danger font-medium">
              Algo falló — danger #F4212E
            </p>
          </div>
        </section>
      </div>
    </motion.main>
  );
}
