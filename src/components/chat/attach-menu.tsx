"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Camera, Folder, ImagePlus } from "lucide-react";
import { MenuCard, MenuItem } from "@/components/ui/menu-card";
import { spring } from "@/lib/motion";

/**
 * Menú flotante de adjuntos. En T13 las tres opciones están
 * deshabilitadas con el aviso "Los adjuntos llegan pronto".
 * Cierra con click afuera o Escape (lo gestiona el padre vía onClose).
 */
export function AttachMenu({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label="Adjuntar"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 12 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 12 }}
      transition={spring}
      className="absolute bottom-full left-0 z-30 mb-2 w-64"
    >
      <MenuCard>
        <MenuItem icon={Folder} disabled aria-disabled="true" title="Próximamente">
          Elegir archivo
        </MenuItem>
        <MenuItem icon={Camera} disabled aria-disabled="true" title="Próximamente">
          Hacer una foto
        </MenuItem>
        <MenuItem icon={ImagePlus} disabled aria-disabled="true" title="Próximamente">
          Adjuntar imagen
        </MenuItem>
        <p className="px-3 py-2 text-meta leading-5 text-muted-foreground">
          Los adjuntos llegan pronto
        </p>
      </MenuCard>
    </motion.div>
  );
}
