import type { LucideIcon } from "lucide-react";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
};

export function EmptyState({ icon: Icon, title, description }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface">
        <Icon
          aria-hidden
          className="h-6 w-6 text-muted-foreground"
          strokeWidth={1.5}
        />
      </span>
      <h2 className="mt-4 text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xs text-[15px] leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
