# Argentina Builder Challenge — proyecto Stellar

Hackathon BAF × Stellar. Track Genesis (proyecto nuevo desde cero).
Kickoff 12/09/2026 · Checkpoints 21 y 24/09 · Submission final 27/09.

## Stack

- Contratos: Rust + `soroban-sdk`, target `wasm32v1-none`
- Cliente: `@stellar/stellar-sdk` v14+ (TypeScript)
- Red: Testnet

## La versión de Rust está encajonada

Dos restricciones que se pisan, y el error de cada una no menciona la otra:

```
soroban-sdk 27  pide     >= 1.91.0
stellar-cli     bloquea  1.81, 1.82, 1.83 y 1.91.0   (generan wasm malo)
```

`cargo` corta con `rustc X is not supported by the following packages` recién
después de bajar 178 crates. Y si subís justo a 1.91.0 para callarlo, pasa
`cargo test` pero `stellar contract build` corta con `use a rust version other
than 1.81, 1.82, 1.83 or 1.91.0 to build contracts`.

**La ventana real arranca en 1.91.1.** `rust-toolchain.toml` ya la fija; no la
bajes a 1.91.0 por más que el mensaje del SDK diga que alcanza.

## BLS12-381 y drand (contrato `pozo`)

- **El host no descomprime puntos.** `Bls12381G1Affine::from_bytes` toma 96
  bytes y `G2` 192, sin comprimir. drand sirve 48 y 96 comprimidos: la
  descompresión vive en TypeScript (`@noble/curves`), nunca en el contrato.
- **Layout de G2 sin comprimir**: `be(X_c1) || be(X_c0) || be(Y_c1) || be(Y_c0)`.
  Es el de arkworks/zkcrypto, y noble produce el mismo. Está verificado por un
  test que cruza el generador tipeado en `drand.rs` contra el de noble.
- **La SDK no trae el generador de G2.** Está hardcodeado en `drand.rs`; el
  test de Rust chequea curva + subgrupo, el de TS chequea los bytes exactos.
- **Un contrato que firma en su propio nombre para una llamada anidada** (el
  pozo llamando a la fuente, que a su vez mueve el token) necesita
  `env.authorize_as_current_contract(...)`, y la **raíz del árbol es la
  llamada anidada** (`token.transfer(pozo, fuente, monto)`), no la llamada
  directa (`fuente.depositar`). El host nunca consulta ese árbol para el frame
  directo (el invocador autoriza lo que invoca), así que un árbol con la
  llamada directa de raíz no se entra nunca y el transfer falla con
  `Error(Auth, InvalidAction)`. En tests usar `mock_all_auths()` a secas: es
  el único modo que detecta el árbol mal armado. Con
  `mock_all_auths_allowing_non_root_auth()` ese error llegó a testnet.
- **El presupuesto de tests no se renueva entre llamadas** fuera de una
  invocación de contrato. Tres pairings seguidos sobre un `Env` pelado dan
  `Error(Budget, ExceededLimit)`; dentro del contrato cada transacción trae el
  suyo. `env.cost_estimate().budget()` devuelve un valor que hay que ligar con
  `let mut` para poder `reset_unlimited()` / `reset_default()`.
- **Costo medido**: `ejecutar_sorteo` con 1.001 cuentas (1 pairing + descenso
  de 20 nodos) = ~45M instrucciones sobre un límite de 100M por transacción.
- **Las instrucciones del harness NO sirven para medir escala.** El host de
  tests guarda el ledger entero en un `MeteredOrdMap` respaldado por un `Vec`
  ordenado, y cobra a cada acceso una búsqueda/memmove sobre todas las entradas
  que existen: un depósito pasa de 1,8M a 43M instrucciones y de 300 KB a
  19 MB de memoria con 1.000 cuentas aunque toque *menos* entradas. En la red
  la transacción declara su footprint y el host carga solo eso. Para afirmar
  que algo escala, medí `env.cost_estimate().resources()` —
  `disk_read_entries + memory_read_entries` y `write_entries` — que es lo que
  la red cobra, y acotalo por una constante.

## Blend

- **No usar `blend-contract-sdk` como dependencia.** La 2.25 arrastra
  `soroban-sdk` 25 y el workspace está en la 27; dos majors del SDK no conviven
  en un contrato (el `Env` de una no es el de la otra). El crate es solo
  `contractimport!` de sus WASMs más un fixture: hacé lo mismo con nuestra SDK.
  Los WASMs viven en `contracts/blend_adapter/blend/` y el fixture portado en
  `blend_adapter/src/testutils.rs`.
- **`request_type` es un `u32` pelado en el spec** — `RequestType` no existe en
  el WASM. Supply = 0, Withdraw = 1 (no colateral). Verificado en test: el
  depósito aparece en `positions.supply`, no en `collateral`.
- **`b_rate` tiene 12 decimales** en v2. Verificado: con la reserva recién
  creada, `b_tokens × b_rate / 1e12` da exactamente el capital.
- **Withdraw devuelve el monto exacto** (Blend redondea los b-tokens que quema
  hacia arriba). Verificado contra el bytecode real; el pozo se apoya en eso.
- **Supply puro no toca el oráculo**: en el fixture el oráculo es una dirección
  cualquiera y todo funciona. Sí hace falta fondear el backstop (50k) y activar
  el pool (`set_status(3)` + `update_status`) para que acepte depósitos.
- **El interés no se devenga sin deuda.** Un test con solo Supply ve premio 0.
  Para ver rendimiento en tests haría falta un mock de oráculo y un borrower.

## Reglas de SDK que el modelo suele equivocar

El SDK v14 renombró el namespace. Escribí siempre:

```ts
import { rpc, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
const server = new rpc.Server('https://soroban-testnet.stellar.org');
```

- `rpc`, NO `SorobanRpc` (el modelo va a escribir v13 por defecto)
- `rpc.assembleTransaction()`, no el helper viejo
- Usar `Networks.TESTNET` / `Networks.PUBLIC`, nunca un passphrase hardcodeado
  (un mismatch da `tx_bad_auth`, que parece error de red pero no lo es)

**Stellar Wallets Kit**: en la 2.6 es una clase **estática** que se inicializa
con `StellarWalletsKit.init({ modules, network })`. No es `build(config)` —eso
era de una 2.x anterior— ni el constructor de la v1. Los módulos se importan uno
por uno desde subpaths (`@creit.tech/stellar-wallets-kit/modules/freighter`).
Verificado contra `esm/sdk/kit.d.ts` de la 2.6.0; ver `web/src/lib/wallet.ts`.

**Node >= 22.12**: lo pide `@stellar/stellar-sdk` en sus `engines`. En Node 20
el `npm install` solo tira un `EBADENGINE` que se pierde en el scroll, y el SDK
—o sea el front y el indexer— queda fuera de soporte. `web/.npmrc` tiene
`engine-strict=true` para que eso corte en vez de avisar.

**BigInt obligatorio**: los montos son `i128`. `create-next-app` pinea
`target: ES2017` en el tsconfig, donde los literales `1n` no compilan. Subir a
`ES2020` como mínimo. Si `tsc` sigue quejándose después de cambiarlo, borrá
`tsconfig.tsbuildinfo`: el caché incremental se queda con el target viejo.

**`rpc.Server.queryContract(id, metodo, args)`** (SDK 16+) resuelve el spec
desde el wasm desplegado y decodifica el resultado solo. Para lecturas evita
hand-rollear el decoding de ScVal —structs, `Option`, enums unitarios— que es
donde se cometen los errores silenciosos.

## Ciclo de transacción obligatorio

Saltear la simulación produce fallos crípticos. Siempre:

```ts
const sim = await server.simulateTransaction(tx);
const assembled = rpc.assembleTransaction(tx, sim);
const sent = await server.sendTransaction(assembled);
// sendTransaction devuelve PENDING, NO éxito. Hay que pollear:
const result = await server.pollTransaction(sent.hash, { attempts: 60 });
```

Todo va por `rpc.Server`: pagos clásicos, ChangeTrust, creación de cuenta,
sequence numbers. No usar Horizon. Rutear al servidor equivocado falla en silencio.

## Storage TTL

Los TTL de storage expiran **en silencio**: las lecturas devuelven
missing-value sin warning. Extender proactivamente cuando queden ~100 ledgers;
apuntar a ~518400 ledgers (~30 días).

## USDC testnet: issuers incompatibles

Cada protocolo mintea su propia variante. Elegir mal = swaps que fallan en silencio.

| Issuer | Dirección | Usado por |
|---|---|---|
| Circle (estándar) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | Soroswap, mayoría |
| Blend | `GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56` | Blend |

Verificar cuál espera el protocolo antes de escribir la primera línea.

## Contratos testnet

RPC: `https://soroban-testnet.stellar.org`

| Protocolo | Dirección |
|---|---|
| Blend Pool Factory V2 | `CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6` |
| DeFindex Factory | `CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32` |
| Soroswap Router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| Trustless Work (escrow multi-release) | `CB7EYMEHZI3UWS3EHNOUI55OD6X5FLMV537NEUQ6EWO677N6B6XSBP25` |

## Gotchas por protocolo

**Trustlines primero, siempre.** Sin trustline: `op_no_destination` o no-op
silencioso. Blend falla en silencio si depositás sin trustline previa.
Trustless Work: cada rol necesita trustline con la dirección del **issuer (G...)**,
no con el contract ID.

**Soroswap**: montos en `BigInt(...)` (no `parseFloat`), slippage como string
en basis points (`'50'`). El paquete es `@soroswap/sdk` con scope — el
`soroswap-sdk` sin scope está desactualizado.

**DeFindex**: endpoint `/vault/` singular; query param `?from=` (no `?user=`);
montos como array `{"amounts":[1000000]}`; éxito es HTTP 201, no 200. Marcar
`@defindex/sdk` como `serverExternalPackages` en `next.config.ts`. Sus errores
son objetos planos, no instancias de `Error`. **La API testnet está caída** —
los contratos andan, la capa HTTP no.

**Freighter**: no importar estáticamente en Next.js (usa globals de browser,
rompe en SSR) — import dinámico dentro de async. En v6 `signTransaction`
devuelve un objeto: usar `result.signedTxXdr`, no `result`. Envolver las
llamadas con timeout: si la extensión no está instalada, cuelgan para siempre.

**Passkeys / WebAuthn**: `rpId` tiene que ser dominio. Las IP se rechazan.
En local forzar `'localhost'`.

**Activos clásicos en Soroban**: XLM/USDC necesitan SAC deployado antes de
poder depositarse en un protocolo Soroban.

## Contexto Argentina

No hay camino self-service documentado para anchors ARS (ARST/Settle, Anclap
existen pero sin sandbox público verificado). **No poner un anchor fiat en el
camino crítico.** Construir sobre USDC y dejar el borde fiat mockeado u opcional.

## Criterios de evaluación

Validación del problema · Foco de negocio · Foco de producto · Ejecución técnica.
Explícito del reglamento: *no* gana la solución técnicamente más compleja, sino
la que resuelve un problema real de forma útil, clara y ejecutable.
