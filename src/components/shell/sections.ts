import {
  CalendarDays,
  FolderKanban,
  Lightbulb,
  MessageCircle,
  Newspaper,
  type LucideIcon,
} from "lucide-react";

export type SectionKey = "chat" | "feed" | "calendario" | "proyectos" | "ideas";

export type ContextItem = {
  title: string;
  meta: string;
};

export type SectionMeta = {
  key: SectionKey;
  href: string;
  label: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  contextTitle: string;
  contextItems: ContextItem[];
};

export const NAV_ITEMS: SectionMeta[] = [
  {
    key: "chat",
    href: "/chat",
    label: "Chat",
    icon: MessageCircle,
    emptyTitle: "Sin conversaciones todavía",
    emptyDescription: "Inicia un chat nuevo para empezar.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Hilos fijados", meta: "0 fijados" },
      { title: "Actividad reciente", meta: "Sin actividad hoy" },
      { title: "Atajos", meta: "Nuevo chat con N" },
    ],
  },
  {
    key: "feed",
    href: "/feed",
    label: "Feed",
    icon: Newspaper,
    emptyTitle: "Tu feed está vacío",
    emptyDescription: "Todavía no hay publicaciones para mostrar.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Tendencias", meta: "Sin tendencias por ahora" },
      { title: "Fuentes", meta: "0 fuentes seguidas" },
      { title: "Guardados", meta: "0 elementos" },
    ],
  },
  {
    key: "calendario",
    href: "/calendario",
    label: "Calendario",
    icon: CalendarDays,
    emptyTitle: "Sin eventos próximos",
    emptyDescription: "No tienes nada programado por ahora.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Hoy", meta: "0 eventos" },
      { title: "Esta semana", meta: "0 eventos" },
      { title: "Recordatorios", meta: "Ninguno activo" },
    ],
  },
  {
    key: "proyectos",
    href: "/proyectos",
    label: "Proyectos",
    icon: FolderKanban,
    emptyTitle: "Sin proyectos",
    emptyDescription: "Crea tu primer proyecto para organizarte.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Activos", meta: "0 proyectos" },
      { title: "Archivados", meta: "0 proyectos" },
      { title: "Tareas abiertas", meta: "0 tareas" },
    ],
  },
  {
    key: "ideas",
    href: "/ideas",
    label: "Ideas",
    icon: Lightbulb,
    emptyTitle: "Sin ideas guardadas",
    emptyDescription: "Anota tu primera idea cuando aparezca.",
    contextTitle: "Contexto",
    contextItems: [
      { title: "Recientes", meta: "0 ideas" },
      { title: "Favoritas", meta: "0 favoritas" },
      { title: "Etiquetas", meta: "Sin etiquetas" },
    ],
  },
];

export const SECTIONS: Record<SectionKey, SectionMeta> = {
  chat: NAV_ITEMS[0],
  feed: NAV_ITEMS[1],
  calendario: NAV_ITEMS[2],
  proyectos: NAV_ITEMS[3],
  ideas: NAV_ITEMS[4],
};

export function getSectionByPath(pathname: string | null): SectionMeta {
  if (!pathname) return SECTIONS.chat;
  const found = NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return found ?? SECTIONS.chat;
}

/**
 * Rutas de pantalla completa en móvil: sin barra inferior ni padding extra
 * (conversación de chat, perfil y configuración).
 */
export function isFullscreenRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  if (pathname === "/perfil" || pathname.startsWith("/perfil/")) return true;
  if (pathname === "/configuracion" || pathname.startsWith("/configuracion/")) {
    return true;
  }
  if (pathname.startsWith("/chat/") && pathname !== "/chat/") return true;
  return false;
}
