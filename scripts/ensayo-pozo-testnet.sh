#!/usr/bin/env bash
#
# Ensayo end-to-end del pozo en testnet: fuente de rendimiento mock, pozo con
# la clave real de drand quicknet, y tres cuentas fondeadas.
#
#   scripts/ensayo-pozo-testnet.sh
#
# Usa el SAC de XLM nativo (no necesita trustlines) y el mock de rendimiento
# (tasa fija) en lugar de Blend, así que el ciclo depositar → cerrar → sortear
# se puede probar entero sin depender de un mercado. Para Blend de verdad,
# scripts/enchufar-blend-testnet.sh.
#
# Corrió contra testnet: deploy, depósitos, cierre y sorteo con firmas reales
# de drand, más de 20 rondas seguidas. Cada corrida deploya un mock y un pozo
# nuevos y deja web/.env.local apuntando a ellos.
#
set -euo pipefail

RED=testnet
PERIODO="${PERIODO:-600}"           # 10 min de ronda, para no esperar una semana
TASA_BPS="${TASA_BPS:-1000}"        # 10% anual en el mock
FONDEO_MOCK="${FONDEO_MOCK:-1000000000}"  # 100 XLM para que el mock pueda pagar rendimiento

cd "$(dirname "$0")/.."

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh
# shellcheck source=scripts/comun.sh
source scripts/comun.sh
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
leer_drand

paso "Identidades"
preparar_identidades "$RED"
ADMIN=$(stellar keys address pozo-admin)
ANA=$(stellar keys address pozo-ana)
BETO=$(stellar keys address pozo-beto)

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
POZO=$(desplegar_pozo "$RED" "$TOKEN" "$FUENTE" "$PERIODO")
echo "  $POZO"

paso "Estado inicial"
stellar contract invoke --id "$POZO" --source pozo-admin --network "$RED" -- estado

paso "Escribiendo web/.env.local"
escribir_env_local "$RED" "$POZO" "$FUENTE"

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

  # el mock adelanta una semana de rendimiento, para ver un premio sin esperar
  stellar contract invoke --id $FUENTE --source pozo-admin --network testnet -- \\
    adelantar --cuenta $POZO --segundos 604800

  # el keeper cierra a los $PERIODO segundos, espera a drand y sortea:
  cd web && npm run keeper

Fijate en el sorteo que el capital de los dos siga en 10 XLM (saldo) y que
el ganador haya cobrado exactamente estado.premio.
─────────────────────────────────────────────────────────────────
FIN
