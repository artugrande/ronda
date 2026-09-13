# web

Frontend mobile-first del contrato `ronda` + el indexer de entregas cross-chain.

La documentación vive en la [raíz del repo](../README.md). Lo mínimo:

```bash
npm install
cp .env.example .env.local   # y completá NEXT_PUBLIC_CONTRATO
npm run dev
```

| Comando | |
|---|---|
| `npm run dev` | la app en http://localhost:3000 |
| `npm test` | tests de la lógica de atribución y montos |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run indexer` | el watcher de `oft_received` (arrancalo con `SOLO_MIRAR=1`) |

`AGENTS.md` lo genera `create-next-app` y apunta a los docs de la versión de
Next instalada. No lo borres: esta versión tiene breaking changes respecto de lo
que la mayoría de los modelos tienen memorizado.
