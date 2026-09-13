#!/usr/bin/env bash
#
# Ensayo end-to-end en testnet, de cero a una ronda creada.
#
#   scripts/ensayo-testnet.sh
#
# Crea tres identidades fondeadas por el friendbot, despliega el contrato,
# resuelve el SAC de XLM nativo y crea una ronda de prueba. Al final imprime
# lo que hay que pegar en web/.env.local.
#
# Usa XLM nativo a propósito: toda cuenta de testnet tiene XLM y no necesita
# trustline. USDC te obliga a crear trustlines para cada miembro y a elegir
# bien el issuer (Circle vs. Blend — mezclarlos falla en silencio). Pasá a USDC
# recién cuando este flujo ya ande.
#
# NO SE EJECUTÓ NUNCA. Se escribió sin acceso a la red, así que los nombres de
# flags del CLI pueden necesitar un ajuste. Si algo falla, el error del CLI te
# va a decir qué flag cambió; corregilo y seguí.
#
set -euo pipefail

RED=testnet
PERIODO="${PERIODO:-300}"          # 5 minutos, para no esperar un día al turno
MONTO="${MONTO:-100000000}"        # 10 XLM en stroops. Termina en 0: obligatorio
WASM="target/wasm32v1-none/release/ronda.wasm"

cd "$(dirname "$0")/.."

paso() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh
exigir_rustc || exit 1
exigir_stellar || exit 127

if (( MONTO <= 0 || MONTO % 10 != 0 )); then
  echo "MONTO tiene que ser positivo y terminar en 0." >&2
  echo "El 7º decimal no viaja en el OFT, y ahí es donde vive la etiqueta." >&2
  exit 2
fi

paso "Tests y build"
cargo test
stellar contract build
ls -l "$WASM"

paso "Identidades"
# El admin despliega y hace de oráculo; ana, beto y cora son la ronda.
for quien in admin ana beto cora; do
  if stellar keys address "ronda-$quien" >/dev/null 2>&1; then
    echo "  ronda-$quien ya existe"
  else
    stellar keys generate --global "ronda-$quien" --network "$RED" --fund
    echo "  ronda-$quien creada y fondeada"
  fi
done

ADMIN=$(stellar keys address ronda-admin)
ANA=$(stellar keys address ronda-ana)
BETO=$(stellar keys address ronda-beto)
CORA=$(stellar keys address ronda-cora)

echo "  admin/oráculo $ADMIN"
echo "  ana           $ANA"
echo "  beto          $BETO"
echo "  cora          $CORA"

paso "SAC de XLM nativo"
TOKEN=$(stellar contract id asset --asset native --network "$RED")
echo "  $TOKEN"

paso "Deploy del contrato"
RONDA=$(stellar contract deploy \
  --wasm "$WASM" \
  --source ronda-admin \
  --network "$RED")
echo "  $RONDA"

# La existencia del contrato se lee en la ENTREGA del mensaje cross-chain, no
# en el envío. Verificarla acá es barato; descubrir que no estaba desplegado
# cuando llega el USDT0 significa que el origen ya quemó los fondos.
paso "Verificando la instancia on-chain"
stellar ledger entry fetch contract-data \
  --contract "$RONDA" \
  --instance \
  --output json-formatted \
  --network "$RED" >/dev/null
echo "  la instancia existe"

paso "Extendiendo TTL (~30 días)"
stellar contract extend \
  --id "$RONDA" \
  --durability persistent \
  --ledgers-to-extend 518400 \
  --source ronda-admin \
  --network "$RED" >/dev/null
echo "  extendido"

paso "Creando la ronda"
RONDA_ID=$(stellar contract invoke \
  --id "$RONDA" \
  --source ronda-admin \
  --network "$RED" \
  -- crear_ronda \
    --oraculo "$ADMIN" \
    --token "$TOKEN" \
    --orden "[\"$ANA\",\"$BETO\",\"$CORA\"]" \
    --monto_turno "$MONTO" \
    --periodo "$PERIODO")
echo "  ronda_id=$RONDA_ID"

paso "Estado inicial"
stellar contract invoke \
  --id "$RONDA" \
  --source ronda-admin \
  --network "$RED" \
  -- estado --ronda_id "$RONDA_ID"

cat <<FIN

─────────────────────────────────────────────────────────────────
Listo. Pegá esto en web/.env.local:

NEXT_PUBLIC_RED=testnet
NEXT_PUBLIC_CONTRATO=$RONDA
NEXT_PUBLIC_RONDA_ID=$RONDA_ID

Y esto para el indexer, en el mismo archivo:

CONTRATO=$RONDA
RONDA_ID=$RONDA_ID
TOKEN=$TOKEN

Después:

  cd web && npm install && npm run dev
  # en otra terminal, SIN la key del oráculo todavía:
  cd web && SOLO_MIRAR=1 npm run indexer

Para probar el ciclo completo desde la terminal, sin el front:

  # ana aporta
  stellar contract invoke --id $RONDA --source ronda-ana --network testnet -- \\
    acreditar --ronda_id $RONDA_ID --miembro $ANA

  # beto pide su monto etiquetado (el camino cross-chain)
  stellar contract invoke --id $RONDA --source ronda-beto --network testnet -- \\
    registrar_intencion --ronda_id $RONDA_ID --miembro $BETO

  # pasados $PERIODO segundos, cualquiera cierra el turno
  stellar contract invoke --id $RONDA --source ronda-admin --network testnet -- \\
    ejecutar_turno --ronda_id $RONDA_ID

Cora no aporta a propósito: fijate que quede marcada morosa y que el pozo
que cobra ana sea lo que se juntó, no el nominal de tres aportes.
─────────────────────────────────────────────────────────────────
FIN
