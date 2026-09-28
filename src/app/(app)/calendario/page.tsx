import { EmptyState } from "@/components/shell/empty-state";
import { SECTIONS } from "@/components/shell/sections";

export default function CalendarioPage(): React.JSX.Element {
  const section = SECTIONS.calendario;
  return (
    <EmptyState
      icon={section.icon}
      title={section.emptyTitle}
      description={section.emptyDescription}
    />
  );
}
