#!/usr/bin/env bash
# Crea fotogramas/00-hoja-de-contactos.jpg con una miniatura de cada clip (rejilla 4x3).
set -e
cd "$(dirname "$0")/../fotogramas"
F=(01-zapatillas_01 02-straps_01 03-cinturon_01 04-bandas_01 05-bascula_01 06-bioimpedancia_01
   07-cinta-metrica_02 08-tripode_01 09-bascula-cocina_01 10-tuppers_01 01-zapatillas_05 11-resumen_01)
IN=(); FC=""; L=""
for i in "${!F[@]}"; do
  IN+=(-i "${F[$i]}.png"); FC+="[$i]scale=480:270[v$i];"; L+="[v$i]"
done
ffmpeg -loglevel error -y "${IN[@]}" -filter_complex "${FC}${L}xstack=inputs=12:layout=0_0|480_0|960_0|1440_0|0_270|480_270|960_270|1440_270|0_540|480_540|960_540|1440_540" -q:v 3 00-hoja-de-contactos.jpg
echo "fotogramas/00-hoja-de-contactos.jpg"
