import type { CSSProperties, ReactNode } from "react"
import { cn } from "@/lib/utils"

export const LIBRERIAS = {
  "Magic UI": "#ff8fb1",
  "Smooth UI": "#5eead4",
  "Unlumen UI": "#fbbf24",
  Neobrutalism: "#93c5fd",
  "Código propio": "#d4d4d0",
} as const

export type Libreria = keyof typeof LIBRERIAS

/** Envuelve un componente y, en modo "Ver piezas", muestra de qué librería sale. */
export function Pieza({
  lib,
  nombre,
  className,
  children,
}: {
  lib: Libreria
  nombre: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("pieza", className)} style={{ "--dot": LIBRERIAS[lib] } as CSSProperties}>
      {children}
      <span className="pieza-tag" aria-hidden="true">
        {lib} · {nombre}
      </span>
    </div>
  )
}
