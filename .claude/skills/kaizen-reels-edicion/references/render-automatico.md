# Render automático con `scripts/kaizen_reel.py`

Úsalo cuando haya una terminal con **Python 3** y **ffmpeg** (Claude Code,
o el entorno de código de Claude) y un vídeo en bruto.

## Qué hace
1. Recorta el vídeo a vertical 1080x1920 (sin bandas negras).
2. Aplica zooms de corte en los tramos indicados.
3. Aplica el color "Kaizen Dark".
4. Quema los subtítulos animados (base blanco + acento dorado).
5. Limpia y normaliza la voz (-14 LUFS) y exporta MP4 listo para Instagram.
6. Deja además el archivo `.ass` de subtítulos por si hay que retocarlo.

Las fuentes vienen en `assets/fonts` (licencia OFL, uso libre); no hace falta instalarlas.

## Requisitos
- Comprobar: `ffmpeg -version`.
- Si no está: Mac `brew install ffmpeg` · Windows `winget install ffmpeg` · Linux `sudo apt install ffmpeg`.

## Guion de pantalla (guion.txt)
```
# comentario
0.0-1.5   | ! Así no perderás *grasa*
1.5-3.0   | Ni así / *tampoco*
3.0-4.5   | Y así / *mucho menos.*
4.5-7.0   | Soy David / *entrenador*
7.0-11.0  | ayudo a hombres / con poco tiempo / a *perder grasa*
11.0-14.0 | ^ *sígueme* / si tú también quieres
```
- `inicio-fin` en segundos (o `m:ss.s`). Los tiempos salen de la transcripción o de ver el vídeo.
- ` / ` = salto de línea · `*palabra*` = acento dorado · `!` = gancho (más grande) · `^` = texto arriba.
- Las palabras de cada bloque se reparten en el primer 70 % del bloque; para
  sincronizar mejor con la voz, haz bloques más cortos.

## Comandos
```bash
# Solo subtítulos (para importarlos en otro editor que acepte .ass)
python3 scripts/kaizen_reel.py subs guion.txt -o subs.ass

# Reel completo
python3 scripts/kaizen_reel.py render bruto.mp4 guion.txt -o reel.mp4 --zoom 4.5-7.0,11-14

# Opciones
--paleta azul        # acento azul de la landing en vez de dorado
--altura 0.55        # mover el texto (0 = arriba, 1 = abajo; por defecto 0.66)
--zoom-factor 1.12   # intensidad del punch-in (por defecto 1.15)
--sin-etalonaje      # si el vídeo ya viene con color
```

## Comprobación obligatoria antes de entregar
```bash
for t in 1 3 6 9; do ffmpeg -v error -y -ss $t -i reel.mp4 -frames:v 1 check_$t.png; done
```
Mira los fotogramas: texto legible, sin tapar la cara, dentro de la pantalla.

## Limitaciones (dilas si aplican)
- No transcribe solo: los tiempos del guion los pones tú (o salen de una transcripción).
- Trabaja con un único vídeo. Si hay varios clips, primero se montan (CapCut o
  `ffmpeg -f concat`) y luego se pasa el resultado.
- No añade música, efectos de sonido ni la captura del perfil: eso se hace en CapCut.
