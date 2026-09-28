import { EmptyState } from "@/components/shell/empty-state";
import { SECTIONS } from "@/components/shell/sections";

export default function ChatPage(): React.JSX.Element {
  const section = SECTIONS.chat;
  return (
    <EmptyState
      icon={section.icon}
      title={section.emptyTitle}
      description={section.emptyDescription}
    />
  );
}
