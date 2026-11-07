# Kit de inicio · Recursos visuales para el vídeo de YouTube

Material visual para el vídeo sobre las herramientas que debería tener un cliente
nuevo de la asesoría. Son **10 clips animados, uno por herramienta**, más un clip
extra de resumen para el cierre del vídeo.

Todos comparten la misma identidad visual que tu landing: azul noche de fondo,
azul eléctrico como acento, titulares en Montserrat, palabras destacadas en
Playfair Display cursiva, y etiquetas y datos en Space Grotesk.

---

## 1. Qué hay en esta carpeta

| Carpeta | Qué contiene | Para qué te sirve |
|---|---|---|
| `videos/` | 11 vídeos MP4 (1920×1080, 30 fps, H.264) | Arrastrarlos directamente a tu editor |
| `fotogramas/` | Capturas PNG de los momentos clave de cada clip | Miniaturas, imágenes fijas o pantallas congeladas largas |
| `overlays/` | PNG con **fondo transparente**: sellos de veredicto y etiquetas de capítulo | Ponerlos encima de tus propias tomas (tú hablando a cámara, B-roll en el gimnasio) |
| `escenas/` | El "código fuente" de cada animación (HTML) | Cambiar textos o veredictos y volver a exportar |
| `render/` | El programa que convierte las escenas en vídeo | Solo si se vuelven a exportar |

---

## 2. Cómo usarlos en tu edición

1. Importa los MP4 de `videos/` en tu editor (CapCut, Premiere, DaVinci…).
2. Colócalos en la línea de tiempo cuando hables de cada herramienta.
3. Cada clip está dividido en **tramos** (ver tabla de abajo). Si tu explicación
   dura más que un tramo, haz un **corte** y **congela el fotograma**
   (en CapCut: botón derecho → *Congelar*), o reduce la velocidad al 70-80 %.
   Las animaciones tienen un ligero movimiento continuo, así que también
   puedes ralentizarlas sin que se note.
4. Todos los clips **empiezan con el fondo ya visible** y **terminan con un
   fundido al fondo**, así que puedes cortar donde quieras o encadenar con
   un fundido cruzado sin saltos bruscos.
5. Arriba de cada clip aparece el número de capítulo y una barra de progreso
   `01 / 10`. Esto ayuda a la retención: el espectador sabe en qué punto
   de la lista está.

**Consejo de retención:** alterna clip animado → tú a cámara → clip animado.
Para que la marca siga presente cuando sales tú, pon encima la etiqueta de
capítulo transparente de `overlays/capitulo-XX.png`.

---

## 3. Tramos de cada clip

Tiempos aproximados en segundos, para que sepas dónde cortar.

| # | Clip | Duración | Tramos | Veredicto |
|---|---|---|---|---|
| 01 | Zapatillas | 28 s | 0–3,5 presentación de los 3 tipos · 3,6–9 suela plana · 9,2–14,8 halterofilia · 14,9–20,6 running (prueba de carga) · 20,7–28 comparativa y veredicto | Recomendable (suela plana) |
| 02 | Straps | 24 s | 0–6 producto · 6–12,7 cómo funcionan y ejercicios de tirón · 12,6–17,4 ¿qué se cansa primero? · 17,4–24 ventajas, limitaciones y veredicto | Opcional |
| 03 | Cinturón | 24 s | 0–5,8 producto · 5,9–12,8 cómo funciona (sección de la cintura) · 12,8–18,4 cuándo tiene sentido · 18,4–24 veredicto | Opcional |
| 04 | Bandas elásticas | 25 s | 0–6 bodegón de bandas · 6,1–12,8 cuatro ventajas · 12,7–18,6 tensión de la banda y limitaciones · 18,7–25 veredicto doble | Casa: recomendable · Gimnasio: opcional |
| 05 | Báscula corporal | 25 s | 0–5,9 producto · 6–12,9 tendencia semanal · 12,9–18,8 un número que lo mezcla todo · 18,8–25 veredicto | Imprescindible |
| 06 | Bioimpedancia | 26 s | 0–7 convencional vs bioimpedancia · 7,4–13 medido vs estimado · 13,3–19,3 qué altera la lectura · 19,4–26 conclusión y veredicto | Opcional |
| 07 | Cinta métrica | 25 s | 0–4,8 producto · 5–12,9 los cinco perímetros · 12,9–18,8 mismo peso, otro cuerpo · 18,9–25 veredicto | Imprescindible |
| 08 | Trípode | 25 s | 0–6 trípode en el gimnasio · 6–12,7 visor y fotos comparables · 12,8–18,4 vídeo de técnica · 18,8–25 beneficios y veredicto | Recomendable |
| 09 | Báscula de cocina | 25 s | 0–6,3 bodegón cenital · 6,3–12,7 a ojo vs con báscula · 12,8–18,7 con el tiempo entrenas el ojo · 18,8–25 veredicto | Imprescindible (sobre todo al empezar) |
| 10 | Tuppers | 25 s | 0–6,8 composición · 6,8–14 semana organizada · 13,9–19,1 ventajas · 19,2–25 veredicto | Recomendable |
| ✓ | Resumen (extra) | 16 s | Clasificación final: imprescindible / recomendable / opcional | — |

---

## 4. Tratamiento visual de cada recurso

Cada herramienta tiene su propio formato para que no parezcan diez infografías iguales:

- **01 Zapatillas**: presentación de producto con reflejo en el suelo, vista lateral
  técnica con anotaciones y una **prueba de carga** (la suela plana no se hunde, la de
  running sí).
- **02 Straps**: anuncio de producto premium con tipografía gigante de fondo y barrido
  de luz, más un corte técnico de cómo se enrollan en la barra.
- **03 Cinturón**: composición editorial con el cinturón cruzando la pantalla y un
  diagrama animado de la presión abdominal.
- **04 Bandas**: bodegón cenital de colores, ventajas con mini-animaciones y una gráfica
  de tensión frente al peso libre.
- **05 Báscula corporal**: báscula en perspectiva sobre el suelo del baño, gráfica de
  tendencia y el número "descompuesto" en sus partes.
- **06 Bioimpedancia**: comparativa A frente a B con el pulso de corriente, una pantalla
  tipo app (medido / estimado) y los factores que alteran la lectura.
- **07 Cinta métrica**: cinta desplegándose y figura anatómica tipo holograma con los
  cinco perímetros.
- **08 Trípode**: ambiente de gimnasio desenfocado, interfaz de cámara y análisis de la
  sentadilla tipo captura de movimiento.
- **09 Báscula de cocina**: bodegón cenital sobre encimera con la báscula contando gramos.
- **10 Tuppers**: plano cenital de comidas preparadas y planificador semanal.

El **sello de veredicto** (Opcional · Recomendable · Imprescindible) se repite al final de
cada clip. Es el elemento "firma" que da coherencia a toda la serie.

---

## 5. Revisa estas decisiones antes de publicar

Tú eres el entrenador: estos veredictos son una propuesta y debes validarlos.

- **Imprescindible**: báscula corporal, cinta métrica, báscula de cocina.
- **Recomendable**: zapatillas de suela plana, trípode, tuppers, bandas (si entrenas en casa).
- **Opcional**: straps, cinturón, báscula de bioimpedancia, bandas (si entrenas en el gimnasio).

Los he planteado así porque transmiten un mensaje coherente con tu método: **lo
esencial para progresar es sencillo y barato**; lo demás se añade cuando tu caso lo
pide. Ningún accesorio sustituye a la constancia.

**Sobre los datos:** no aparece ningún porcentaje ni dato científico inventado.
- Las gráficas llevan la etiqueta *"Ejemplo ilustrativo"* o *"Esquema ilustrativo"* y no tienen números en los ejes.
- Los valores de las pantallas (`78,4 kg`, `125 g`) son ejemplos de lectura, no datos de nadie.
- Las afirmaciones son prudentes ("puede ayudarte", "estima", "es fácil equivocarse").
- No aparece ninguna marca comercial.

---

## 6. Overlays transparentes

En `overlays/` tienes PNG a pantalla completa (1920×1080) con fondo transparente:

- `veredicto-opcional.png`, `veredicto-recomendable.png`, `veredicto-imprescindible.png`:
  el sello de veredicto, ya colocado abajo en el centro.
- `capitulo-01.png` … `capitulo-10.png`: la etiqueta de capítulo y la barra de progreso,
  colocadas arriba.

Solo tienes que ponerlos en una pista **por encima** de tu vídeo. Como ya tienen el
tamaño y la posición correctos, no hace falta moverlos.

---

## 7. Cambiar un texto o un veredicto

Lo más sencillo: **pídemelo** indicando el clip y el cambio (por ejemplo, *"en el 09 pon
Recomendable en vez de Imprescindible"*) y te devuelvo el vídeo actualizado.

Si quieres hacerlo tú:

1. Abre el archivo de la escena en `escenas/` (por ejemplo `09-bascula-cocina.html`)
   con un editor de texto como VS Code.
2. Los textos están escritos tal cual en el archivo: busca la frase con `Ctrl + F`
   y cámbiala.
3. El veredicto está en una línea parecida a
   `verdict($('#verd'), 2, 'Sobre todo al empezar.', 'Báscula de cocina');`.
   El número es el nivel: `0` = Opcional, `1` = Recomendable, `2` = Imprescindible.
4. Para volver a exportar el vídeo hacen falta Node.js, Playwright y ffmpeg. Con todo
   instalado, desde la carpeta `recursos-youtube` ejecuta:
   ```
   node render/render.mjs 09
   ```
   (el número es el clip que quieres volver a exportar; sin número, exporta todos).

---

## 8. Pendiente: tus vídeos de referencia

Los tres vídeos de TikTok de referencia **no llegaron** con el encargo. La dirección
visual se ha basado en tu landing para que todo sea coherente con tu marca. Si me los
pasas, ajusto el ritmo, las transiciones o el estilo para acercarlo a esas referencias.
