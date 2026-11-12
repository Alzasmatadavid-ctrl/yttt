# Prototipo visual de la landing Kaizen

Página de ejemplo construida con componentes reales de las librerías conectadas:
Magic UI, Smooth UI, Unlumen UI y Neobrutalism (instalados con la CLI de shadcn).

- Diseño según la skill "Kaizen · Web inmersiva": carbón + hueso, acento rojo Kaizen,
  titulares Anton, palabra clave en Instrument Serif cursiva, texto en Inter.
- Botón "Ver piezas" (arriba a la derecha): marca cada componente con su librería.
- Fotos y cifras: sacadas de la web actual (`index.html` de la raíz). No hay datos inventados.

## Comandos

```
npm install        # instala lo necesario (solo la primera vez)
npm run dev        # abre el prototipo en local con recarga automática
npm run build      # genera dist/index.html, un único archivo con todo dentro
python3 scripts-publicar.py salida.html   # adapta ese archivo para publicarlo como Artifact
```

## Cambios hechos a componentes de terceros

- `src/components/unlumen-ui/side-by-side-slide.tsx`: ahora responde también al dedo
  (eventos de puntero) y hace un pequeño movimiento al aparecer para indicar que se desliza.
