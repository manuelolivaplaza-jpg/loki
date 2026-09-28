# Sistema de diseño único (T9 parte B)

Toda la app la diseña "la misma persona que hizo la app Grok": claro por
defecto, oscuro equivalente. Referencias: `.forja/ref/grokbot-*-ref.jpg`
(solo mirar, no modificar).

## Tokens (`src/app/globals.css`, expuestos a Tailwind con `@theme inline`)

### Radios (únicas escalas; no usar otras escalas ni radios arbitrarios)
| Token | Valor | Clase |
|---|---|---|
| `--radius-sm` | 12px | `rounded-sm` |
| `--radius-lg` | 20px | `rounded-lg` |
| `--radius-full` | 9999px | `rounded-full` |

### Sombras (únicas; no usar otras sombras ni sombras arbitrarias)
| Token | Uso | Clase |
|---|---|---|
| `--shadow-float` | Botones circulares, pastillas, menús, pills activos | `shadow-float` |
| `--shadow-overlay` | Sheets y dialogs | `shadow-overlay` |

### Espaciado
Solo múltiplos del sistema 4/8/12/16/24 (`p-1/p-2/p-3/p-4/p-6` y
equivalentes en `gap`/`m`/`px`/`py`). Evitar `2.5`, `3.5`, `5`, `7`, etc.
Los tamaños fijos de componente (avatar 52, botón 44, switch 51×31) viven
dentro de los componentes base, no en las pantallas.

### Tipografía (únicas escalas; pesos solo 400/500/600)
| Token | Tamaño / línea | Clase |
|---|---|---|
| `--text-meta` | 13px / 1.25rem | `text-meta` |
| `--text-body-sm` | 15px / 1.25rem | `text-body-sm` |
| `--text-body` | 17px / 1.5rem | `text-body` |
| `--text-title` | 20px / 1.4 | `text-title` |
| `--text-display` | 28px / 1.2 | `text-display` |

No usar tamaños arbitrarios en px, `text-xs/sm/base/xl/2xl` ni `font-bold`.

### Colores
Solo tokens: `background`, `surface`, `surface-2`, `surface-soft`,
`foreground`, `muted-foreground`, `accent (+foreground)`, `mention`,
`success`, `warning`, `danger`, `divider`. Sin hex en TSX: la paleta de
avatares vive una sola vez en `src/types/models.ts` (`AVATAR_COLORS`,
`DEFAULT_AVATAR_COLOR`, `AVATAR_FALLBACK_COLOR`) y la paleta determinista
en `src/lib/avatar-color.ts` (`AVATAR_COLOR_PALETTE`, `avatarColorFor`);
las pantallas importan esas constantes o el hook `useAuthorAvatarColor`
en vez de escribir hex. Excepción justificada: `GoogleIcon` (logo de Google con
sus 4 colores de marca) y la página `/tokens` antes mostraba hex como
documentación (reescrita sin hex: solo nombres + muestras).

### Movimiento (`src/lib/motion.ts`)
Un único spring: `{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }`
exportado como `spring`, más variantes `fadeScale`, `slideUp`, `stagger` y
`fade`. Todos los `motion.*` los usan; prohibido definir transiciones ad hoc.

### Estados (definidos una vez en `globals.css`)
- `interactive`: hover `bg-surface-soft`, pressed `scale(0.97)`,
  `focus-visible` anillo 2px accent con offset 2px. Para superficies
  transparentes, filas y menús.
- `interactive-solid`: igual pero hover con opacidad (botones con fondo
  propio). Los componentes base ya las incluyen.
- `long-press`: `user-select: none` + `-webkit-touch-callout: none` para las
  burbujas de chat, donde mantener pulsado 500ms abre reacciones y menú
  (copiar sigue siendo una acción explícita del menú).

## Iconos (`src/components/ui/icon.tsx`)
Solo `lucide-react`, `strokeWidth` 1.75 constante, tamaños 20/22/24 vía
`<Icon icon={...} size={20|22|24} />`. Nunca rellenos: el único cambio de
grosor (2.25, sin fill) es el estado `active` de navegación, definido una
sola vez en `Icon`. No importar iconos lucide directamente en pantallas.

## Componentes base (`src/components/ui/`) — usar en todas las pantallas
| Componente | Archivo | Uso |
|---|---|---|
| `Icon` | `icon.tsx` | Todo icono |
| `IconButton` | `icon-button.tsx` | Circular 44px; `floating` (blanco+sombra) / `ghost` / `accent` (+) / `solid` (negro/enviar) |
| `Pill` | `pill.tsx` | Pastilla flotante avatar/emoji + texto + chevron |
| `Card`, `CardRow`, `CardDivider` | `card.tsx` | Gris `surface-soft` `rounded-lg` sin borde; filas con divisor fino con inset |
| `ListRow` | `list-row.tsx` | Avatar 52 + título `text-body` semibold + subtítulo `text-body-sm` + meta + punto `mention`; sin separadores |
| `MenuCard`/`menuCardClass`, `MenuItem` | `menu-card.tsx` | Tarjeta flotante `rounded-lg` `shadow-float`; items 48px con Icon 22 + `text-body` (`danger` rojo) |
| `Toggle` (`Switch` re-export) | `toggle.tsx` (`switch.tsx`) | Switch iOS negro, `role=switch` + `aria-checked` |
| `Checkbox` | `checkbox.tsx` | Checkbox redondo 24px, negro al marcar, `role=checkbox` + `aria-checked` |
| `ProgressRing` | `progress-ring.tsx` | Anillo de progreso SVG propio: fondo `surface`, arco `accent`, valor al centro |
| `WeekStrip` | `week-strip.tsx` | Mini calendario semanal L–D: hoy con pastilla foreground, puntos de eventos |
| `Avatar` | `avatar.tsx` | 32/40/44/52/64; inicial + color de paleta, o emoji |
| `Button` | `button.tsx` | `primary` negro pill / `secondary` gris pill / `destructive` texto rojo |
| `EmptyState` | `empty-state.tsx` | Re-export en `shell/empty-state.tsx` por compatibilidad |
| `SectionLabel` | `section-label.tsx` | Etiqueta gris `text-meta` sobre tarjetas |
| `Dialog*`, `Popover*` | `dialog.tsx`, `popover.tsx` | Dialog `rounded-lg` `shadow-overlay`; popover con `menuCardClass` |

## Reglas de pantalla
- Sin bordes duros de 1px: solo divisores finos `bg-divider` dentro de
  `Card` (con inset `mx-4`) y la línea sidebar/contenido (`border-divider`).
- Inputs (login/registro/onboarding/espacios): `inputClassName` de
  `auth-ui` → gris `surface-soft`, `rounded-sm`, sin borde, foco anillo accent.
- Botones de formulario: `Button` pill negro (`primaryButtonClassName`
  equivale al primario).
- Selectores de prueba intactos: `name=displayName/email/password/workspaceName`,
  `type=submit`, `aria-label` "Cambiar de espacio", `menuitemradio`
  "Espacio \<nombre\>", "Crear espacio", "Familia"/"Equipo", "Menu de perfil",
  "Cerrar sesion", "Claro"/"Oscuro", "Acciones rapidas", "Nuevo", "Volver",
  "Buscar", "Cerrar", `role=switch`, `a[href^=/chat/]`.
