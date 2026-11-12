import { useEffect, useRef, useState } from "react"
import { motion, useInView, useReducedMotion, useScroll, useSpring } from "motion/react"
import { cn } from "@/lib/utils"
import { Pieza } from "./pieza"

const PASOS = [
  {
    campo: "Campamento base",
    titulo: "Análisis profundo",
    texto:
      "Antes de empezar estudiamos tu punto de partida: objetivos, salud, historial deportivo, lesiones, hábitos y horario.",
    sostenible: "El plan parte de tu vida real, no de una vida ideal.",
  },
  {
    campo: "La ruta",
    titulo: "Plan a medida",
    texto:
      "Entrenamiento y dieta diseñados para ti y explicados en la app. Cada día sabes exactamente qué toca.",
    sostenible: "Sin alimentos prohibidos ni rutinas imposibles de cumplir.",
  },
  {
    campo: "Revisión cada 14 días",
    titulo: "Ajustes con datos",
    texto:
      "Revisamos peso, medidas, fotos y sensaciones. Si algo no avanza, se ajusta. Entre revisiones sigo tu entreno, tu cardio y tu dieta.",
    sostenible: "No esperas tres meses para saber si funciona.",
  },
  {
    campo: "La cima",
    titulo: "Quedarte arriba",
    texto:
      "El objetivo no es solo perder grasa: es recuperar la confianza y no volver al punto de partida.",
    sostenible: "Entiendes el porqué de cada decisión para poder mantenerlo tú.",
  },
]

// Puntos del sendero (coinciden con los extremos de los tramos del trazado)
const CAMPOS = [
  { x: 40, y: 500, etiqueta: "BASE" },
  { x: 150, y: 370, etiqueta: "RUTA" },
  { x: 222, y: 210, etiqueta: "REVISIÓN" },
  { x: 250, y: 64, etiqueta: "CIMA" },
]
const SENDERO =
  "M40 500 C120 480 200 470 230 440 S120 400 150 370 S260 330 225 300 S195 240 222 210 S275 165 240 130 S246 82 250 64"

function Montana({ progreso, activo }: { progreso: ReturnType<typeof useSpring> | number; activo: number }) {
  return (
    <svg viewBox="0 0 400 520" className="h-auto w-full max-w-[420px]" role="img" aria-label="Montaña con un sendero que sube por cuatro campamentos: base, ruta, revisión y cima">
      <defs>
        <linearGradient id="ladera" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#26262a" />
          <stop offset="1" stopColor="#141416" />
        </linearGradient>
      </defs>
      <polygon points="0,520 55,430 95,450 150,330 180,350 250,55 300,170 330,150 400,290 400,520" fill="url(#ladera)" stroke="rgba(245,245,242,0.22)" strokeWidth="1.5" />
      <polygon points="250,55 272,106 258,100 248,112 240,101" fill="rgba(237,235,230,0.55)" />
      <path d={SENDERO} fill="none" stroke="rgba(245,245,242,0.22)" strokeWidth="2" strokeDasharray="3 7" strokeLinecap="round" />
      <motion.path d={SENDERO} fill="none" stroke="#e63b2e" strokeWidth="3.5" strokeLinecap="round" style={{ pathLength: progreso }} />
      {CAMPOS.map((c, i) => {
        const alcanzado = i <= activo
        return (
          <g key={c.etiqueta}>
            <circle cx={c.x} cy={c.y} r={alcanzado ? 8 : 6} fill="#0b0b0c" stroke={alcanzado ? "#e63b2e" : "rgba(245,245,242,0.4)"} strokeWidth="3" style={{ transition: "all .4s ease" }} />
            <text x={c.x + 16} y={c.y + 4} fill={alcanzado ? "#f5f5f2" : "#9a9a96"} fontSize="12" fontWeight="600" letterSpacing="2" fontFamily="Inter, system-ui, sans-serif" style={{ transition: "fill .4s ease" }}>
              {c.etiqueta}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Paso({ i, paso, activo, onActivo }: { i: number; paso: (typeof PASOS)[number]; activo: boolean; onActivo: (i: number) => void }) {
  const ref = useRef<HTMLLIElement>(null)
  const enCentro = useInView(ref, { margin: "-42% 0px -42% 0px" })
  useEffect(() => {
    if (enCentro) onActivo(i)
  }, [enCentro, i, onActivo])
  return (
    <li ref={ref} className={cn("border-t border-white/12 py-10 transition-opacity duration-500 md:min-h-[46vh] md:py-14", activo ? "opacity-100" : "md:opacity-45")}>
      <p className="eyebrow text-rojo">{paso.campo}</p>
      <h3 className="titular mt-3 text-[clamp(32px,4vw,52px)]">{paso.titulo}</h3>
      <p className="texto mt-4 text-[17px] text-tinta/85">{paso.texto}</p>
      <p className="mt-4 text-[15px] text-gris">
        <span className="font-semibold text-tinta">Por qué es sostenible: </span>
        {paso.sostenible}
      </p>
    </li>
  )
}

export function Ascenso() {
  const ref = useRef<HTMLDivElement>(null)
  const reducir = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.7", "end 0.8"] })
  const progreso = useSpring(scrollYProgress, { stiffness: 110, damping: 28, mass: 0.6 })
  const [activo, setActivo] = useState(0)

  return (
    <div ref={ref} className="grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-16">
      <div className="md:sticky md:top-[calc(env(safe-area-inset-top,0px)+110px)] md:self-start">
        <Pieza lib="Código propio" nombre="montaña + motion" className="mx-auto max-w-[260px] md:max-w-[420px]">
          <Montana progreso={reducir ? 1 : progreso} activo={activo} />
        </Pieza>
      </div>
      <ol className="min-w-0">
        {PASOS.map((p, i) => (
          <Paso key={p.titulo} i={i} paso={p} activo={i === activo} onActivo={setActivo} />
        ))}
      </ol>
    </div>
  )
}
