# Proyecto Atleta — desplegar en Vercel

Esta carpeta es la web completa. `index.html` lleva dentro las fuentes,
imágenes, estilos y scripts, así que no hay build ni dependencias.

## Opción 1 — Arrastrar y soltar (lo más rápido)

1. Entra en https://vercel.com/new
2. Arrastra esta carpeta entera sobre la zona de subida.
3. Framework Preset: **Other**.
4. Deja Build Command y Output Directory vacíos.
5. Deploy.

## Opción 2 — Desde la terminal

```
npm i -g vercel
cd deploy-vercel
vercel
```

Para publicar en producción:

```
vercel --prod
```

## Opción 3 — Desde GitHub

1. Sube esta carpeta a un repositorio.
2. En Vercel: Add New > Project > importa el repo.
3. Framework Preset: **Other**. Sin build command.
4. Si la carpeta no está en la raíz del repo, pon `deploy-vercel` en Root Directory.

## Dominio propio

En el proyecto de Vercel: Settings > Domains > Add.
Vercel te dará los registros DNS que hay que poner en tu proveedor de dominio.

## Notas

- El formulario de JotForm carga desde los servidores de JotForm; necesita
  conexión a internet y es lo que hace que te lleguen las respuestas.
- Para actualizar la web: sustituye `index.html` y vuelve a desplegar.
