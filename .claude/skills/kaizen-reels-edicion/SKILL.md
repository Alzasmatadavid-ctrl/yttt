---
name: kaizen-reels-edicion
description: Edición de vídeo vertical (Reels, TikTok, Shorts) con el estilo visual de David Alzas Coach / método Kaizen. Estética oscura cinematográfica, subtítulos palabra a palabra que aparecen con desenfoque, texto base en sans blanco con brillo y palabras clave en serif cursiva dorada, ganchos de "descarte" con cortes rápidos, zooms de corte y cierre con CTA. Úsala SIEMPRE que David pida editar, montar, subtitular, planificar la edición o preparar un Reel/TikTok/Short, cuando pase un guion o un vídeo en bruto para convertirlo en Reel, cuando pida un plan de edición, un brief para su editor, instrucciones de CapCut, una portada de Reel o "el estilo de mis vídeos", aunque no diga la palabra "skill" ni "edición" de forma explícita.
---

# Kaizen Reels — edición con el estilo de la marca

Esta skill convierte una idea, un guion o un vídeo en bruto en un Reel con el
estilo de David Alzas Coach. El objetivo no es solo que quede bonito: cada
decisión de edición tiene que ayudar a **retener al hombre de 25-45 años que
quiere perder grasa** y acercarlo a **Kaizen** (seguir la cuenta o comentar una
palabra para recibir un recurso).

Habla siempre en español, tono formal pero cercano, sin tecnicismos (y si usas
uno, explícalo en media frase). David parte de cero en lo técnico.

## ADN del estilo (resumen)

| Elemento | Cómo es |
|---|---|
| Formato | Vertical 9:16, 1080x1920, 30 fps, 10-45 s |
| Color | Oscuro y cinematográfico: negros profundos, sombras frías verdosas, luces cálidas, saturación contenida, viñeta y grano fino |
| Texto base | Montserrat ExtraBold, blanco, brillo blanco suave, centrado en el tercio inferior (≈66 % de altura) |
| Texto acento | Playfair Display cursiva, más grande (~1,5x), degradado crema → dorado con brillo naranja. Solo en la palabra que importa |
| Animación | Palabras que entran una a una con desenfoque + leve escala (≈0,2 s); las líneas se van acumulando |
| Planos | B-roll gran angular y cenital para el gancho, planos generales del gimnasio, plano medio-corto a cámara para hablar |
| Ritmo | Gancho con cortes cada 1-1,5 s; después cada 2-3 s; zoom de corte (100 % → 115 %) para cambiar de idea |
| Cierre | "Sígueme…" en acento dorado + captura del perfil apareciendo arriba |

Las especificaciones completas (colores exactos, tamaños, valores de color,
sonido, portada) están en `references/estilo-visual.md`. Léelo antes de dar
valores concretos.

## Flujo de trabajo

### 1. Identifica qué te ha dado David

- **Una idea o tema** → escribe el guion y el plan de edición completo.
- **Un guion escrito** → adapta el texto a pantalla y haz el plan de edición.
- **Un vídeo en bruto (+ transcripción o tiempos)** → plan de edición y, si
  hay ffmpeg disponible, render automático (paso 5).
- **Un Reel ya editado** → revísalo contra el estilo y da mejoras concretas.

Si falta algo imprescindible (por ejemplo, de qué trata el vídeo), pregunta
una sola vez y con opciones. Si no, avanza con supuestos razonables y dilos.

### 2. Elige la estructura

Lee `references/estructuras.md` y escoge la plantilla que mejor encaje
(Descarte, Lista Kaizen, Error común, Autoridad/Presentación). Di cuál eliges y
por qué en una frase.

### 3. Entrega el plan de edición con esta plantilla

```
# Reel: [título interno]
Objetivo: [atención / autoridad / captación] · Estructura: [plantilla] · Duración: [X s]
Problema que toca: [...] · Resultado que despierta: [...]

## 3 ganchos (elige uno)
1. [texto en pantalla] — [qué se ve]
2. ...
3. ...

## Guion de pantalla (listo para el programa de subtítulos)
0.0-1.5 | ! Así no perderás *grasa*
...

## Plano a plano
| Tiempo | Qué se ve (plano) | Qué se dice | Texto en pantalla | Edición (corte, zoom, efecto) | Sonido |
|---|---|---|---|---|---|

## Portada
[texto grande + tipo de portada, ver estilo-visual.md]

## CTA final (elige una)
- CTA 1 (seguir): "..." — qué gana siguiéndote
- CTA 2 (comentar palabra): "Comenta [PALABRA] y te envío [recurso]" — qué recibe exactamente

## Copy del post
[3-6 líneas + CTA]

## Checklist antes de publicar
- [ ] ...
```

Reglas para el texto en pantalla, porque son las que más afectan a la retención:

- Máximo 3-4 palabras por línea y 3 líneas por bloque. Si no cabe, divide el bloque.
- Una sola idea en acento por bloque: el problema ("barriga", "grasa") o el
  resultado ("perder grasa", "verte mejor"). Si todo es dorado, nada destaca.
- El texto de pantalla puede resumir lo que se dice; no hace falta transcribir
  cada palabra. Prioriza lo que se entiende con el móvil en silencio.
- Los números importantes van en grande (portada y listas): "10.000 pasos", "3 días".

### 4. Sin render automático: guía de CapCut o brief para editor

Si David va a editar él mismo, dale los pasos de `references/capcut.md`
adaptados a este Reel (no copies la guía entera; solo lo que necesita).
Si lo edita otra persona, entrega el plan + el "prompt de estilo" de
`references/estilo-visual.md` como brief.

### 5. Con vídeo y ffmpeg: render automático

Si tienes acceso a una terminal con ffmpeg y David te ha dado el vídeo,
puedes exportar el Reel tú mismo con `scripts/kaizen_reel.py`
(recorte 9:16, color Kaizen, zooms, subtítulos animados y audio normalizado).
Instrucciones y limitaciones en `references/render-automatico.md`.

```bash
python3 scripts/kaizen_reel.py render bruto.mp4 guion.txt -o reel.mp4 --zoom 4.8-7.0
```

Antes de entregarlo, extrae 4-6 fotogramas y míralos: comprueba que el texto
no tapa la cara ni se sale de la pantalla. Si tapa algo, usa `^` en ese bloque
o cambia `--altura`.

## Reglas de marca que no se negocian

- Kaizen es el producto y el mecanismo; el vídeo vende la transformación
  (perder grasa con mejoras progresivas y sostenibles), no sesiones sueltas.
- Nada de promesas garantizadas, cifras de kilos "aseguradas" ni antes/después
  sin contexto. Las afirmaciones de nutrición y entrenamiento, prudentes y fiables.
- Siempre una CTA clara que diga qué gana la persona.
- El estilo de edición es la referencia; el contenido, la voz y los ejemplos
  son siempre de David y de sus clientes. No copies textos ni ganchos literales
  de otras cuentas.

Antes de cerrar, pregúntate: ¿este Reel posiciona Kaizen, atrae al hombre
adecuado, genera confianza y le acerca a ser cliente? Si algo no suma, quítalo.
