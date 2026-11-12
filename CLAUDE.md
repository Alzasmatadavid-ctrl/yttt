# Web de David Alzas Coach — guía para Claude

## Librerías de componentes conectadas

El proyecto tiene conectadas cuatro librerías de componentes visuales (React + Tailwind),
todas instalables con la CLI de shadcn:

| Librería | Prefijo | Para qué usarla en la web de Kaizen |
|---|---|---|
| Magic UI | `@magicui` | Efectos llamativos: marquee de testimonios, números animados, fondos, botones con brillo |
| Smooth UI | `@smoothui` | Microinteracciones suaves: pestañas, acordeones de FAQ, transiciones |
| Unlumen UI | `@unlumen-ui` | Animaciones de texto, contadores, navbars flotantes, fondos tipo aurora |
| Neobrutalism | `@neobrutalism` | Estilo neo-brutalista: bordes gruesos, sombras duras, colores planos |

Configuración:
- `components.json` define los cuatro registros (sección `registries`).
- `.mcp.json` arranca dos servidores MCP: `shadcn` (busca, ve e instala de los cuatro registros)
  y `magicui` (servidor oficial de Magic UI).
- `.claude/settings.json` los deja aprobados para que carguen sin preguntar.

### Cómo buscar e instalar

- Buscar: herramienta `search_items_in_registries` del MCP `shadcn` con
  `registries: ["@magicui", "@smoothui", "@unlumen-ui"]`.
- **No incluyas `@neobrutalism` en búsquedas o listados**: su web no publica índice
  (`registry.json` da 404) y la búsqueda falla entera. Pide sus componentes por nombre.
- Ver un componente: `view_items_in_registries` o `npx shadcn@latest view @magicui/marquee`.
- Instalar: `npx shadcn@latest add @magicui/marquee` (requiere el proyecto React, ver abajo).

Componentes de `@neobrutalism` que existen (comprobado): accordion, alert, alert-dialog,
attachment, avatar, badge, breadcrumb, bubble, button, button-group, calendar, card, carousel,
chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, empty, field,
form, hover-card, image-card, input, input-group, input-otp, item, kbd, label, marker, marquee,
menubar, message, message-scroller, native-select, navigation-menu, pagination, popover,
progress, questionnaire, radio-group, resizable, scroll-area, select, sheet, sidebar, skeleton,
slider, spinner, switch, table, tabs, textarea, toast, toggle, toggle-group, tooltip.

## Limitación importante

`index.html` es una exportación **empaquetada** (todo comprimido dentro de un solo archivo),
no código fuente editable. Estos componentes son de React + Tailwind, así que para usarlos hay
que reconstruir la landing como proyecto Next.js en la raíz del repo. `components.json` ya
apunta a las rutas por defecto de Next.js (`app/globals.css`, alias `@/components`, `@/lib/utils`).

## Reglas de marca

- Todo en español, tono formal pero cercano.
- El producto es el método Kaizen; público: hombres de 25 a 45 años que quieren perder grasa.
- Sin promesas falsas ni resultados garantizados.
- Antes de añadir un efecto visual, pregúntate si ayuda a que el visitante confíe y reserve
  (o deje su email). Si solo decora, sobra.
