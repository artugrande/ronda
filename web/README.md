# web

La app de Zorrito (Next.js), el keeper serverless (`/api/keeper`) y los
scripts de terminal. La documentación vive en la [raíz del repo](../README.md).

```bash
npm install
npm run dev          # http://localhost:3000
```

| Comando | |
|---|---|
| `npm run dev` | la app: `/` es el pozo de mainnet, `/test` el de prueba, `/docs` cómo funciona |
| `npm run keeper` | cierra rondas y trae la firma de drand (arrancalo con `SOLO_MIRAR=1`) |
| `npm test` | tests de drand y montos |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |

`AGENTS.md` lo genera `create-next-app` y apunta a los docs de la versión de
Next instalada. No lo borres: esta versión tiene breaking changes respecto de lo
que la mayoría de los modelos tienen memorizado.
