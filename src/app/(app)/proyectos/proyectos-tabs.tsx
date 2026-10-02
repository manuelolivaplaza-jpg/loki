"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Lightbulb, Plus, X } from "lucide-react";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { SectionLabel } from "@/components/ui/section-label";
import { inputClassName, labelClassName } from "@/components/auth/auth-ui";
import { Button } from "@/components/ui/button";
import { QueryRetry } from "@/components/ui/query-retry";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProjectDetail } from "@/components/projects/project-detail";
/** Diálogo de proyecto por code splitting: solo se descarga al crear/editar. */
const ProjectDialog = dynamic(
  () => import("@/components/projects/project-dialog").then((mod) => mod.ProjectDialog),
  { ssr: false },
);
import { ProjectsList } from "@/components/projects/projects-list";
import { ListsTab } from "@/components/lists/lists-tab";
import { ListDetail } from "@/components/lists/list-detail";
import { ShareListDialog } from "@/components/lists/share-list-dialog";
/** Vista Turnos por code splitting: solo se descarga al abrir la pestaña. */
const ShiftsViewLazy = dynamic(
  () => import("@/components/series/shifts-view").then((mod) => mod.ShiftsView),
  { ssr: false, loading: () => (
    <div aria-label="Cargando turnos" className="mt-2 flex flex-col gap-2">
      {[0, 1, 2].map((index) => (
        <span key={index} aria-hidden="true" className="block h-14 animate-pulse rounded-xl bg-surface-soft" />
      ))}
    </div>
  ) },
);
import {
  useConvertIdea,
  useCreateIdea,
  useDeleteIdea,
  useIdeas,
  useProjects,
  useShoppingLists,
} from "@/hooks/use-organizer";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { IdeaItem, ProjectItem, ShoppingList } from "@/types/organizer";
import { cn } from "@/lib/utils";

export type ProyectosTab = "proyectos" | "ideas" | "listas" | "turnos";

const TABS: readonly { key: ProyectosTab; label: string }[] = [
  { key: "proyectos", label: "Proyectos" },
  { key: "ideas", label: "Ideas" },
  { key: "listas", label: "Listas" },
  { key: "turnos", label: "Turnos" },
];

function ListsTabView({
  wsId,
  listParam,
  onOpenList,
  onCloseList,
}: {
  wsId: string | null;
  listParam: string | null;
  onOpenList: (id: string) => void;
  onCloseList: () => void;
}): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const listsQuery = useShoppingLists(wsId);
  const [shareList, setShareList] = React.useState<ShoppingList | null>(null);
  const lists = listsQuery.data ?? [];
  const openList =
    listParam !== null ? (lists.find((item) => item.id === listParam) ?? null) : null;
  // Enlace directo a una lista: la query aún carga o el id ya no existe.
  if (listParam !== null && openList === null && wsId !== null) {
    if (listsQuery.isPending) {
      return (
        <div aria-label="Cargando lista" className="mt-2 flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <span key={index} aria-hidden="true" className="block h-12 animate-pulse rounded-xl bg-surface-soft" />
          ))}
        </div>
      );
    }
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={onCloseList}
          className="min-h-11 rounded-full px-4 text-body-sm font-medium text-mention outline-none"
        >
          ← Volver a listas
        </button>
        <p className="mt-2 text-body-sm text-muted-foreground">
          Esa lista ya no existe en este espacio.
        </p>
      </div>
    );
  }
  // Escritorio: panel a la izquierda, lista abierta a la derecha. Móvil:
  // una sola columna (la lista abierta es pantalla completa con volver).
  return (
    <>
      <div className="mt-2 lg:grid lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start lg:gap-4">
        <div className={openList !== null ? "hidden lg:block" : undefined}>
          <ListsTab
            wsId={wsId}
            onOpen={(list) => onOpenList(list.id)}
          />
        </div>
        {openList !== null && wsId !== null ? (
          <div className="min-w-0 lg:rounded-2xl lg:border lg:border-divider lg:p-4">
            <ListDetail list={openList} wsId={wsId} onBack={onCloseList} onShare={setShareList} />
          </div>
        ) : (
          <p className="hidden text-body-sm text-muted-foreground lg:mt-8 lg:block lg:text-center">
            Elige una lista para verla aquí.
          </p>
        )}
      </div>
      <ShareListDialog
        open={shareList !== null}
        list={shareList}
        wsId={wsId ?? ""}
        uid={user?.uid ?? null}
        authorName={user?.displayName?.trim() || "Miembro"}
        onClose={() => setShareList(null)}
      />
    </>
  );
}

function IdeasTab({ wsId }: { wsId: string | null }): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const ideasQuery = useIdeas(wsId);
  const createIdea = useCreateIdea(wsId);
  const deleteIdea = useDeleteIdea();
  const convertIdea = useConvertIdea();
  const projectsQuery = useProjects(wsId);

  const [formOpen, setFormOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [detail, setDetail] = React.useState("");
  const [tag, setTag] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [convertFor, setConvertFor] = React.useState<string | null>(null);
  const [convertProject, setConvertProject] = React.useState("");

  const ideas = ideasQuery.data ?? [];
  const projects = (projectsQuery.data ?? []).filter((item) => item.status === "active");

  async function handleCreate(formEvent: React.FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (user === null) {
      setError("Tu sesión expiró. Vuelve a iniciar sesión.");
      return;
    }
    setError(null);
    try {
      await createIdea.mutateAsync({ uid: user.uid, title, detail, tag });
      setTitle("");
      setDetail("");
      setTag("");
      setFormOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo crear la idea.");
    }
  }

  async function handleConvert(idea: IdeaItem): Promise<void> {
    if (user === null || convertProject === "") return;
    setError(null);
    try {
      await convertIdea.mutateAsync({ idea, projectId: convertProject, uid: user.uid });
      setConvertFor(null);
      setConvertProject("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo convertir la idea.");
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between px-2">
        <SectionLabel>Ideas del espacio</SectionLabel>
        <IconButton variant="solid" aria-label="Nueva idea" onClick={() => setFormOpen(true)}>
          <Icon icon={Plus} size={20} />
        </IconButton>
      </div>
      {ideasQuery.isPending && ideas.length === 0 ? (
        <div aria-label="Cargando ideas" className="flex flex-col gap-2">
          {[0, 1].map((index) => (
            <span
              key={index}
              aria-hidden="true"
              className="block h-16 animate-pulse rounded-lg bg-surface-soft"
            />
          ))}
        </div>
      ) : ideasQuery.isError && ideas.length === 0 ? (
        <QueryRetry
          message="No se pudieron cargar las ideas."
          onRetry={() => void ideasQuery.refetch()}
        />
      ) : ideas.length === 0 ? (
        <Card>
          <p className="px-4 py-6 text-center text-body-sm text-muted-foreground">
            Sin ideas. Crea la primera con +.
          </p>
        </Card>
      ) : (
        <Card>
          {ideas.map((idea, index) => (
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
                  {idea.detail !== "" ? (
                    <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                      {idea.detail}
                    </span>
                  ) : null}
                  {idea.convertedTaskId !== null ? (
                    <span className="block text-meta leading-5 text-success">
                      Convertida en tarea
                    </span>
                  ) : convertFor === idea.id ? (
                    <span className="mt-1 flex items-center gap-2">
                      <select
                        aria-label="Proyecto destino"
                        value={convertProject}
                        onChange={(formEvent) => setConvertProject(formEvent.target.value)}
                        className="h-9 min-w-0 flex-1 rounded-sm bg-background px-2 text-body-sm text-foreground outline-none dark:bg-surface-2"
                      >
                        <option value="">Elige proyecto…</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.emoji} {project.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={convertProject === "" || convertIdea.isPending}
                        onClick={() => void handleConvert(idea)}
                        className="shrink-0 text-body-sm font-semibold text-mention outline-none disabled:opacity-60"
                      >
                        Convertir
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setConvertFor(idea.id);
                        setConvertProject("");
                        setError(null);
                      }}
                      className="mt-0.5 text-body-sm font-medium text-mention outline-none [@media(hover:hover)]:underline"
                    >
                      Convertir en tarea
                    </button>
                  )}
                </span>
                {idea.tag !== "" ? (
                  <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-meta leading-4 text-muted-foreground dark:bg-surface-2">
                    {idea.tag}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Eliminar idea ${idea.title}`}
                  onClick={() => {
                    setError(null);
                    deleteIdea.mutate(idea.id, {
                      onError: (err) => setError(err.message),
                    });
                  }}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none interactive"
                >
                  <Icon icon={X} size={20} />
                </button>
              </CardRow>
            </React.Fragment>
          ))}
        </Card>
      )}
      {error !== null ? (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      ) : null}
      <Dialog open={formOpen} onOpenChange={(next) => { if (!next) setFormOpen(false); }}>
        <DialogContent aria-label="Nueva idea">
          <DialogTitle>Nueva idea</DialogTitle>
          <DialogDescription>Se guarda en el espacio actual.</DialogDescription>
          <form onSubmit={(formEvent) => void handleCreate(formEvent)} className="flex flex-col gap-4">
            <div>
              <label htmlFor="idea-title" className={labelClassName}>
                Título
              </label>
              <input
                id="idea-title"
                name="title"
                type="text"
                required
                maxLength={120}
                value={title}
                onChange={(formEvent) => setTitle(formEvent.target.value)}
                placeholder="p. ej. Huerto en el balcón"
                className={inputClassName}
              />
            </div>
            <div>
              <label htmlFor="idea-detail" className={labelClassName}>
                Detalle
              </label>
              <textarea
                id="idea-detail"
                name="detail"
                rows={2}
                value={detail}
                onChange={(formEvent) => setDetail(formEvent.target.value)}
                placeholder="Opcional"
                className={`${inputClassName} min-h-11 py-3`}
              />
            </div>
            <div>
              <label htmlFor="idea-tag" className={labelClassName}>
                Etiqueta
              </label>
              <input
                id="idea-tag"
                name="tag"
                type="text"
                maxLength={30}
                value={tag}
                onChange={(formEvent) => setTag(formEvent.target.value)}
                placeholder="p. ej. Casa"
                className={inputClassName}
              />
            </div>
            <Button type="submit" disabled={createIdea.isPending} className="w-full">
              {createIdea.isPending ? "Guardando…" : "Crear idea"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ProyectosTabs({
  defaultTab,
}: {
  defaultTab: ProyectosTab;
}): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentWorkspaceId } = useWorkspaces();
  const projectsQuery = useProjects(currentWorkspaceId);

  const activeTab: ProyectosTab =
    searchParams.get("tab") === "ideas"
      ? "ideas"
      : searchParams.get("tab") === "listas"
        ? "listas"
        : searchParams.get("tab") === "turnos"
          ? "turnos"
          : defaultTab === "ideas"
            ? "ideas"
            : "proyectos";
  const projectParam = searchParams.get("project");
  const taskParam = searchParams.get("task");
  const listParam = searchParams.get("list");

  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);
  const [editingProject, setEditingProject] = React.useState<ProjectItem | null>(null);

  const projects = projectsQuery.data ?? [];
  const openProject =
    projectParam !== null ? (projects.find((item) => item.id === projectParam) ?? null) : null;

  function selectTab(tab: ProyectosTab): void {
    if (tab === activeTab) return;
    router.replace(
      tab === "ideas"
        ? "/proyectos?tab=ideas"
        : tab === "listas"
          ? "/proyectos?tab=listas"
          : tab === "turnos"
            ? "/proyectos?tab=turnos"
            : "/proyectos",
    );
  }

  function openProjectDetail(project: ProjectItem): void {
    router.replace(`/proyectos?project=${project.id}`);
  }

  function closeProjectDetail(): void {
    router.replace("/proyectos");
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
        <IdeasTab wsId={currentWorkspaceId} />
      ) : activeTab === "turnos" ? (
        /* Code splitting: la vista Turnos solo se descarga al abrirla. */
        <ShiftsViewLazy />
      ) : activeTab === "listas" ? (
        <ListsTabView
          wsId={currentWorkspaceId}
          listParam={listParam}
          onOpenList={(id) => router.replace(`/proyectos?tab=listas&list=${encodeURIComponent(id)}`)}
          onCloseList={() => router.replace("/proyectos?tab=listas")}
        />
      ) : openProject !== null ? (
        <div className="mt-2">
          <ProjectDetail
            project={openProject}
            deepTaskId={taskParam}
            onBack={closeProjectDetail}
          />
          <button
            type="button"
            onClick={() => {
              setEditingProject(openProject);
              setProjectDialogOpen(true);
            }}
            className="mt-3 w-full text-center text-body-sm font-medium text-muted-foreground outline-none [@media(hover:hover)]:underline"
          >
            Editar proyecto
          </button>
        </div>
      ) : (
        <div className="mt-2">
          {projectsQuery.isPending && projects.length === 0 ? (
            <div aria-label="Cargando proyectos" className="flex flex-col gap-3">
              {[0, 1].map((index) => (
                <span
                  key={index}
                  aria-hidden="true"
                  className="block h-24 animate-pulse rounded-lg bg-surface-soft"
                />
              ))}
            </div>
          ) : projectsQuery.isError && projects.length === 0 ? (
            <QueryRetry
              message="No se pudieron cargar los proyectos."
              onRetry={() => void projectsQuery.refetch()}
            />
          ) : (
            <ProjectsList
              projects={projects}
              onOpen={openProjectDetail}
              onNew={() => {
                setEditingProject(null);
                setProjectDialogOpen(true);
              }}
            />
          )}
        </div>
      )}

      {projectDialogOpen ? (
        <ProjectDialog
          open={projectDialogOpen}
          project={editingProject}
          onClose={() => setProjectDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
