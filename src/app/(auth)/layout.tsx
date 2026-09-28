import type * as React from "react";

export default function AuthGroupLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="min-h-dvh bg-background text-foreground">{children}</div>
  );
}
