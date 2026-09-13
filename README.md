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
- ⬜ **Deploy en testnet** ← nada de esto se corrió contra la red todavía
- ⬜ Indexer de `oft_received`
- ⬜ Frontend
- ⬜ **Ensayo de USDT0 en mainnet** ← hacelo primero, ver abajo

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

## Setup local

```bash
rustup target add wasm32v1-none
npm install
stellar contract build && cargo test
```

Deploy (testnet primero, siempre):

```bash
scripts/deploy.sh testnet <identidad>   # stellar keys ls
```

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
