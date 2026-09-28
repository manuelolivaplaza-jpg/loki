export function DaySeparator({ label }: { label: string }): React.JSX.Element {
  return (
    <div role="separator" aria-label={label} className="flex justify-center py-2">
      <span className="text-meta text-muted-foreground">{label}</span>
    </div>
  );
}
