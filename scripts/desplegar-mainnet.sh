#!/usr/bin/env bash
#
# Zorrito en mainnet: el adapter contra el pool Fixed de Blend v2 y el pozo
# semanal, con tope de capital.
#
#   scripts/desplegar-mainnet.sh
#   TOPE_XLM=10000 scripts/desplegar-mainnet.sh     # otro tope
#   IDENTIDAD=mi-cuenta scripts/desplegar-mainnet.sh
#
# Necesita una identidad de la CLI con XLM en mainnet (unos 100 XLM alcanzan
# para los deploys, la renta de un mes y las fees de meses de keeper). Si no
# la tenés:
#
#   stellar keys add zorrito-mainnet --secret-key      # pega la clave S...
#   # o: stellar keys generate zorrito-mainnet, y mandale XLM a su dirección
#
# El keeper (KEEPER_SECRET en Vercel) es la cuenta pozo-cora de los scripts de
# testnet. Para que sortee en mainnet, esa misma dirección tiene que existir
# en mainnet: mandale ~5 XLM. La clave es la misma en las dos redes.
#
# Plata real, contrato sin auditoría: por eso el tope. Se sube redeployando.
#
set -euo pipefail

# La CLI trae "mainnet" sin RPC ("Bring Your Own"): se registra una red propia
# con un RPC público. Si este se cae o limita, MAINNET_RPC=... con otro de
# https://developers.stellar.org/docs/data/rpc/rpc-providers
RED=zorrito-mainnet
MAINNET_RPC="${MAINNET_RPC:-https://mainnet.sorobanrpc.com}"
PASSPHRASE_MAINNET="Public Global Stellar Network ; September 2015"
PERIODO="${PERIODO:-604800}"
TOPE_XLM="${TOPE_XLM:-5000}"
TOPE=$((TOPE_XLM * 10000000))
POOL="${POOL:-CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD}"   # Blend v2 "Fixed"
IDENTIDAD="${IDENTIDAD:-zorrito-mainnet}"
# 0,01 XLM por transacción: entra en el primer ledger aunque haya tráfico.
export STELLAR_FEE="${STELLAR_FEE:-100000}"

cd "$(dirname "$0")/.."

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh
# shellcheck source=scripts/comun.sh
source scripts/comun.sh
exigir_rustc || exit 1
exigir_stellar || exit 127
command -v node >/dev/null || { echo "falta node (>= 22.12) para el helper de drand" >&2; exit 127; }

paso "Identidad en mainnet"
if ! ADMIN=$(stellar keys address "$IDENTIDAD" 2>/dev/null); then
  cat >&2 <<MSG
No existe la identidad "$IDENTIDAD". Creala con una cuenta que tenga XLM en mainnet:

  stellar keys add $IDENTIDAD --secret-key

o generá una nueva y fondeala:

  stellar keys generate $IDENTIDAD
  stellar keys address $IDENTIDAD      # mandale ~100 XLM
MSG
  exit 1
fi
echo "  $ADMIN"

paso "RPC de mainnet"
SALUD=$(curl -sS --max-time 20 "$MAINNET_RPC" -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>&1 || true)
if ! grep -q healthy <<<"$SALUD"; then
  cat >&2 <<MSG
El RPC $MAINNET_RPC no responde sano:
$SALUD

Probá con otro: MAINNET_RPC=https://... scripts/desplegar-mainnet.sh
(lista en https://developers.stellar.org/docs/data/rpc/rpc-providers)
MSG
  exit 1
fi
stellar network rm "$RED" >/dev/null 2>&1 || true
stellar network add "$RED" --rpc-url "$MAINNET_RPC" --network-passphrase "$PASSPHRASE_MAINNET"
echo "  $MAINNET_RPC → red \"$RED\" en la CLI"

paso "Tests y build"
cargo test -p pozo -p blend-adapter -- --skip ninguna_operacion_crece_con_la_cantidad_de_cuentas
stellar contract build
ls -l target/wasm32v1-none/release/pozo.wasm target/wasm32v1-none/release/blend_adapter.wasm

paso "Clave pública de drand quicknet (descomprimida)"
leer_drand

paso "SAC de XLM nativo"
TOKEN=$(stellar contract id asset --asset native --network "$RED")
echo "  $TOKEN"

paso "El pool de Blend tiene XLM como reserva"
echo "  pool $POOL"
if ! RESERVA=$(stellar contract invoke --id "$POOL" --source "$IDENTIDAD" --network "$RED" -- \
  get_reserve --asset "$TOKEN" 2>&1); then
  cat >&2 <<MSG
El pool no tiene a $TOKEN como reserva, o no es un pool de Blend v2:
$RESERVA

Elegí otro con POOL=C... (los de mainnet están en blend-utils/mainnet.contracts.json).
MSG
  exit 1
fi
echo "  b_rate $(sed -n 's/.*"b_rate":"\([0-9]*\)".*/\1/p' <<<"$RESERVA" | head -n 1)"

paso "1. Deploy del adapter"
ADAPTER=$(stellar contract deploy --fee "$STELLAR_FEE" \
  --wasm target/wasm32v1-none/release/blend_adapter.wasm \
  --source "$IDENTIDAD" --network "$RED" \
  -- \
  --admin "$ADMIN" \
  --pool "$POOL" \
  --token "$TOKEN")
stellar contract extend --fee "$STELLAR_FEE" --id "$ADAPTER" --durability persistent \
  --ledgers-to-extend 518400 --source "$IDENTIDAD" --network "$RED" >/dev/null
echo "  $ADAPTER"

paso "2. Deploy del pozo semanal, tope $TOPE_XLM XLM"
POZO=$(desplegar_pozo "$RED" "$TOKEN" "$ADAPTER" "$PERIODO" "$TOPE" "$IDENTIDAD")
echo "  $POZO"

paso "3. El adapter aprende quién es su dueño"
stellar contract invoke --fee "$STELLAR_FEE" --id "$ADAPTER" --source "$IDENTIDAD" --network "$RED" -- \
  fijar_dueno --dueno "$POZO"
echo "  dueño: $POZO"

paso "Estado inicial"
stellar contract invoke --id "$POZO" --source "$IDENTIDAD" --network "$RED" -- estado

KEEPER=$(stellar keys address pozo-cora 2>/dev/null || echo "(no existe pozo-cora en esta máquina)")

cat <<FIN

─────────────────────────────────────────────────────────────────
Zorrito está en mainnet.

POZO=$POZO
ADAPTER=$ADAPTER
POOL=$POOL
TOPE=$TOPE_XLM XLM · rondas de ${PERIODO}s

Falta:

1. Poner $POZO como dirección de mainnet en web/src/lib/config.ts y pushear.
2. Fondear al keeper en mainnet con ~5 XLM (la misma clave que en testnet):
   $KEEPER
3. Entrar a la app, conectar con una wallet en mainnet y depositar 1 XLM.
─────────────────────────────────────────────────────────────────
FIN
