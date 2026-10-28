#!/usr/bin/env python3
"""
Kaizen Reels — subtítulos y render con el estilo de la marca.

Dos comandos:

  subs    Convierte un "guion de pantalla" (.txt) en subtítulos .ass con el
          estilo Kaizen: palabras que aparecen una a una con desenfoque,
          texto base en sans blanco con brillo y palabras clave en serif
          cursiva dorada con brillo cálido.

  render  Toma un vídeo en bruto + el guion y exporta el Reel final en
          1080x1920: recorte vertical, etalonaje oscuro cinematográfico,
          zooms de corte opcionales, subtítulos quemados y audio normalizado.

Formato del guion de pantalla (una línea por bloque de texto):

    # comentario
    0.0-1.6   | Así no perderás *grasa*
    1.6-3.2   | Ni así / *tampoco*
    4.8-7.0   | Soy David / *especialista en*
    7.0-10.5  | ayudar a hombres / con poco tiempo / a *perder grasa*
    10.5-12.5 | ! *sígueme*

  - "inicio-fin" en segundos (también vale 0:01.5).
  - " / " fuerza salto de línea.
  - *palabras* entre asteriscos = estilo ACENTO (serif cursiva dorada).
  - "!" al principio = bloque GANCHO (texto más grande).
  - "^" al principio = bloque arriba (para no tapar la cara o un overlay).

Uso:
    python3 kaizen_reel.py subs guion.txt -o subs.ass
    python3 kaizen_reel.py render bruto.mp4 guion.txt -o reel.mp4 --zoom 3.2-4.8,9-10.5
"""

import argparse
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS_DIR = os.path.normpath(os.path.join(HERE, "..", "assets", "fonts"))

W, H = 1080, 1920

# Paleta (RGB hex). Variante "oro" = estilo de referencia; "azul" = colores de la landing.
PALETTES = {
    "oro": {
        "base": "FFFFFF",
        "base_glow": "FFF4E6",
        "accent_from": "FFF1C7",
        "accent_to": "FF9F1C",
        "accent_glow": "FF7A00",
    },
    "azul": {
        "base": "FFFFFF",
        "base_glow": "EAF5FD",
        "accent_from": "EAF5FD",
        "accent_to": "6D9CFF",
        "accent_glow": "1650C9",
    },
}

BASE_FONT = "Montserrat ExtraBold"
ACCENT_FONT = "Playfair Display SemiBold"

REVEAL_MS = 220  # duración de la aparición de cada palabra


def ass_color(hex_rgb, alpha="00"):
    """RRGGBB -> &HAABBGGRR (formato ASS)."""
    r, g, b = hex_rgb[0:2], hex_rgb[2:4], hex_rgb[4:6]
    return f"&H{alpha}{b}{g}{r}".upper()


def ass_color_tag(hex_rgb):
    r, g, b = hex_rgb[0:2], hex_rgb[2:4], hex_rgb[4:6]
    return f"&H{b}{g}{r}&".upper()


def lerp_hex(a, b, t):
    ca = [int(a[i:i + 2], 16) for i in (0, 2, 4)]
    cb = [int(b[i:i + 2], 16) for i in (0, 2, 4)]
    return "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(ca, cb))


def parse_time(s):
    s = s.strip()
    if ":" in s:
        m, sec = s.split(":", 1)
        return int(m) * 60 + float(sec)
    return float(s)


def fmt_time(t):
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def parse_script(path):
    blocks = []
    with open(path, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^([\d:.]+)\s*-\s*([\d:.]+)\s*\|\s*(.+)$", line)
            if not m:
                sys.exit(f"Línea {n} con formato incorrecto: {raw!r}\n"
                         f"Debe ser:  inicio-fin | texto")
            start, end, text = parse_time(m.group(1)), parse_time(m.group(2)), m.group(3)
            if end <= start:
                sys.exit(f"Línea {n}: el final ({end}) debe ser mayor que el inicio ({start}).")
            hook = top = False
            while text[:1] in ("!", "^"):
                hook |= text[0] == "!"
                top |= text[0] == "^"
                text = text[1:].lstrip()
            blocks.append({"start": start, "end": end, "text": text, "hook": hook, "top": top})
    if not blocks:
        sys.exit("El guion no tiene ningún bloque de texto.")
    return blocks


def tokenize(text):
    """Devuelve líneas -> lista de (palabra, es_acento)."""
    lines = []
    for chunk in text.split(" / "):
        words, accent = [], False
        for w in chunk.split():
            starts, ends = w.startswith("*"), w.endswith("*") and len(w) > 1
            if starts:
                accent = True
                w = w[1:]
            if ends or (starts and w.endswith("*")):
                w = w.rstrip("*")
                words.append((w, True))
                accent = False
                continue
            words.append((w, accent))
        lines.append(words)
    return lines


def word_markup(word, accent, pal, sizes, state, layer):
    """Etiquetas ASS de una palabra según su estado: hidden / reveal / shown."""
    font = ACCENT_FONT if accent else BASE_FONT
    size = sizes["accent"] if accent else sizes["base"]
    glow = pal["accent_glow"] if accent else pal["base_glow"]
    head = f"{{\\fn{font}\\fs{size}\\i{1 if accent else 0}"

    if layer == "glow":
        # Capa de brillo: solo contorno grueso y muy desenfocado.
        head += f"\\1a&HFF&\\3c{ass_color_tag(glow)}\\bord{9 if accent else 6}\\shad0"
        visible = "\\3a&H50&" if accent else "\\3a&H80&"
    else:
        head += "\\bord0\\shad0\\blur0.6"
        visible = "\\1a&H00&"

    if state == "hidden":
        head += "\\alpha&HFF&"
    elif state == "reveal":
        blur_end = 14 if layer == "glow" else 0.6
        head += (f"\\alpha&HFF&\\blur12\\fscx88\\fscy88"
                 f"\\t(0,{REVEAL_MS},\\alpha&H00&{visible}\\blur{blur_end}\\fscx100\\fscy100)")
    else:
        head += visible + (f"\\blur14" if layer == "glow" else "")
    head += "}"

    if layer == "text" and accent:
        # Degradado letra a letra: claro -> dorado (o azul).
        n = max(1, len(word) - 1)
        body = "".join(f"{{\\1c{ass_color_tag(lerp_hex(pal['accent_from'], pal['accent_to'], i / n))}}}{ch}"
                       for i, ch in enumerate(word))
    elif layer == "text":
        body = f"{{\\1c{ass_color_tag(pal['base'])}}}{word}"
    else:
        body = word
    return head + body


def build_ass(blocks, palette="oro", y_pos=0.66):
    pal = PALETTES[palette]
    events = []
    for b in blocks:
        lines = tokenize(b["text"])
        flat = [(li, wi) for li, ln in enumerate(lines) for wi in range(len(ln))]
        n = len(flat)
        dur = b["end"] - b["start"]
        # Las palabras entran repartidas en el primer 70 % del bloque (máx. 0,35 s entre palabras).
        step = min(0.35, (dur * 0.7) / max(1, n))
        sizes = {"base": 124 if b["hook"] else 100, "accent": 176 if b["hook"] else 148}
        y = int(H * (0.30 if b["top"] else y_pos))

        for k in range(n):
            t0 = b["start"] + k * step
            t1 = b["start"] + (k + 1) * step if k < n - 1 else b["end"]
            for layer_idx, layer in enumerate(("glow", "text")):
                parts = []
                for li, ln in enumerate(lines):
                    words = []
                    for wi, (w, acc) in enumerate(ln):
                        idx = flat.index((li, wi))
                        state = "shown" if idx < k else "reveal" if idx == k else "hidden"
                        words.append(word_markup(w, acc, pal, sizes, state, layer))
                    parts.append(" ".join(words))
                text = "\\N".join(parts)
                events.append(
                    f"Dialogue: {layer_idx},{fmt_time(t0)},{fmt_time(t1)},Kaizen,,0,0,0,,"
                    f"{{\\an5\\pos({W // 2},{y})\\q0}}{text}"
                )

    header = f"""[Script Info]
Title: Kaizen Reel
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Kaizen,{BASE_FONT},70,{ass_color(pal['base'])},{ass_color(pal['base'])},{ass_color(pal['base_glow'])},&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    return header + "\n".join(events) + "\n"


def cmd_subs(args):
    ass = build_ass(parse_script(args.guion), args.paleta, args.altura)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(ass)
    print(f"Subtítulos creados: {args.output}")


# Etalonaje "Kaizen dark": negros profundos, sombras frías verdosas, altas cálidas,
# saturación contenida, viñeta y grano fino.
GRADE = (
    "eq=contrast=1.12:brightness=-0.035:saturation=0.86:gamma=0.97,"
    "colorbalance=rs=-0.04:gs=0.01:bs=0.05:rm=-0.02:gm=0.0:bm=0.01:rh=0.04:gh=0.02:bh=-0.03,"
    "unsharp=5:5:0.35,"
    "vignette=angle=PI/5,"
    "noise=alls=5:allf=t"
)


def parse_ranges(s):
    out = []
    for part in filter(None, (p.strip() for p in (s or "").split(","))):
        a, b = part.split("-")
        out.append((parse_time(a), parse_time(b)))
    return out


def cmd_render(args):
    if not shutil.which("ffmpeg"):
        sys.exit("No encuentro ffmpeg. Instálalo primero (ver references/render-automatico.md).")

    out_dir = os.path.dirname(os.path.abspath(args.output))
    ass_path = os.path.join(out_dir, os.path.splitext(os.path.basename(args.output))[0] + ".ass")
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(build_ass(parse_script(args.guion), args.paleta, args.altura))

    # 1) Vertical 9:16 a 1080x1920 (recorte centrado, sin bandas negras).
    vf = [f"scale={W}:{H}:force_original_aspect_ratio=increase", f"crop={W}:{H}"]

    # 2) Zooms de corte ("punch-in") en los tramos indicados.
    zooms = parse_ranges(args.zoom)
    if zooms:
        cond = "+".join(f"between(t,{a},{b})" for a, b in zooms)
        z = args.zoom_factor
        vf.append(f"scale=w='{W}*if({cond},{z},1)':h='{H}*if({cond},{z},1)':eval=frame")
        vf.append(f"crop={W}:{H}")

    # 3) Etalonaje + 4) subtítulos.
    if not args.sin_etalonaje:
        vf.append(GRADE)
    esc = ass_path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    fonts = FONTS_DIR.replace(":", "\\:")
    vf.append(f"subtitles='{esc}':fontsdir='{fonts}'")
    vf.append("format=yuv420p")

    cmd = [
        "ffmpeg", "-y", "-i", args.video,
        "-vf", ",".join(vf),
        "-r", "30",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-af", "highpass=f=80,loudnorm=I=-14:TP=-1.5:LRA=11",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        args.output,
    ]
    print("Ejecutando:\n  " + " ".join(f"'{c}'" if " " in c else c for c in cmd))
    subprocess.run(cmd, check=True)
    print(f"\nReel listo: {args.output}\nSubtítulos editables: {ass_path}")


def main():
    p = argparse.ArgumentParser(description="Kaizen Reels: subtítulos y render con el estilo de marca.")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--paleta", choices=PALETTES, default="oro",
                        help="oro = estilo de referencia (por defecto); azul = colores de la landing")
    common.add_argument("--altura", type=float, default=0.66,
                        help="altura del texto (0 = arriba, 1 = abajo). Por defecto 0.66")

    s = sub.add_parser("subs", parents=[common], help="crear subtítulos .ass")
    s.add_argument("guion")
    s.add_argument("-o", "--output", default="subs.ass")
    s.set_defaults(func=cmd_subs)

    r = sub.add_parser("render", parents=[common], help="exportar el Reel final")
    r.add_argument("video")
    r.add_argument("guion")
    r.add_argument("-o", "--output", default="reel_kaizen.mp4")
    r.add_argument("--zoom", default="", help="tramos con punch-in, p. ej. 3.2-4.8,9-10.5")
    r.add_argument("--zoom-factor", type=float, default=1.15)
    r.add_argument("--sin-etalonaje", action="store_true", help="no aplicar el color Kaizen")
    r.set_defaults(func=cmd_render)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
