#!/usr/bin/env bash
#
# Ensayo end-to-end del pozo en testnet: fuente de rendimiento mock, pozo con
# la clave real de drand quicknet, y tres cuentas fondeadas.
#
#   scripts/ensayo-pozo-testnet.sh
#
# Usa el SAC de XLM nativo (no necesita trustlines) y el mock de rendimiento
# (tasa fija) en lugar de Blend, así que el ciclo depositar → cerrar → sortear
# se puede probar entero sin depender de un mercado. Blend se enchufa después
# cambiando solo la fuente.
#
# La clave de drand la trae y descomprime web/scripts/drand-pk.ts: el host de
# Soroban no descomprime puntos y drand los sirve comprimidos.
#
# NO SE EJECUTÓ NUNCA CONTRA LA RED. Se escribió sin acceso a Stellar ni a
# drand. Los invokes de cierre y sorteo del final tampoco: son los que van a
# validar, por primera vez, la verificación BLS on-chain con una firma real.
#
set -euo pipefail

RED=testnet
PERIODO="${PERIODO:-600}"           # 10 min de ronda, para no esperar una semana
TASA_BPS="${TASA_BPS:-1000}"        # 10% anual en el mock
FONDEO_MOCK="${FONDEO_MOCK:-1000000000}"  # 100 XLM para que el mock pueda pagar rendimiento

cd "$(dirname "$0")/.."

paso() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh
exigir_rustc || exit 1
exigir_stellar || exit 127
command -v node >/dev/null || { echo "falta node (>= 22.12) para el helper de drand" >&2; exit 127; }

paso "Tests y build"
# Sin el test de escala: deposita 1.000 cuentas y tarda minutos sin imprimir
# nada, y un deploy que parece colgado es peor que uno que tarda. Corre en
# `cargo test` como siempre.
cargo test -p pozo -p mock-rendimiento -- --skip ninguna_operacion_crece_con_la_cantidad_de_cuentas
stellar contract build
ls -l target/wasm32v1-none/release/pozo.wasm target/wasm32v1-none/release/mock_rendimiento.wasm

paso "Clave pública de drand quicknet (descomprimida)"
# Sin mapfile ni offsets negativos: macOS trae bash 3.2 y no los tiene.
DRAND_SALIDA=$(cd web && npx --yes tsx scripts/drand-pk.ts)
DRAND_PK=$(sed -n 1p <<<"$DRAND_SALIDA")
DRAND_GENESIS=$(sed -n 2p <<<"$DRAND_SALIDA")
DRAND_PERIODO=$(sed -n 3p <<<"$DRAND_SALIDA")
[[ ${#DRAND_PK} -eq 384 ]] || { echo "la clave no tiene 192 bytes: ${#DRAND_PK} hex" >&2; exit 1; }
echo "  pk       ${DRAND_PK:0:16}…${DRAND_PK:368}"
echo "  genesis  $DRAND_GENESIS"
echo "  periodo  ${DRAND_PERIODO}s"

paso "Identidades"
for quien in admin ana beto cora; do
  if stellar keys address "pozo-$quien" >/dev/null 2>&1; then
    echo "  pozo-$quien ya existe"
  else
    stellar keys generate "pozo-$quien" --network "$RED"
    echo "  pozo-$quien creada"
  fi
  if stellar keys fund "pozo-$quien" --network "$RED" >/dev/null 2>&1; then
    echo "    fondeada por el friendbot"
  else
    echo "    ya tenía fondos"
  fi
done
ADMIN=$(stellar keys address pozo-admin)
ANA=$(stellar keys address pozo-ana)
BETO=$(stellar keys address pozo-beto)
CORA=$(stellar keys address pozo-cora)

paso "SAC de XLM nativo"
TOKEN=$(stellar contract id asset --asset native --network "$RED")
echo "  $TOKEN"

paso "Deploy de la fuente de rendimiento (mock)"
FUENTE=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/mock_rendimiento.wasm \
  --source pozo-admin --network "$RED")
echo "  $FUENTE"
stellar contract invoke --id "$FUENTE" --source pozo-admin --network "$RED" -- \
  inicializar --token "$TOKEN" --tasa_bps "$TASA_BPS"
# El mock paga el rendimiento de su propio saldo: hay que darle con qué.
stellar contract invoke --id "$TOKEN" --source pozo-admin --network "$RED" -- \
  transfer --from "$ADMIN" --to "$FUENTE" --amount "$FONDEO_MOCK"
echo "  fondeada con $FONDEO_MOCK stroops"

paso "Deploy del pozo (el constructor corre en la misma transacción)"
POZO=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/pozo.wasm \
  --source pozo-admin --network "$RED" \
  -- \
  --token "$TOKEN" \
  --fuente "$FUENTE" \
  --periodo "$PERIODO" \
  --drand_pk "$DRAND_PK" \
  --drand_genesis "$DRAND_GENESIS" \
  --drand_periodo "$DRAND_PERIODO")
echo "  $POZO"

paso "Verificando la instancia on-chain"
stellar ledger entry fetch contract-data --contract "$POZO" --instance \
  --output json-formatted --network "$RED" >/dev/null
echo "  existe"

paso "Extendiendo TTL (~30 días)"
stellar contract extend --id "$POZO" --durability persistent \
  --ledgers-to-extend 518400 --source pozo-admin --network "$RED" >/dev/null
echo "  extendido"

paso "Estado inicial"
stellar contract invoke --id "$POZO" --source pozo-admin --network "$RED" -- estado

paso "Escribiendo web/.env.local"
# Se conserva el KEEPER_SECRET que ya hubiera; si no hay, se usa pozo-cora,
# que es la identidad que no deposita: solo paga fees de cierre y sorteo.
ENV_LOCAL=web/.env.local
KEEPER_SECRET=""
if [[ -f "$ENV_LOCAL" ]]; then
  KEEPER_SECRET=$(sed -n 's/^KEEPER_SECRET=//p' "$ENV_LOCAL" | head -n 1)
fi
[[ -n "$KEEPER_SECRET" ]] || KEEPER_SECRET=$(stellar keys secret pozo-cora)
cat >"$ENV_LOCAL" <<ENV
# Escrito por scripts/ensayo-pozo-testnet.sh. No se sube a git.
NEXT_PUBLIC_RED=$RED
NEXT_PUBLIC_POZO=$POZO

# keeper
RPC_URL=https://soroban-testnet.stellar.org
PASSPHRASE="Test SDF Network ; September 2015"
POZO=$POZO
FUENTE=$FUENTE
KEEPER_SECRET=$KEEPER_SECRET
ENV
echo "  $ENV_LOCAL apunta al pozo nuevo (keeper: $CORA)"

cat <<FIN

─────────────────────────────────────────────────────────────────
Listo. web/.env.local ya apunta a este pozo.

POZO=$POZO
FUENTE=$FUENTE

El ciclo completo desde la terminal:

  # ana y beto depositan 10 XLM
  stellar contract invoke --id $POZO --source pozo-ana --network testnet -- \\
    depositar --usuario $ANA --monto 100000000
  stellar contract invoke --id $POZO --source pozo-beto --network testnet -- \\
    depositar --usuario $BETO --monto 100000000

  # pasados $PERIODO segundos, cualquiera cierra. Devuelve la ronda de drand
  # que va a decidir, ~10 minutos en el futuro:
  stellar contract invoke --id $POZO --source pozo-cora --network testnet -- \\
    cerrar_ronda

  # cuando drand la publique, cualquiera la trae y sortea:
  cd web && npm run keeper

Fijate en el sorteo que el capital de los dos siga en 10 XLM (saldo) y que
el ganador haya cobrado exactamente estado.premio.
─────────────────────────────────────────────────────────────────
FIN
