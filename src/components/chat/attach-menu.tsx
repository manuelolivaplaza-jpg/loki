"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Camera, Folder, ImagePlus, Mic } from "lucide-react";
import { MenuCard, MenuItem } from "@/components/ui/menu-card";
import { spring } from "@/lib/motion";

export type AttachOption = "photo" | "camera" | "file" | "voice";

/**
 * Menú flotante de adjuntos: foto/video, cámara, archivo y nota de voz.
 * Cierra con click afuera o Escape (lo gestiona el padre vía onClose).
 */
export function AttachMenu({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (option: AttachOption) => void;
}): React.JSX.Element {
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

  const pick = (option: AttachOption): void => {
    onSelect(option);
    onClose();
  };

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
        <MenuItem icon={ImagePlus} onClick={() => pick("photo")}>
          Foto o video
        </MenuItem>
        <MenuItem icon={Camera} onClick={() => pick("camera")}>
          Cámara
        </MenuItem>
        <MenuItem icon={Folder} onClick={() => pick("file")}>
          Archivo
        </MenuItem>
        <MenuItem icon={Mic} onClick={() => pick("voice")}>
          Nota de voz
        </MenuItem>
      </MenuCard>
    </motion.div>
  );
}
