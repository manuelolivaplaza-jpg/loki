import { EmptyState } from "@/components/shell/empty-state";
import { SECTIONS } from "@/components/shell/sections";

export default function FeedPage(): React.JSX.Element {
  const section = SECTIONS.feed;
  return (
    <EmptyState
      icon={section.icon}
      title={section.emptyTitle}
      description={section.emptyDescription}
    />
  );
}
