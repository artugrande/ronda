# Ronda

Ahorro rotativo multi-cadena en USDT0 sobre Stellar.
La vaquita de siempre, pero el contrato guarda la plata y cada uno aporta desde
la cadena donde ya tiene sus dólares.

**Argentina Builder Challenge** (BAF × Stellar) · Track Genesis
Hackathon 12 → 26/09/2026 · Checkpoints 21 y 24/09 · Submission 27/09

---

## Empezá acá

| Leé esto | Para |
|---|---|
| **[PRODUCTO.md](PRODUCTO.md)** | Qué construimos, alcance de 2 semanas, plan contra checkpoints |
| **[USDT0.md](USDT0.md)** | Direcciones mainnet y los 5 modos de falla que queman fondos |
| **[CLAUDE.md](CLAUDE.md)** | Gotchas de Soroban y direcciones testnet — se autocarga en Claude Code |
| [GAPS.md](GAPS.md) | Por qué esta idea: análisis de 812 proyectos del ecosistema |
| [EVM-GAPS.md](EVM-GAPS.md) | 50 primitivas EVM vs. Stellar |
| [IDEAS.md](IDEAS.md) | Las otras 44 ideas que descartamos |
| [SETUP.md](SETUP.md) | Toolchain y MCP |

> **El producto cambió de rumbo.** Este repo arrancó como ronda rotativa (la
> vaquita) y ese contrato sigue acá, funcionando y desplegado en testnet. Pero
> el producto que va al hackathon es **el pozo: ahorro premiado sin pérdida de
> capital**, el hueco que `GAPS.md` y `EVM-GAPS.md` marcan como el único con
> cero competidores entre 812 proyectos. Ver [§El pozo](#el-pozo).

## El pozo

`contracts/pozo/`. Todos depositan en un pozo común que se pone a generar
rendimiento. Al cierre de cada ronda **se sortea el rendimiento entero** entre
los participantes: uno se lo lleva, **nadie pierde capital**, y el capital se
puede retirar cuando sea, sin penalidad.

| Función | Quién | Qué hace |
|---|---|---|
| `depositar(usuario, monto)` | el usuario | entra al pozo y al sorteo |
| `retirar(usuario, monto)` | el usuario | saca capital, siempre, aunque haya un sorteo pendiente |
| `cerrar_ronda()` | **cualquiera** | congela chances y premio; fija una ronda de drand ≥ 10 min en el futuro |
| `ejecutar_sorteo(firma)` | **cualquiera** | verifica la firma BLS de drand on-chain, elige ganador, paga |
| `estado()` | — | participantes, total, premio, APY, countdown, ronda de drand pendiente |
| `chances_bps(usuario)` | — | "tu probabilidad", para la UI |

**El azar sale de [drand](https://drand.love)**, no de Stellar. Es un beacon
público producido por ~20 organizaciones independientes con una firma BLS
umbral, una ronda cada 3 segundos. Al cerrar se fija una ronda futura; nadie
—ni quien cierra, ni un validador de Stellar— conoce su firma todavía. Cuando
sale, cualquiera la trae y el contrato la verifica con las host functions
BLS12-381 del Protocolo 22. Sin keeper privilegiado, sin secreto que alguien
pueda perder: el premio no queda rehén de nadie.

Lo que queda como supuesto de confianza es drand mismo (haría falta que una
mayoría de sus organizaciones se coludan), y es público y verificable.

Peso = **depósito × tiempo**. Entrar un minuto antes del cierre con diez veces
más plata da menos chances que haber estado toda la ronda. La fuente de
rendimiento va detrás de una interfaz mínima (`depositar`, `retirar`,
`balance`): `contracts/mock_rendimiento/` es la de tests y demo, Blend se
enchufa detrás sin tocar el sorteo. Costo medido del sorteo con el pozo lleno
(200 participantes): ~38M instrucciones sobre un límite de 100M.

```bash
scripts/ensayo-pozo-testnet.sh     # fuente mock + pozo con la clave real de drand
cd web && SOLO_MIRAR=1 npm run keeper
```

## Estado

- ✅ Investigación cerrada, producto definido
- ✅ Workspace Soroban scaffoldeado y compilando a WASM
- ✅ 8 skills oficiales de Stellar incluidas en `.claude/skills/`
- ✅ **Contrato `pozo`** — depósitos, retiro libre, peso depósito × tiempo,
  sorteo por firma de drand verificada on-chain (BLS12-381), sin roles
  privilegiados. 32 tests, costo del sorteo medido
- ✅ Keeper permissionless del pozo (`web/scripts/keeper.ts`) y helper que
  descomprime la clave de drand para el deploy
- ⬜ **Deploy del pozo en testnet** ← el primer sorteo real es el primer test
  de la verificación BLS con una firma de drand de verdad
- ⬜ Frontend del pozo: participantes, total, APY, premio, countdown
- ⬜ Adapter real de Blend detrás de la interfaz de la fuente
- ✅ Contrato `ronda` — turnos, aportes nativos, atribución cross-chain por
  monto etiquetado, morosos y reembolso. 21 tests en verde
- ✅ Frontend mobile-first en `web/` — conectar wallet, aportar, pedir monto
  etiquetado, cerrar turno. Buildea limpio
- ✅ Indexer de entregas cross-chain en `web/scripts/indexer.ts`, con la lógica
  de atribución aislada y con tests
- ⬜ **Deploy en testnet** ← nada de esto se corrió contra la red todavía
- ⬜ **Ensayo de USDT0 en mainnet** ← hacelo primero, ver abajo

> **Lo que falta es exactamente lo que necesita red.** Todo el código compila,
> typechequea y pasa tests, pero **nunca se ejecutó contra un RPC de Stellar**:
> se escribió en una sesión con el egress a `*.stellar.org` bloqueado. Tratá el
> primer `deploy.sh testnet` como el primer test de integración, no como un
> trámite.

## El contrato

`contracts/ronda/src/lib.rs`. Cinco entrypoints:

| Función | Qué hace |
|---|---|
| `crear_ronda(oraculo, token, orden, monto_turno, periodo)` | `orden` es a la vez la lista de miembros y el orden de cobro. Rechaza montos cuyo 7º decimal no sea cero |
| `acreditar(ronda_id, miembro)` | Aporte nativo: el miembro firma y transfiere al contrato |
| `registrar_intencion(ronda_id, miembro)` | Devuelve el monto etiquetado único a mandar desde otra cadena. Idempotente |
| `confirmar_oft(ronda_id, monto_recibido, guid)` | Solo el oráculo. Machea el monto exacto contra la intención pendiente |
| `ejecutar_turno(ronda_id)` | Permissionless una vez vencido el período. Marca morosos, paga al titular lo que se juntó |
| `estado(ronda_id)` | Quién pagó, de quién es el turno, quiénes deben |

Tres decisiones que vale la pena conocer antes de tocarlo:

- **La etiqueta vive en el 6º decimal.** El paso es de 10 stroops, nunca 1: el
  OFT recorta el 7º decimal antes de armar el mensaje.
- **El contador de etiquetas no rebobina.** Una etiqueta liberada no se reusa en
  el turno siguiente, así que una entrega cross-chain que llega tarde no puede
  acreditarse al miembro equivocado.
- **El turno paga lo que se juntó, no el nominal.** El que no aporta queda
  moroso, pierde su turno futuro, y el incumplimiento queda on-chain. Si no
  queda nadie con derecho a cobrar, el turno en curso se reembolsa y la ronda
  cierra sin plata atrapada en el contrato.

## El frontend y el indexer

`web/` es una app Next.js mobile-first —la ronda se arma en el grupo de
WhatsApp y se entra desde el teléfono— más el indexer que cierra la pata
cross-chain.

```
web/src/lib/montos.ts       stroops ↔ texto, y el guard del 7º decimal
web/src/lib/atribucion.ts   a quién corresponde una entrega. Puro, con tests
web/src/lib/contrato.ts     cliente del contrato: lecturas y ciclo de escritura
web/src/lib/wallet.ts       Stellar Wallets Kit, con import dinámico por el SSR
web/scripts/indexer.ts      mira los eventos del token y llama a confirmar_oft
```

`atribucion.ts` es puro a propósito: es la parte que, si se equivoca, acredita
la plata de uno a otro. Nunca adivina — si el monto no machea exacto, o machea
con dos intenciones, no acredita y lo deja para que lo mire una persona.

## Setup local

```bash
# contrato — rust-toolchain.toml fija la versión de Rust y el target
# wasm32v1-none; rustup los instala solo al entrar al repo. No la bajes a
# mano: la ventana es angosta, ver SETUP.md §Toolchain.
cargo test && stellar contract build

# front + indexer — necesita Node >= 22.12
cd web && nvm use && npm install && cp .env.example .env.local
npm test && npm run dev
```

**Node 22.12 es piso duro, no recomendación.** Lo pide `@stellar/stellar-sdk`,
así que en Node 20 queda fuera de soporte el SDK entero: el front y el indexer.
`web/.npmrc` tiene `engine-strict=true` para que el `npm install` corte con un
error en vez de dejar un warning que se pierde en el scroll, y `.nvmrc` fija la
mayor para que `nvm use` haga lo correcto.

Deploy (testnet primero, siempre):

```bash
# El ensayo completo: identidades fondeadas, deploy, y una ronda de 3 creada.
# Imprime al final lo que va en web/.env.local.
scripts/ensayo-testnet.sh

# O solo el deploy, si ya tenés identidades:
scripts/deploy.sh testnet <identidad>   # stellar keys ls
```

El ensayo usa el SAC de **XLM nativo**, no USDC. Toda cuenta de testnet tiene
XLM del friendbot y no necesita trustline; USDC te obliga a crear trustlines
para cada miembro y a elegir bien el issuer (Circle vs. Blend — mezclarlos falla
en silencio, ver `CLAUDE.md`). Pasá a USDC cuando el flujo ya ande.

Después poné el contract id en `web/.env.local` y arrancá el indexer **sin la
key del oráculo** hasta haber comparado su salida contra el explorer:

```bash
cd web && SOLO_MIRAR=1 npm run indexer
```

El frontend está listo para Vercel: importás el repo, root directory `web`, y
las variables `NEXT_PUBLIC_*` de `.env.example`. El indexer no va a Vercel —es
un proceso largo, no una función— así que correlo donde puedas tener un daemon.

Para el CLI usá el binario precompilado, **no `cargo install`** (falla en un
build script de `libdbus-sys`). Ver [SETUP.md](SETUP.md).

## Lo primero que hay que hacer

**No hay deployment de USDT0 en testnet.** La única prueba de que el flujo
cross-chain anda es una transferencia real de centavos en mainnet. Hacela la
primera semana, no la última — si falla el 26 no hay proyecto.

Todo lo demás (contrato, turnos, morosos) se construye y testea en testnet con
USDC, que sí tiene testnet.

## Nota sobre el entorno

Estos documentos se produjeron en una sesión remota de Claude Code con el
egress bloqueado hacia `*.stellar.org` y `raven.stellar.buzz`. Se pudo escribir,
compilar y testear contratos, pero **nada de esto se ejecutó contra la red**.
Las direcciones y el comportamiento del OFT salen de la skill oficial
`stellar-cross-chain`, no de una verificación propia contra mainnet.
Verificá la derivación de la SAC antes de mover fondos:

```bash
stellar contract id asset --asset USDT0:GATISXX6... --network mainnet
# debe devolver CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF
```
