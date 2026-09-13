#!/usr/bin/env bash
#
# Zorrito con Blend de verdad: deploya el adapter contra un pool de Blend v2
# en testnet y un pozo nuevo que genera ahí, en vez de en el mock.
#
#   scripts/enchufar-blend-testnet.sh
#   POOL=C... scripts/enchufar-blend-testnet.sh     # otro pool
#
# Por defecto usa el pool "TestnetV2" que publica Blend en
# blend-utils/testnet.contracts.json, con el SAC de XLM nativo como reserva.
# Antes de deployar nada verifica que el pool tenga esa reserva: un pool sin
# ella deja un pozo que no puede depositar.
#
# El orden importa y es el que impone la construcción:
#
#   1. el adapter, con un admin que solo sirve para el paso 3;
#   2. el pozo, apuntando al adapter como fuente;
#   3. el adapter aprende quién es su dueño (el pozo). Una sola vez.
#
# Sobre el rendimiento: Blend solo genera cuando alguien pide prestado. En un
# pool de testnet con poca actividad el premio puede ser 0 durante días. El
# mecanismo es el mismo; lo que cambia es de dónde sale la plata.
#
set -euo pipefail

RED=testnet
PERIODO="${PERIODO:-600}"
POOL="${POOL:-CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF}"

cd "$(dirname "$0")/.."

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh
# shellcheck source=scripts/comun.sh
source scripts/comun.sh
exigir_rustc || exit 1
exigir_stellar || exit 127
command -v node >/dev/null || { echo "falta node (>= 22.12) para el helper de drand" >&2; exit 127; }

paso "Tests y build"
cargo test -p pozo -p blend-adapter -- --skip ninguna_operacion_crece_con_la_cantidad_de_cuentas
stellar contract build
ls -l target/wasm32v1-none/release/pozo.wasm target/wasm32v1-none/release/blend_adapter.wasm

paso "Clave pública de drand quicknet (descomprimida)"
leer_drand

paso "Identidades"
preparar_identidades "$RED"
ADMIN=$(stellar keys address pozo-admin)
ANA=$(stellar keys address pozo-ana)
BETO=$(stellar keys address pozo-beto)

paso "SAC de XLM nativo"
TOKEN=$(stellar contract id asset --asset native --network "$RED")
echo "  $TOKEN"

paso "El pool de Blend tiene XLM como reserva"
echo "  pool $POOL"
if ! RESERVA=$(stellar contract invoke --id "$POOL" --source pozo-admin --network "$RED" -- \
  get_reserve --asset "$TOKEN" 2>&1); then
  cat >&2 <<MSG
El pool no tiene a $TOKEN como reserva, o no es un pool de Blend v2:
$RESERVA

Elegí otro con POOL=C... (los de testnet están en
https://testnet.blend.capital, o en blend-utils/testnet.contracts.json).
MSG
  exit 1
fi
echo "  b_rate $(sed -n 's/.*"b_rate":"\([0-9]*\)".*/\1/p' <<<"$RESERVA" | head -n 1)"

paso "1. Deploy del adapter"
ADAPTER=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/blend_adapter.wasm \
  --source pozo-admin --network "$RED" \
  -- \
  --admin "$ADMIN" \
  --pool "$POOL" \
  --token "$TOKEN")
stellar contract extend --id "$ADAPTER" --durability persistent \
  --ledgers-to-extend 518400 --source pozo-admin --network "$RED" >/dev/null
echo "  $ADAPTER"

paso "2. Deploy del pozo, con el adapter como fuente"
POZO=$(desplegar_pozo "$RED" "$TOKEN" "$ADAPTER" "$PERIODO")
echo "  $POZO"

paso "3. El adapter aprende quién es su dueño"
stellar contract invoke --id "$ADAPTER" --source pozo-admin --network "$RED" -- \
  fijar_dueno --dueno "$POZO"
echo "  dueño: $POZO"

paso "Estado inicial"
stellar contract invoke --id "$POZO" --source pozo-admin --network "$RED" -- estado

paso "Escribiendo web/.env.local"
escribir_env_local "$RED" "$POZO" "$ADAPTER"

cat <<FIN

─────────────────────────────────────────────────────────────────
Listo. Este pozo genera en Blend. web/.env.local ya apunta a él.

POZO=$POZO
ADAPTER=$ADAPTER
POOL=$POOL

Probalo igual que con el mock, sin el "adelantar":

  stellar contract invoke --id $POZO --source pozo-ana --network testnet -- \\
    depositar --usuario $ANA --monto 100000000
  stellar contract invoke --id $POZO --source pozo-beto --network testnet -- \\
    depositar --usuario $BETO --monto 100000000

  cd web && npm run keeper

El primer depósito es la prueba real: pasa por pozo → adapter → Blend, con
tres autorizaciones anidadas. Si entra, en https://testnet.blend.capital
tendría que verse la posición del adapter ($ADAPTER) en el pool.

Para el deploy en Vercel, las variables son:

  NEXT_PUBLIC_RED=testnet
  NEXT_PUBLIC_POZO=$POZO
  KEEPER_SECRET=<la de web/.env.local>
─────────────────────────────────────────────────────────────────
FIN
