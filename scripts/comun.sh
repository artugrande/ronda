#!/usr/bin/env bash
#
# Helpers que comparten los scripts de deploy. Se hace `source`, no se ejecuta.
# Compatible con el bash 3.2 de macOS: sin mapfile, sin arrays asociativos.

paso() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Deja web/.env.local apuntando a un pozo. Conserva el KEEPER_SECRET que ya
# hubiera; si no hay, usa pozo-cora, la identidad que no deposita: solo paga
# fees de cierre y sorteo.
#
#   escribir_env_local <red> <pozo> <fuente>
escribir_env_local() {
  local red="$1" pozo="$2" fuente="$3"
  local archivo=web/.env.local
  local keeper_secret=""
  if [[ -f "$archivo" ]]; then
    keeper_secret=$(sed -n 's/^KEEPER_SECRET=//p' "$archivo" | head -n 1)
  fi
  [[ -n "$keeper_secret" ]] || keeper_secret=$(stellar keys secret pozo-cora)
  cat >"$archivo" <<ENV
# Escrito por scripts/. No se sube a git.
NEXT_PUBLIC_RED=$red
NEXT_PUBLIC_POZO=$pozo

# keeper (npm run keeper). En Vercel alcanza con NEXT_PUBLIC_* y KEEPER_SECRET.
RPC_URL=https://soroban-testnet.stellar.org
PASSPHRASE="Test SDF Network ; September 2015"
POZO=$pozo
FUENTE=$fuente
KEEPER_SECRET=$keeper_secret
ENV
  echo "  $archivo apunta a $pozo"
}

# Crea (si falta) y fondea las cuatro identidades del ensayo.
#
#   preparar_identidades <red>
preparar_identidades() {
  local red="$1" quien
  for quien in admin ana beto cora; do
    if stellar keys address "pozo-$quien" >/dev/null 2>&1; then
      echo "  pozo-$quien ya existe"
    else
      stellar keys generate "pozo-$quien" --network "$red"
      echo "  pozo-$quien creada"
    fi
    if stellar keys fund "pozo-$quien" --network "$red" >/dev/null 2>&1; then
      echo "    fondeada por el friendbot"
    else
      echo "    ya tenía fondos"
    fi
  done
}

# Imprime la clave pública de drand quicknet descomprimida, el génesis y el
# período, en tres variables: DRAND_PK, DRAND_GENESIS, DRAND_PERIODO.
leer_drand() {
  local salida
  salida=$(cd web && npx --yes tsx scripts/drand-pk.ts)
  DRAND_PK=$(sed -n 1p <<<"$salida")
  DRAND_GENESIS=$(sed -n 2p <<<"$salida")
  DRAND_PERIODO=$(sed -n 3p <<<"$salida")
  [[ ${#DRAND_PK} -eq 384 ]] || { echo "la clave no tiene 192 bytes: ${#DRAND_PK} hex" >&2; return 1; }
  echo "  pk       ${DRAND_PK:0:16}…${DRAND_PK:368}"
  echo "  genesis  $DRAND_GENESIS"
  echo "  periodo  ${DRAND_PERIODO}s"
}

# Deploya el pozo con su constructor y extiende el TTL.
#
#   desplegar_pozo <red> <token> <fuente> <periodo>   → imprime la dirección
desplegar_pozo() {
  local red="$1" token="$2" fuente="$3" periodo="$4" pozo
  pozo=$(stellar contract deploy \
    --wasm target/wasm32v1-none/release/pozo.wasm \
    --source pozo-admin --network "$red" \
    -- \
    --token "$token" \
    --fuente "$fuente" \
    --periodo "$periodo" \
    --drand_pk "$DRAND_PK" \
    --drand_genesis "$DRAND_GENESIS" \
    --drand_periodo "$DRAND_PERIODO")
  stellar contract extend --id "$pozo" --durability persistent \
    --ledgers-to-extend 518400 --source pozo-admin --network "$red" >/dev/null
  echo "$pozo"
}
