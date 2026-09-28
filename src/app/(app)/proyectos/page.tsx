import { ProyectosTabs, type ProyectosTab } from "@/app/(app)/proyectos/proyectos-tabs";

export default async function ProyectosPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const tab: ProyectosTab = params.tab === "ideas" ? "ideas" : "proyectos";
  return <ProyectosTabs key={tab} defaultTab={tab} />;
}
