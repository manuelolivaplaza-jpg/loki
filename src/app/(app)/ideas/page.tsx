import { EmptyState } from "@/components/ui/empty-state";
import { SECTIONS } from "@/components/shell/sections";

export default function IdeasPage(): React.JSX.Element {
  const section = SECTIONS.ideas;
  return (
    <EmptyState
      icon={section.icon}
      title={section.emptyTitle}
      description={section.emptyDescription}
    />
  );
}
