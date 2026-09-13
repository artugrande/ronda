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

## Estado

- ✅ Investigación cerrada, producto definido
- ✅ Workspace Soroban scaffoldeado y compilando a WASM
- ✅ 8 skills oficiales de Stellar incluidas en `.claude/skills/`
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
# contrato
rustup target add wasm32v1-none
cargo test && stellar contract build

# front + indexer
cd web && npm install && cp .env.example .env.local
npm test && npm run dev
```

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
