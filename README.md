# Zorrito

Ahorro premiado sin pérdida de capital, sobre Stellar.
Ponés plata en un pozo, el pozo genera rendimiento en Blend, y cada semana uno
de los participantes se lleva el rendimiento de todos. El capital de cada uno
queda intacto y se retira cuando se quiera.

**Argentina Builder Challenge** (BAF × Stellar) · Track Genesis
Hackathon 12 → 26/09/2026 · Checkpoints 21 y 24/09 · Submission 27/09

---

## Empezá acá

| Leé esto | Para |
|---|---|
| **[PRODUCTO.md](PRODUCTO.md)** | Qué es Zorrito, por qué, alcance, riesgos y criterios del jurado |
| [RONDA.md](RONDA.md) | El primer producto (la ronda rotativa), que sigue en `contracts/ronda` |
| **[USDT0.md](USDT0.md)** | Direcciones mainnet y los 5 modos de falla que queman fondos |
| **[CLAUDE.md](CLAUDE.md)** | Gotchas de Soroban y direcciones testnet — se autocarga en Claude Code |
| [GAPS.md](GAPS.md) | Por qué esta idea: análisis de 812 proyectos del ecosistema |
| [EVM-GAPS.md](EVM-GAPS.md) | 50 primitivas EVM vs. Stellar |
| [IDEAS.md](IDEAS.md) | Las otras 44 ideas que descartamos |
| [SETUP.md](SETUP.md) | Toolchain y MCP |

> **Zorrito es el pozo.** Este repo arrancó como ronda rotativa (la vaquita)
> y ese contrato sigue acá, funcionando y desplegado en testnet, en
> `contracts/ronda` y en la ruta `/ronda` de la web. Pero el producto es **el
> pozo: ahorro premiado sin pérdida de capital**, el hueco que `GAPS.md` y
> `EVM-GAPS.md` marcan como el único con cero competidores entre 812
> proyectos. Ver [§El pozo](#el-pozo).

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
enchufa detrás sin tocar el sorteo. **Escala a un millón de cuentas desde el día cero.** Ninguna operación lee a
todos los participantes: cada cuenta es una entrada de storage y las chances
viven en un Fenwick tree sobre storage con capacidad 2^20. Depositar, retirar y
sortear tocan a lo sumo 21 nodos cada uno, haya diez cuentas o un millón. El
peso depósito × tiempo entra en el árbol por linealidad (`a·T − b`, dos
coeficientes que suman por prefijos), y al cerrar no se copia nada: la ronda
nueva arranca en el cierre y las chances de la cerrada quedan congeladas en el
árbol por versionado perezoso. Medido: el footprint de un depósito es de 23–30
escrituras con 1 o con 1.001 cuentas, y el sorteo con 1.001 cuentas cuesta 45M
instrucciones sobre un límite de 100M por transacción.

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
  privilegiados, Fenwick tree sobre storage con capacidad para un millón de
  cuentas. 37 tests, footprint y costo medidos
- ✅ Keeper permissionless del pozo (`web/scripts/keeper.ts`) y helper que
  descomprime la clave de drand para el deploy
- ✅ **Pozo corriendo en testnet con el mock**:
  `CB5X4AGGESZWVWLUFMJY7CQJMEA4WR4W7TOSE5V4QM3F5O6IMLBU22FY` (fuente mock
  `CDJFOATXNVBZO73S3IMXVD4XYR6AEBVCTDUDWMLMX4ZS2WTPAHEAPOFW`, rondas de
  10 min). Más de 20 rondas seguidas cerradas y sorteadas por el keeper con
  firmas reales de drand quicknet: la verificación BLS on-chain está probada
  contra la red. El primer intento sacó a la luz un árbol de autorización mal
  armado que los tests no veían (ver `CLAUDE.md`)
- ✅ **Pozo de prueba en testnet con Blend** (`/test`):
  `CDNKUQX5YT5JYDF2UB3NZXI7UFKRKUTU7W23P42TLXUTGY4WE5IZI5X2`, a través del
  adapter `CCHLQA7SGZAEVGLAFUL4Y6DMBG7ZUZYSZZ7AGN44GNNJCCJ6VECV7ISA` sobre el
  pool TestnetV2 `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`.
  Rondas de 10 min, con racha y referidos. Los depósitos atraviesan las tres
  autorizaciones anidadas y el pool paga interés real. El anterior
  (`CCAM3QUE…HWHRZ`, sin racha) sorteó decenas de rondas y sigue vivo
- ✅ **App en https://zorritostellar.vercel.app**, con el estilo de Zorrito:
  pestañas por pozo (semanal y demo), premio con countdown, APY de Blend, tu
  posición, depositar y retirar, últimos ganadores leídos de los eventos, y
  `/docs` con cómo está hecho, el azar, Blend, contratos y riesgos. La ronda
  rotativa quedó en `/ronda`
- ✅ **Adapter de Blend** (`contracts/blend_adapter/`): Supply no colateral en
  un pool de Blend v2, testeado contra el bytecode real del protocolo. 8 tests
  propios más el pozo operando a través de él. Lo que no cubre ningún test es
  el devengo del interés, porque Blend solo genera cuando alguien pide
  prestado — eso se ve recién en un pool con actividad

- ✅ **Keeper serverless** (`web/src/app/api/keeper/route.ts`): la misma
  lógica que el script, como función en Vercel. La dispara un cron y cada
  visita a la página que encuentra una ronda vencida o un sorteo pendiente
- ✅ Script para enchufar Blend real en testnet
  (`scripts/enchufar-blend-testnet.sh`), con `VARIANTE=semanal` para el pozo
  de 7 días
- ✅ **Racha diaria y referidos en el contrato**, en la misma unidad que el
  peso (plata × tiempo): siete días seguidos de "ahorré hoy" duplican las
  chances; cada referido suma el 10 % de su capital con tope de la mitad del
  propio. Tope de capital por pozo para mainnet. 50 tests
- ✅ App con dos pozos: la home apunta al de mainnet (semanal) y `/test` al
  de testnet (10 min), enlazado solo desde Docs. Racha, link de invitación y
  referidos en pantalla
- ✅ **Zorrito en mainnet**: pozo `CBPOMGHGCWH2QMG4V4FTZKGBCEN7K37R2OIDGD5VWBAKYTOWG7CDCGGA`
  (USDC, semanal, tope 5.000) a través del adapter
  `CD5XQWHFSW427KOQAMAXBMMM6X4BIH6AXZUP76PBB6SWYSSAA4D53MKC` sobre la reserva
  de USDC del pool Fixed de Blend v2
  `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD`. Es el pozo de la
  home. (El primer deploy, `CAR46DV7…UKQP`, era de XLM: Blend paga 0 % por XLM
  y el retiro chocaba con el redondeo del pool; quedó abandonado, vacío.)
- ✅ Entrar pagando con XLM o USDT0: la app cotiza en Soroswap y en el DEX
  clásico, cambia por el que más da en la wallet del usuario, y deposita el
  USDC que salió. El pozo no lo ve

### Riesgos, sin maquillaje

- **Liquidez de Blend (medio).** El capital está prestado. Si el pool tiene
  casi toda su liquidez tomada, un retiro puede fallar hasta que alguien
  devuelva o deposite. No se pierde capital, pero puede haber que esperar.
  Blend sube las tasas con la utilización para que eso dure poco.
- **Protocolo Blend (medio).** Un bug en Blend afecta al pozo como a cualquier
  prestamista. Blend v2 está auditado; el riesgo no es cero.
- **drand (bajo).** Si deja de publicar, no hay sorteo hasta que vuelva. El
  capital se retira igual, con o sin sorteo pendiente.
- **Keeper (bajo).** No hay dependencia: cualquiera cierra y sortea, y la app
  lo hace sola en cada visita que encuentra trabajo.
- **Renta de storage (bajo).** Las entradas de cuentas inactivas durante
  meses vencen si nadie las extiende. Cualquiera puede; falta automatizarlo
  en el keeper.
- **Sin auditoría (info).** MVP construido desde cero en el hackathon, en
  testnet.

### Enchufar Blend en vez del mock

```bash
scripts/enchufar-blend-testnet.sh          # testnet: pool TestnetV2 de Blend, rondas de 10 min
scripts/desplegar-mainnet.sh               # mainnet: pool Fixed de Blend, semanal, con tope
POOL=C... scripts/enchufar-blend-testnet.sh # otro pool
```

El de mainnet necesita una identidad de la CLI con XLM (`IDENTIDAD`, por
defecto `zorrito-mainnet`) y pone un tope de capital (`TOPE_XLM`, 5.000 por
defecto) porque es plata real en un contrato sin auditoría. Las direcciones
van fijas en `web/src/lib/config.ts`; la app no necesita variables en Vercel.

Verifica que el pool tenga al token como reserva, deploya el adapter, deploya
un pozo nuevo apuntando al adapter y le fija al adapter su dueño. El orden lo
impone la construcción: el pozo se construye apuntando a la fuente, y el
adapter no puede conocer al pozo antes de que exista. Deja `web/.env.local`
apuntando al pozo nuevo.

El adapter usa `Supply` (no colateral): la posición genera interés y no puede
liquidarse, y no toca el oráculo. Los WASMs de Blend que usan los tests están
en `contracts/blend_adapter/blend/`, tal como los publica `blend-contract-sdk`;
no se usa ese crate como dependencia porque arrastra otra major de
`soroban-sdk`. Direcciones de Blend en testnet: `blend-utils/testnet.contracts.json`.

### Deploy en Vercel

El proyecto de Vercel es la carpeta `web/`. Desde ahí, con la CLI:

```bash
cd web
npx vercel link                       # crea el proyecto la primera vez
npx vercel env add NEXT_PUBLIC_RED production     # testnet
npx vercel env add NEXT_PUBLIC_POZO production    # la dirección del pozo
npx vercel env add KEEPER_SECRET production       # la clave que paga fees (ver web/.env.local)
npx vercel --prod
```

O desde el dashboard: importar el repo, **Root Directory = `web`**, y las
mismas tres variables. Sin `KEEPER_SECRET` la app anda igual, pero el keeper
solo mira.

El keeper corre en `/api/keeper`. `web/vercel.json` lo dispara por cron una
vez por día, que es lo máximo que permite el plan Hobby; en Pro cambiá el
`schedule` a `*/5 * * * *`. Igual, cada visita a la página que encuentra una
ronda vencida o un sorteo pendiente lo dispara también, así que con que
alguien abra la app una vez por semana alcanza. Para verificarlo:

```bash
curl -s https://<tu-deploy>.vercel.app/api/keeper
# {"ok":true,"firma":true,"paso":{"accion":"espera","detalle":"ronda 3: 2 participantes, ..."}}
```

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
