import { EmptyState } from "@/components/ui/empty-state";
import { SECTIONS } from "@/components/shell/sections";

export default function ProyectosPage(): React.JSX.Element {
  const section = SECTIONS.proyectos;
  return (
    <EmptyState
      icon={section.icon}
      title={section.emptyTitle}
      description={section.emptyDescription}
    />
  );
}
