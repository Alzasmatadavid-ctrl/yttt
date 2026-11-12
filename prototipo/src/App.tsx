import { useEffect, useRef, useState, type FormEvent } from "react"
import { useInView } from "motion/react"
import { Activity, ArrowRight, Check, Dumbbell, Eye, EyeOff, HeartHandshake, MessageCircle, Smartphone, Utensils, X } from "lucide-react"

import { Highlighter } from "@/components/ui/highlighter"
import { ShimmerButton } from "@/components/ui/shimmer-button"
import { BlurFade } from "@/components/ui/blur-fade"
import { Marquee } from "@/components/ui/marquee"
import { NumberTicker } from "@/components/ui/number-ticker"
import { SideBySideSlide } from "@/components/unlumen-ui/side-by-side-slide"
import { MotionAccordion } from "@/components/unlumen-ui/motion-faqs-accordion"
import ScrollImageReveal from "@/components/smoothui/scroll-image-reveal"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Pieza, LIBRERIAS } from "@/components/kaizen/pieza"
import { Ascenso } from "@/components/kaizen/ascenso"

import logo from "@/assets/fotos/logo.png"
import davidHoy from "@/assets/fotos/david-retrato.webp"
import davidAntes from "@/assets/fotos/david-foto-2.webp"
import davidVolumen from "@/assets/fotos/david-foto-3.webp"
import r1Antes from "@/assets/fotos/res1-antes.webp"
import r1Despues from "@/assets/fotos/res1-despues.webp"
import r1Avatar from "@/assets/fotos/res1-avatar.webp"
import r2Antes from "@/assets/fotos/res2-antes.webp"
import r2Despues from "@/assets/fotos/res2-despues.webp"
import r2Avatar from "@/assets/fotos/res2-avatar.webp"
import r3Antes from "@/assets/fotos/res3-antes.webp"
import r3Despues from "@/assets/fotos/res3-despues.webp"
import r3Avatar from "@/assets/fotos/res3-avatar.webp"

const irAValoracion = () => document.getElementById("valoracion")?.scrollIntoView({ behavior: "smooth", block: "start" })

/* ---------- Datos ---------- */

const DOLORES = [
  { frase: "«El lunes empiezo.»", texto: "Siempre hay un lunes nuevo, una cena, un viaje o un mal día. Y el cambio nunca llega." },
  { frase: "«Lo he probado todo.»", texto: "Dietas de internet, retos de influencers, rutinas de apps. Empiezas motivado y acabas en el punto de partida." },
  { frase: "«No me gusta lo que veo.»", texto: "La ropa aprieta, evitas ciertas fotos y sientes que has perdido la confianza en ti mismo." },
  { frase: "«No tengo tiempo.»", texto: "El trabajo, el cansancio o la falta de tiempo acaban ganando siempre. Nunca llega el momento perfecto." },
  { frase: "«Me dicen que estoy bien así.»", texto: "Pero tú notas menos energía, menos confianza y la sensación de que podrías estar mucho mejor." },
  { frase: "«Cada año me cuesta más.»", texto: "Más grasa, menos músculo, menos energía. Si no haces algo ahora, dentro de un año estarás igual." },
]

const RESULTADOS = [
  {
    nombre: "Iván",
    edad: "22 años",
    rol: "Socorrista · nadador máster y absoluto",
    dato: "−9 kg · 1 mes y medio",
    antes: r2Antes,
    despues: r2Despues,
    avatar: r2Avatar,
    cita: "Por mi trabajo y horarios pensaba que bajar de grasa era casi imposible. Gracias a David entendí que no necesitaba hacerlo perfecto: necesitaba un plan adaptado a mi vida.",
  },
  {
    nombre: "Juan Pablo",
    edad: "21 años",
    rol: "Estudiante de universidad y teatro · monitor de natación",
    dato: "−5 kg · 1 mes y 2 semanas",
    antes: r3Antes,
    despues: r3Despues,
    avatar: r3Avatar,
    cita: "Entre la universidad, el teatro y mi trabajo pensaba que era imposible mejorar mi físico. He perdido grasa y he comprobado que se puede avanzar incluso con poco tiempo.",
  },
  {
    nombre: "David Alzas",
    edad: "Creador de Kaizen",
    rol: "Entrenador · CPE Fit Generation",
    dato: "−25 kg · 9 meses",
    antes: r1Antes,
    despues: r1Despues,
    avatar: r1Avatar,
    cita: "Pasé de entrenar sin rumbo y frustrarme por no ver cambios a entender cómo transformar mi físico de verdad. Por eso creé este método.",
  },
]

const INCLUYE = [
  { icono: Dumbbell, titulo: "Entrenamiento diseñado para ti", texto: "Según tu nivel, tu material y los días que puedes entrenar. Cada ejercicio con vídeo." },
  { icono: Utensils, titulo: "Dieta que puedes sostener", texto: "Sin alimentos prohibidos ni tuppers tristes. Adaptamos las calorías a tu vida." },
  { icono: Activity, titulo: "Revisiones con datos", texto: "Peso, medidas, fotos y sensaciones cada 14 días. Si algo no avanza, se ajusta." },
  { icono: MessageCircle, titulo: "Contacto directo conmigo", texto: "Me escribes y te respondo yo. Sin equipos, sin bots y sin plantillas." },
  { icono: Smartphone, titulo: "Todo en una sola app", texto: "Entrenos, dieta, progreso y revisiones en el mismo sitio. Abres el móvil y sabes qué toca." },
  { icono: HeartHandshake, titulo: "Acompañamiento continuo", texto: "Te explico el porqué de cada decisión para que confíes en el proceso." },
]

const ES_PARA_TI = [
  "Quieres perder grasa y mantenerla, no bajar seis kilos y recuperarlos en verano.",
  "Puedes entrenar entre uno y seis días a la semana, aunque sea en casa.",
  "Estás dispuesto a seguir el plan también las semanas en las que no apetece.",
]
const NO_ES_PARA_TI = [
  "Buscas perder diez kilos en tres semanas.",
  "Quieres una rutina genérica y barata para descargar y olvidar.",
  "No piensas registrar tus datos ni hablar conmigo durante el proceso.",
]

const FAQS = [
  { question: "No tengo tiempo. ¿Kaizen es para mí?", answer: "Kaizen se diseña sobre tu horario real: puedes entrenar entre uno y seis días por semana, en casa o en el gimnasio. Empezamos por lo que puedes sostener y vamos sumando." },
  { question: "Ya he fallado otras veces. ¿Por qué ahora sería distinto?", answer: "Porque no dependes de la motivación. Revisamos tus datos cada 14 días, ajustamos el plan si algo no avanza y tienes contacto directo conmigo entre revisiones." },
  { question: "¿Tengo que dejar de comer lo que me gusta?", answer: "No hay alimentos prohibidos. Adaptamos las calorías a tu vida, no tu vida a las calorías." },
  { question: "¿Y si viajo o tengo una semana caótica?", answer: "Se adapta el plan para esa semana. La idea es hacer lo posible, no lo perfecto, y no romper la constancia." },
  { question: "Tengo más de 40 años. ¿Llego tarde?", answer: "No. El análisis inicial tiene en cuenta tu edad, tu historial y tus lesiones, y el plan se construye a partir de ahí." },
  { question: "¿Cuánto cuesta?", answer: "Depende de tu punto de partida y del acompañamiento que necesites. Te lo explico en la valoración gratuita, sin compromiso." },
]

/* ---------- Piezas pequeñas ---------- */

function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`eyebrow ${className}`}>{children}</p>
}

function CtaPrincipal({ texto = "Solicitar mi valoración gratuita" }: { texto?: string }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Pieza lib="Magic UI" nombre="shimmer-button" className="w-full sm:w-auto">
        <ShimmerButton onClick={irAValoracion} background="#e63b2e" shimmerColor="#ffffff" borderRadius="4px" shimmerDuration="2.6s" className="btn-kaizen w-full whitespace-normal border-0 text-center text-carbon sm:w-auto">
          {texto} <ArrowRight className="size-5" aria-hidden="true" />
        </ShimmerButton>
      </Pieza>
      <p className="text-[14px] text-gris">Gratis · 15 minutos · sin compromiso</p>
    </div>
  )
}

/* ---------- Página ---------- */

export default function App() {
  const [piezas, setPiezas] = useState(false)
  const [enviado, setEnviado] = useState(false)
  const [objetivo, setObjetivo] = useState("Perder grasa")
  const heroRef = useRef<HTMLElement>(null)
  const formRef = useRef<HTMLElement>(null)
  const heroVisible = useInView(heroRef, { margin: "0px 0px -20% 0px" })
  const formVisible = useInView(formRef, { margin: "0px 0px -30% 0px" })

  useEffect(() => {
    document.documentElement.dataset.piezas = piezas ? "on" : "off"
  }, [piezas])

  const enviar = (e: FormEvent) => {
    e.preventDefault()
    setEnviado(true)
  }

  return (
    <>
      {/* NAVEGACIÓN */}
      <header className="sticky top-[env(safe-area-inset-top,0px)] z-50 border-b border-white/8 bg-carbon/85 backdrop-blur-md">
        <div className="wrap flex h-16 items-center justify-between gap-3">
          <a href="#inicio" className="flex items-center gap-3" aria-label="Kaizen, inicio">
            <img src={logo} alt="" className="size-9 rounded-full object-cover" />
            <span className="titular text-[22px] leading-none tracking-wide">Kaizen</span>
            <span className="hidden text-[13px] text-gris sm:inline">por David Alzas</span>
          </a>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPiezas((v) => !v)} aria-pressed={piezas} className="inline-flex h-10 items-center gap-2 rounded-full border border-white/20 px-3.5 text-[13px] font-semibold text-tinta transition hover:border-white/50">
              {piezas ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              <span className="hidden sm:inline">{piezas ? "Ocultar piezas" : "Ver piezas"}</span>
              <span className="sm:hidden">Piezas</span>
            </button>
            <button type="button" onClick={irAValoracion} className="hidden h-10 items-center rounded-[4px] bg-rojo px-4 text-[13px] font-bold uppercase tracking-wider text-carbon md:inline-flex">
              Valoración gratuita
            </button>
          </div>
        </div>
      </header>

      {/* LEYENDA del modo piezas */}
      {piezas && (
        <aside className="fixed z-40 rounded-xl border border-white/15 bg-carbon/95 p-4 text-[13px] shadow-2xl backdrop-blur max-md:top-[calc(env(safe-area-inset-top,0px)+72px)] max-md:right-[max(12px,env(safe-area-inset-right,0px))] md:bottom-[calc(20px+env(safe-area-inset-bottom,0px))] md:right-[max(20px,env(safe-area-inset-right,0px))]" aria-label="Leyenda de librerías">
          <p className="mb-2 font-semibold text-tinta">Cada pieza, su librería</p>
          <ul className="grid gap-1.5">
            {Object.entries(LIBRERIAS).map(([nombre, color]) => (
              <li key={nombre} className="flex items-center gap-2 text-gris">
                <span className="size-2.5 rounded-full" style={{ background: color }} />
                <span className="text-tinta">{nombre}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}

      <main>
        {/* 1 · HERO */}
        <section id="inicio" ref={heroRef} className="relative overflow-hidden">
          <div className="pointer-events-none absolute -top-40 right-[-10%] size-[620px] rounded-full bg-rojo/10 blur-[120px]" aria-hidden="true" />
          <div className="wrap relative grid items-center gap-10 pb-16 pt-10 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] md:gap-12 md:pb-24 md:pt-20">
            <div className="min-w-0">
              <BlurFade delay={0.05}>
                <Eyebrow className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gris">
                  <span className="font-serif text-[18px] not-italic tracking-normal text-rojo" lang="ja">改善</span>
                  Método Kaizen · Pérdida de grasa para hombres de 25 a 45
                </Eyebrow>
              </BlurFade>
              <BlurFade delay={0.12}>
                <h1 className="titular titular-hero mt-5">
                  Llevas años prometiéndote un cambio que{" "}
                  <Pieza lib="Magic UI" nombre="highlighter" className="inline-block">
                    <Highlighter action="underline" color="#e63b2e" strokeWidth={4} iterations={2} padding={2} animationDuration={900}>
                      <span className="serif-i">nunca</span>
                    </Highlighter>
                  </Pieza>{" "}
                  llega.
                </h1>
              </BlurFade>
              <BlurFade delay={0.2}>
                <p className="texto mt-6 text-[18px] text-tinta/85 md:text-[19px]">
                  Kaizen es el método 1 a 1 para hombres que ya lo han intentado solos. Sin dietas extremas: <strong className="font-semibold text-tinta">pequeñas mejoras, cada semana, que sí puedes mantener.</strong>
                </p>
              </BlurFade>
              <BlurFade delay={0.28} className="mt-8">
                <CtaPrincipal />
              </BlurFade>
            </div>
            <BlurFade delay={0.2} className="min-w-0">
              <figure className="relative mx-auto max-w-[440px]">
                <img src={davidHoy} alt="David Alzas, creador del método Kaizen, en el gimnasio" className="aspect-[4/5] w-full rounded-[4px] object-cover object-top" />
                <figcaption className="absolute bottom-4 left-4 right-4 flex items-end justify-between gap-3">
                  <span className="rounded-[4px] bg-carbon/85 px-3 py-2 text-[13px] leading-snug backdrop-blur">
                    <strong className="block font-semibold">David Alzas</strong>
                    <span className="text-gris">Creador de Kaizen</span>
                  </span>
                  <span className="titular rounded-[4px] bg-rojo px-3 py-2 text-[22px] leading-none text-carbon">−25 kg</span>
                </figcaption>
              </figure>
            </BlurFade>
          </div>
        </section>

        {/* Banda de principios */}
        <Pieza lib="Magic UI" nombre="marquee">
          <div className="border-y-2 border-carbon bg-rojo py-3 text-carbon">
            <Marquee className="[--duration:32s] [--gap:2.5rem]" repeat={3}>
              {["Sin dietas extremas", "Sin rutinas genéricas", "Sin retos de 21 días", "Pequeñas mejoras cada semana", "Resultados que se mantienen"].map((t) => (
                <span key={t} className="titular flex items-center gap-10 text-[clamp(22px,3vw,34px)]">
                  {t} <span aria-hidden="true">✕</span>
                </span>
              ))}
            </Marquee>
          </div>
        </Pieza>

        {/* 2 · PROBLEMA */}
        <section className="escena bg-hueso text-carbon">
          <div className="wrap">
            <Eyebrow className="text-rojo">El problema</Eyebrow>
            <h2 className="titular titular-seccion mt-4 max-w-[16ch]">
              ¿Te suena alguna de <span className="serif-i">estas</span>?
            </h2>
            <p className="texto mt-5 text-[18px] text-carbon/70">No necesitas identificarte con todas. Con una sola ya sabes que es el momento de actuar.</p>
            <div className="mt-12 grid gap-x-10 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {DOLORES.map((d, i) => (
                <Pieza key={d.frase} lib="Magic UI" nombre="blur-fade">
                  <BlurFade inView delay={0.06 * i} className="h-full border-t-2 border-carbon pb-6 pt-5">
                    <h3 className="titular text-[30px] leading-none">{d.frase}</h3>
                    <p className="mt-3 text-[16px] text-carbon/75">{d.texto}</p>
                  </BlurFade>
                </Pieza>
              ))}
            </div>
          </div>
        </section>

        {/* PUENTE · MI HISTORIA */}
        <section className="escena">
          <div className="wrap grid gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-16">
            <div className="grid min-w-0 grid-cols-3 items-end gap-3 self-center sm:gap-4">
              {[
                { src: davidAntes, label: "Antes", alt: "David antes de entrenar con método, muy delgado", dir: "up" as const, h: "aspect-[3/5]" },
                { src: davidVolumen, label: "El «volumen»", alt: "David en su etapa de volumen, con más grasa que músculo", dir: "up" as const, h: "aspect-[3/4.4]" },
                { src: davidHoy, label: "Hoy", alt: "David en la actualidad", dir: "up" as const, h: "aspect-[3/4]" },
              ].map((f) => (
                <figure key={f.label} className="min-w-0">
                  <Pieza lib="Smooth UI" nombre="scroll-image-reveal">
                    <ScrollImageReveal src={f.src} alt={f.alt} mask="curtain" direction={f.dir} once rounded="rounded-[4px]" parallax={30} className={`w-full ${f.h}`} />
                  </Pieza>
                  <figcaption className="eyebrow mt-3 text-gris">{f.label}</figcaption>
                </figure>
              ))}
            </div>
            <div className="min-w-0 self-center">
              <Eyebrow className="text-rojo">Mi historia</Eyebrow>
              <h2 className="titular titular-seccion mt-4">
                Sé lo que se siente. Yo estuve <span className="serif-i">ahí</span>.
              </h2>
              <div className="mt-6 grid gap-4 text-[17px] text-tinta/80">
                <p className="texto">Siempre fui un chico delgado. Empecé a entrenar con 18 años siguiendo rutinas de amigos e influencers, pero mi físico apenas cambiaba. Intenté ganar peso por mi cuenta y acabé ganando más grasa que músculo.</p>
                <p className="texto">Entendí que no me faltaban ganas: me faltaba un método adaptado a mí. Me formé en biomecánica, fisiología y ciencia del entrenamiento (CPE de Fit Generation) y de ahí nació Kaizen.</p>
              </div>
              <Pieza lib="Magic UI" nombre="number-ticker" className="mt-10">
                <dl className="grid grid-cols-3 gap-4 border-t border-white/12 pt-6">
                  {[
                    { pre: "+", valor: 40, post: "", label: "kg perdidos" },
                    { pre: "+", valor: 30, post: "", label: "transformaciones" },
                    { pre: "", valor: 100, post: "%", label: "personalizado" },
                  ].map((s) => (
                    <div key={s.label} className="min-w-0">
                      <dt className="sr-only">{s.label}</dt>
                      <dd className="titular text-[clamp(40px,5vw,64px)] leading-none">
                        <span className="text-rojo">{s.pre}</span>
                        <NumberTicker value={s.valor} className="tracking-normal text-tinta dark:text-tinta" />
                        <span className="text-rojo">{s.post}</span>
                      </dd>
                      <p className="mt-2 text-[10px] font-semibold uppercase leading-tight tracking-[0.05em] text-gris [overflow-wrap:anywhere] sm:text-[12px] sm:tracking-[0.14em]">{s.label}</p>
                    </div>
                  ))}
                </dl>
              </Pieza>
            </div>
          </div>
        </section>

        {/* 3 · MECANISMO · EL ASCENSO */}
        <section className="escena bg-carbon-2">
          <div className="wrap">
            <div className="max-w-[820px]">
              <Eyebrow className="text-rojo">El método Kaizen</Eyebrow>
              <h2 className="titular titular-seccion mt-4">
                Una montaña se sube <span className="serif-i">paso a paso</span>.
              </h2>
              <p className="texto mt-5 text-[18px] text-tinta/80">
                <span lang="ja">改善</span> (kaizen) significa «mejora continua». No te pido un cambio radical el lunes: te pido el siguiente paso, y luego el siguiente.
              </p>
            </div>
            <div className="mt-12 md:mt-16">
              <Ascenso />
            </div>
            <div className="mt-6">
              <CtaPrincipal texto="Empezar mi ascenso" />
            </div>
          </div>
        </section>

        {/* 4 · PRUEBAS */}
        <section className="escena bg-hueso text-carbon">
          <div className="wrap">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <Eyebrow className="text-rojo">Resultados reales</Eyebrow>
                <h2 className="titular titular-seccion mt-4 max-w-[15ch]">
                  Ellos estaban donde tú estás <span className="serif-i">ahora</span>.
                </h2>
              </div>
              <p className="max-w-[34ch] text-[15px] text-carbon/65">Desliza sobre cada foto para comparar el antes y el después.</p>
            </div>

            <div className="mt-12 grid gap-8 md:grid-cols-3">
              {RESULTADOS.map((r) => (
                <Pieza key={r.nombre} lib="Neobrutalism" nombre="card + badge">
                  <Card className="h-full gap-0 overflow-hidden py-0">
                    <Pieza lib="Unlumen UI" nombre="side-by-side-slide" className="border-b-2 border-border">
                      <SideBySideSlide beforeImage={r.antes} afterImage={r.despues} beforeAlt={`${r.nombre} antes`} afterAlt={`${r.nombre} después`} className="aspect-[4/5] w-full bg-carbon" dividerColor="#e63b2e" dividerWidth={3} handleColor="#e63b2e" handleSize={34} cursor="col-resize" hint />
                      <span className="pointer-events-none absolute bottom-3 left-3 rounded-[4px] bg-carbon/80 px-2 py-1 text-[11px] font-bold tracking-widest text-tinta">ANTES</span>
                      <span className="pointer-events-none absolute bottom-3 right-3 rounded-[4px] bg-carbon/80 px-2 py-1 text-[11px] font-bold tracking-widest text-tinta">DESPUÉS</span>
                    </Pieza>
                    <div className="flex flex-1 flex-col gap-4 p-5">
                      <Badge className="bg-main px-3 py-1 text-[13px] font-bold">{r.dato}</Badge>
                      <div className="flex items-center gap-3">
                        <img src={r.avatar} alt="" className="size-11 rounded-full border-2 border-border object-cover" />
                        <div>
                          <p className="font-heading text-[17px] leading-tight">{r.nombre}</p>
                          <p className="text-[13px] text-carbon/60">{r.edad}</p>
                        </div>
                      </div>
                      <blockquote className="text-[15px] leading-relaxed text-carbon/85">“{r.cita}”</blockquote>
                      <p className="mt-auto text-[12px] text-carbon/55">{r.rol}</p>
                    </div>
                  </Card>
                </Pieza>
              ))}
            </div>
            <p className="mt-6 text-[13px] text-carbon/55">Resultados individuales. Dependen del punto de partida y de la constancia de cada persona.</p>
            <div className="mt-10">
              <Pieza lib="Neobrutalism" nombre="button" className="inline-block">
                <Button onClick={irAValoracion} className="btn-kaizen h-auto">
                  Quiero resultados como estos <ArrowRight aria-hidden="true" />
                </Button>
              </Pieza>
            </div>
          </div>
        </section>

        {/* 5 · QUÉ INCLUYE */}
        <section className="escena">
          <div className="wrap">
            <Eyebrow className="text-rojo">Qué incluye</Eyebrow>
            <h2 className="titular titular-seccion mt-4 max-w-[18ch]">
              Todo lo que necesitas. Nada que no vayas a <span className="serif-i">usar</span>.
            </h2>
            <p className="texto mt-5 text-[18px] text-tinta/80">No compras una rutina en PDF. Entras en un sistema donde cada pieza está pensada para tu cuerpo, tu horario y tu punto de partida.</p>
            <ul className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {INCLUYE.map(({ icono: Icono, titulo, texto }) => (
                <li key={titulo} className="border-t border-white/12 pt-6">
                  <Icono className="size-7 text-rojo" strokeWidth={1.8} aria-hidden="true" />
                  <h3 className="mt-4 text-[20px] font-semibold leading-snug">{titulo}</h3>
                  <p className="mt-2 text-[16px] text-tinta/70">{texto}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 6 · PARA QUIÉN */}
        <section className="escena bg-rojo text-carbon">
          <div className="wrap">
            <h2 className="titular titular-seccion max-w-[14ch]">
              ¿Encajas en <span className="serif-i">Kaizen</span>?
            </h2>
            <div className="mt-10 grid gap-8 md:grid-cols-2">
              <Pieza lib="Neobrutalism" nombre="card">
                <Card className="h-full px-6">
                  <h3 className="titular text-[30px]">Es para ti si…</h3>
                  <ul className="grid gap-4">
                    {ES_PARA_TI.map((t) => (
                      <li key={t} className="flex gap-3 text-[16px]">
                        <Check className="mt-0.5 size-5 shrink-0 rounded-[3px] border-2 border-border bg-main p-0.5" aria-hidden="true" />
                        {t}
                      </li>
                    ))}
                  </ul>
                </Card>
              </Pieza>
              <Pieza lib="Neobrutalism" nombre="card">
                <Card className="h-full bg-carbon px-6 text-tinta">
                  <h3 className="titular text-[30px]">No es para ti si…</h3>
                  <ul className="grid gap-4">
                    {NO_ES_PARA_TI.map((t) => (
                      <li key={t} className="flex gap-3 text-[16px] text-tinta/85">
                        <X className="mt-0.5 size-5 shrink-0 rounded-[3px] border-2 border-tinta/60 p-0.5" aria-hidden="true" />
                        {t}
                      </li>
                    ))}
                  </ul>
                </Card>
              </Pieza>
            </div>
            <div className="mt-10">
              <Pieza lib="Neobrutalism" nombre="button" className="inline-block">
                <Button variant="neutral" onClick={irAValoracion} className="btn-kaizen h-auto">
                  Quiero saber si encajo <ArrowRight aria-hidden="true" />
                </Button>
              </Pieza>
              <p className="mt-3 text-[14px] text-carbon/75">Valoración gratuita · te respondo yo, no una IA</p>
            </div>
          </div>
        </section>

        {/* 7 · OBJECIONES */}
        <section className="escena bg-hueso text-carbon">
          <div className="wrap grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <div className="min-w-0">
              <Eyebrow className="text-rojo">Preguntas frecuentes</Eyebrow>
              <h2 className="titular titular-seccion mt-4">
                Las dudas de <span className="serif-i">siempre</span>.
              </h2>
              <p className="mt-5 text-[16px] text-carbon/65">Si la tuya no está aquí, pregúntamela en la valoración.</p>
            </div>
            <Pieza lib="Unlumen UI" nombre="motion-faqs-accordion" className="min-w-0">
              <MotionAccordion items={FAQS} gap={10} className="[&>div]:p-0" />
            </Pieza>
          </div>
        </section>

        {/* 8 · OFERTA + FORMULARIO */}
        <section id="valoracion" ref={formRef} className="escena relative overflow-hidden scroll-mt-16">
          <div className="pointer-events-none absolute -bottom-52 left-[-10%] size-[620px] rounded-full bg-rojo/10 blur-[120px]" aria-hidden="true" />
          <div className="wrap relative grid gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-16">
            <div className="min-w-0">
              <Eyebrow className="text-rojo">Da el paso</Eyebrow>
              <h2 className="titular titular-seccion mt-4">
                Tu ascenso empieza <span className="serif-i">aquí</span>.
              </h2>
              <p className="texto mt-5 text-[18px] text-tinta/80">Rellena el formulario y descubrirás si Kaizen es el método adecuado para ti.</p>

              <div className="mt-10 rounded-[4px] border-2 border-rojo p-6">
                <p className="eyebrow text-rojo">Garantía Kaizen</p>
                <h3 className="titular mt-3 text-[clamp(26px,3vw,36px)]">Si cumples tu parte y no hay resultados, te devuelvo el 100 %.</h3>
                <ul className="mt-5 grid gap-2.5 text-[15px] text-tinta/85 sm:grid-cols-2">
                  {["Sigues los entrenamientos del plan", "Registras tu dieta y tus datos en la app", "Acudes a todas las revisiones", "Mantienes la comunicación conmigo"].map((t) => (
                    <li key={t} className="flex gap-2.5">
                      <Check className="mt-0.5 size-4 shrink-0 text-rojo" aria-hidden="true" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>

              <ol className="mt-10 grid gap-5 sm:grid-cols-3">
                {[
                  "Leo tu solicitud yo mismo y te escribo en menos de 48 h.",
                  "Hablamos sin coste para ver tu punto de partida.",
                  "Si es un sí, empiezas. Si no lo es, te lo digo igual.",
                ].map((t, i) => (
                  <li key={t} className="border-t border-white/12 pt-4">
                    <span className="titular text-[28px] text-rojo">0{i + 1}</span>
                    <p className="mt-2 text-[15px] text-tinta/75">{t}</p>
                  </li>
                ))}
              </ol>
            </div>

            <Pieza lib="Neobrutalism" nombre="card + input + button" className="min-w-0 self-start">
              <Card className="px-6 [--shadow:8px_8px_0px_0px_var(--rojo)]">
                {enviado ? (
                  <div className="grid gap-3 py-6" role="status">
                    <p className="titular text-[34px]">¡Recibido!</p>
                    <p className="text-[15px] text-carbon/75">Esto es un prototipo: en la web real, tu solicitud llegará a tu JotForm y David te escribirá en menos de 48 h.</p>
                    <Button variant="neutral" onClick={() => setEnviado(false)} className="mt-2 w-fit">
                      Volver al formulario
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={enviar} className="grid gap-5">
                    <div>
                      <p className="titular text-[30px] leading-none">Valoración gratuita</p>
                      <p className="mt-2 text-[14px] text-carbon/65">Unos 15 minutos · sin compromiso · plazas limitadas</p>
                    </div>
                    <label className="grid gap-1.5 text-[14px] font-semibold" htmlFor="nombre">
                      Nombre
                      <Input id="nombre" name="nombre" autoComplete="given-name" required placeholder="Tu nombre" className="h-12 text-[16px]" />
                    </label>
                    <label className="grid gap-1.5 text-[14px] font-semibold" htmlFor="whatsapp">
                      WhatsApp
                      <Input id="whatsapp" name="whatsapp" type="tel" autoComplete="tel" required placeholder="+34 600 000 000" className="h-12 text-[16px]" />
                    </label>
                    <fieldset className="grid gap-2">
                      <legend className="mb-1.5 text-[14px] font-semibold">Tu objetivo</legend>
                      {["Perder grasa", "Perder grasa y ganar músculo", "Recuperar hábitos y energía"].map((o) => (
                        <label key={o} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-base border-2 border-border px-3 text-[15px] transition ${objetivo === o ? "bg-main font-semibold" : "bg-secondary-background"}`}>
                          <input type="radio" name="objetivo" value={o} checked={objetivo === o} onChange={() => setObjetivo(o)} className="size-4 accent-carbon" />
                          {o}
                        </label>
                      ))}
                    </fieldset>
                    <Button type="submit" className="btn-kaizen h-auto w-full">
                      Solicitar mi valoración <ArrowRight aria-hidden="true" />
                    </Button>
                    <p className="text-[12px] text-carbon/55">Te responderé yo personalmente, no un bot.</p>
                  </form>
                )}
              </Card>
            </Pieza>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 pb-28 pt-10 md:pb-10">
        <div className="wrap flex flex-wrap items-center justify-between gap-4 text-[13px] text-gris">
          <p>
            <span className="titular mr-2 text-[18px] text-tinta">Kaizen</span>© 2026 David Alzas · Método Kaizen de pérdida de grasa
          </p>
          <p>Prototipo visual · las respuestas de las FAQ son una propuesta</p>
        </div>
      </footer>

      {/* CTA fijo en móvil (aparece después del hero) */}
      <div className={`fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-carbon/95 pb-[calc(12px+env(safe-area-inset-bottom,0px))] pl-[max(16px,env(safe-area-inset-left,0px))] pr-[max(16px,env(safe-area-inset-right,0px))] pt-3 backdrop-blur transition-transform duration-300 md:hidden ${!heroVisible && !formVisible ? "translate-y-0" : "translate-y-full"}`}>
        <button type="button" onClick={irAValoracion} className="btn-kaizen w-full rounded-[4px] bg-rojo text-carbon">
          Valoración gratuita <ArrowRight className="size-5" aria-hidden="true" />
        </button>
      </div>
    </>
  )
}
