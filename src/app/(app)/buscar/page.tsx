"use client";

import * as React from "react";
import { SearchScreen } from "@/components/search/search-screen";

/**
 * Búsqueda completa (`/buscar`): la abre la lupa del header móvil. Misma
 * búsqueda que la paleta de escritorio (Cmd/Ctrl+K), en pantalla completa y
 * táctil. Al ser una ruta, el botón atrás del sistema la cierra.
 */
export default function BuscarPage(): React.JSX.Element {
  return <SearchScreen />;
}
