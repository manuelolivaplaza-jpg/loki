"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { SECTIONS } from "@/components/shell/sections";
import type { ProjectItem } from "@/types/organizer";
import { cn } from "@/lib/utils";

function ProgressBar({ done, total }: { done: number; total: number }): React.JSX.Element {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="h-1.5 min-w-0 flex-1 rounded-full bg-surface-soft">
        <span
          className="block h-1.5 rounded-full bg-accent"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="shrink-0 text-meta leading-4 text-muted-foreground">
        {done}/{total}
      </span>
    </span>
  );
}

export function ProjectsList({
  projects,
  onOpen,
  onNew,
}: {
  projects: ProjectItem[];
  onOpen: (project: ProjectItem) => void;
  onNew: () => void;
}): React.JSX.Element {
  const [showArchived, setShowArchived] = React.useState(false);
  const active = projects.filter((item) => item.status === "active");
  const archived = projects.filter((item) => item.status === "archived");
  const visible = showArchived ? archived : active;

  if (projects.length === 0) {
    const section = SECTIONS.proyectos;
    return (
      <EmptyState
        icon={section.icon}
        title={section.emptyTitle}
        description={section.emptyDescription}
        action={{ label: "Nuevo proyecto", onClick: onNew }}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between px-2">
        <SectionLabel>{showArchived ? "Archivados" : "Proyectos"}</SectionLabel>
        {archived.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            className="text-body-sm font-medium text-mention outline-none [@media(hover:hover)]:underline"
          >
            {showArchived ? "Ver activos" : `Ver archivados (${archived.length})`}
          </button>
        ) : null}
      </div>
      <ul className="mt-1 flex flex-col gap-3">
        {visible.map((project) => (
          <li key={project.id}>
            <Card
              role="button"
              tabIndex={0}
              aria-label={`Abrir proyecto ${project.name}`}
              onClick={() => onOpen(project)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpen(project);
                }
              }}
              className={cn("cursor-pointer p-4 outline-none interactive")}
            >
              <span className="flex items-center gap-3">
                <span aria-hidden="true" className="text-title">
                  {project.emoji}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-semibold leading-6 text-foreground">
                    {project.name}
                  </span>
                  {project.description !== "" ? (
                    <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                      {project.description}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="mt-3 block">
                <ProgressBar done={project.done} total={project.total} />
              </span>
            </Card>
          </li>
        ))}
      </ul>
      {visible.length === 0 ? (
        <p className="mt-3 px-2 text-body-sm text-muted-foreground">
          {showArchived ? "Nada archivado." : "Crea tu primer proyecto con +."}
        </p>
      ) : null}
      <Button type="button" onClick={onNew} className="mt-4 w-full">
        <Icon icon={Plus} size={20} />
        Nuevo proyecto
      </Button>
    </div>
  );
}
