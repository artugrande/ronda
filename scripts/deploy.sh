#!/usr/bin/env bash
#
# Despliega el contrato `ronda`.
#
#   scripts/deploy.sh testnet <identidad>
#   scripts/deploy.sh mainnet <identidad>
#
# NADA DE ESTO SE EJECUTÓ CONTRA LA RED todavía. Se escribió en una sesión
# remota con el egress bloqueado hacia *.stellar.org (ver README §Nota sobre el
# entorno). Corré primero testnet y leé cada salida antes de tocar mainnet.
#
set -euo pipefail

RED="${1:-testnet}"
IDENTIDAD="${2:-}"
WASM="target/wasm32v1-none/release/ronda.wasm"

# ~30 días a 5s por ledger. Los TTL expiran en silencio: si la instancia se
# archiva entre el envío cross-chain y la entrega, el OFT acredita a un G… cuya
# clave no tiene nadie y los fondos son irrecuperables. Ver PRODUCTO.md §Guards.
LEDGERS_TTL=518400

if [[ -z "$IDENTIDAD" ]]; then
  echo "uso: $0 <testnet|mainnet> <identidad>" >&2
  echo "     las identidades se listan con: stellar keys ls" >&2
  exit 2
fi

if ! command -v stellar >/dev/null 2>&1; then
  echo "falta el CLI de stellar. Usá el binario precompilado, no cargo install." >&2
  echo "Ver SETUP.md §Toolchain." >&2
  exit 127
fi

cd "$(dirname "$0")/.."

echo "==> Tests"
cargo test

echo "==> Build"
stellar contract build
ls -l "$WASM"

if [[ "$RED" == "mainnet" ]]; then
  cat <<'ADVERTENCIA'

  ┌──────────────────────────────────────────────────────────────────┐
  │  MAINNET. Esto gasta XLM real y es irreversible.                 │
  │                                                                  │
  │  Antes de seguir, verificá a mano:                               │
  │   - que los tests pasan sobre este mismo commit                  │
  │   - que probaste el flujo completo en testnet con USDC           │
  │   - la derivación de la SAC de USDT0 (README §Nota)              │
  └──────────────────────────────────────────────────────────────────┘

ADVERTENCIA
  read -r -p 'Escribí "mainnet" para confirmar: ' confirmacion
  [[ "$confirmacion" == "mainnet" ]] || { echo "cancelado."; exit 1; }
fi

echo "==> Deploy en $RED"
RONDA=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTIDAD" \
  --network "$RED")
echo "contract_id=$RONDA"

# Guard que no se negocia: la existencia del contrato se lee en la ENTREGA del
# mensaje cross-chain, no en el envío. Si no está desplegado cuando llega el
# USDT0, el origen ya quemó los fondos y no hay vuelta atrás.
echo "==> Verificando que la instancia existe on-chain"
stellar ledger entry fetch contract-data \
  --contract "$RONDA" \
  --instance \
  --output json-formatted \
  --network "$RED"

echo "==> Extendiendo TTL de la instancia (~30 días)"
stellar contract extend \
  --id "$RONDA" \
  --durability persistent \
  --ledgers-to-extend "$LEDGERS_TTL" \
  --source "$IDENTIDAD" \
  --network "$RED"

cat <<FIN

Desplegado: $RONDA

Crear una ronda (ejemplo, 3 miembros, 100 unidades por turno, semanal):

  stellar contract invoke --id $RONDA --source $IDENTIDAD --network $RED -- \\
    crear_ronda \\
      --oraculo G... \\
      --token C... \\
      --orden '["G...","G...","G..."]' \\
      --monto_turno 1000000000 \\
      --periodo 604800

  monto_turno va en stroops y tiene que terminar en 0: el 7º decimal no
  sobrevive al recorte del OFT y ahí es donde vive la etiqueta.

Recordá re-extender el TTL antes de que caiga por debajo de ~100 ledgers.
FIN
