"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lightbulb } from "lucide-react";
import { SECTIONS } from "@/components/shell/sections";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

export type ProyectosTab = "proyectos" | "ideas";

type IdeaItem = {
  id: string;
  title: string;
  detail: string;
  tag: string;
};

// TODO(fase-2): ideas de ejemplo; traer ideas reales de Firestore.
const IDEAS_MOCK: readonly IdeaItem[] = [
  { id: "i1", title: "Huerto en el balcón", detail: "Empezar con albahaca y tomates cherry", tag: "Casa" },
  { id: "i2", title: "Viaje a la costa", detail: "Escapada de fin de semana en primavera", tag: "Viajes" },
  { id: "i3", title: "App de recetas familiares", detail: "Recopilar las recetas de la abuela", tag: "Proyecto" },
];

const TABS: readonly { key: ProyectosTab; label: string }[] = [
  { key: "proyectos", label: "Proyectos" },
  { key: "ideas", label: "Ideas" },
];

export function ProyectosTabs({
  defaultTab,
}: {
  defaultTab: ProyectosTab;
}): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab: ProyectosTab =
    searchParams.get("tab") === "ideas" ? "ideas" : defaultTab === "ideas" ? "ideas" : "proyectos";
  const section = SECTIONS.proyectos;

  function selectTab(tab: ProyectosTab): void {
    if (tab === activeTab) return;
    router.replace(tab === "ideas" ? "/proyectos?tab=ideas" : "/proyectos");
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
      <div
        role="tablist"
        aria-label="Proyectos e ideas"
        className="flex rounded-full bg-surface-soft p-1"
      >
        {TABS.map((tab) => {
          const selected = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={tab.label}
              onClick={() => selectTab(tab.key)}
              className={cn(
                "h-9 flex-1 rounded-full text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                selected
                  ? "bg-background text-foreground shadow-float dark:bg-divider dark:text-white"
                  : "text-muted-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "ideas" ? (
        <div className="mt-2">
          <SectionLabel>Ideas del espacio</SectionLabel>
          <Card>
            {IDEAS_MOCK.map((idea, index) => (
              <React.Fragment key={idea.id}>
                {index > 0 ? <CardDivider /> : null}
                <CardRow minHeight="15">
                  <span
                    aria-hidden="true"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-background text-foreground dark:bg-surface-2"
                  >
                    <Icon icon={Lightbulb} size={22} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold leading-6 text-foreground">
                      {idea.title}
                    </span>
                    <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                      {idea.detail}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-meta leading-4 text-muted-foreground dark:bg-surface-2">
                    {idea.tag}
                  </span>
                </CardRow>
              </React.Fragment>
            ))}
          </Card>
          <p className="mt-3 px-2 text-meta leading-5 text-muted-foreground">
            Crea una con Nueva idea desde el menú +.
          </p>
        </div>
      ) : (
        <div className="mt-2">
          <EmptyState
            icon={section.icon}
            title={section.emptyTitle}
            description={section.emptyDescription}
          />
        </div>
      )}
    </div>
  );
}
