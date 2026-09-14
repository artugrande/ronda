#!/usr/bin/env bash
#
# Helpers que comparten los scripts de deploy. Se hace `source`, no se ejecuta.
# Compatible con el bash 3.2 de macOS: sin mapfile, sin arrays asociativos.

paso() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# Fee de inclusión (stroops) para las transacciones que mandan los scripts. En
# testnet alcanza la mínima; en mainnet, con tráfico, una baja puede quedar
# esperando hasta que el cliente se cansa ("transaction submission timeout").
STELLAR_FEE="${STELLAR_FEE:-100}"

# Fija una variable en web/.env.local: la reemplaza si está, la agrega si no.
# El resto del archivo (KEEPER_SECRET incluido) queda como estaba.
#
#   fijar_env_local CLAVE VALOR
fijar_env_local() {
  local clave="$1" valor="$2" archivo=web/.env.local tmp
  [[ -f "$archivo" ]] || : >"$archivo"
  tmp=$(mktemp)
  grep -v "^${clave}=" "$archivo" >"$tmp" || true
  echo "${clave}=${valor}" >>"$tmp"
  mv "$tmp" "$archivo"
}

# Deja web/.env.local apuntando a un pozo. Conserva el KEEPER_SECRET que ya
# hubiera; si no hay, usa pozo-cora, la identidad que no deposita: solo paga
# fees de cierre y sorteo.
#
#   escribir_env_local <red> <pozo> <fuente> [variante]
#
# La variante es "demo" (10 min, la de siempre) o "semanal". Cada una tiene su
# propia variable, así la app muestra los dos pozos a la vez.
escribir_env_local() {
  local red="$1" pozo="$2" fuente="$3" variante="${4:-demo}"
  local archivo=web/.env.local
  local keeper_secret=""
  if [[ -f "$archivo" ]]; then
    keeper_secret=$(sed -n 's/^KEEPER_SECRET=//p' "$archivo" | head -n 1)
  fi
  [[ -n "$keeper_secret" ]] || keeper_secret=$(stellar keys secret pozo-cora)
  fijar_env_local NEXT_PUBLIC_RED "$red"
  fijar_env_local RPC_URL "https://soroban-testnet.stellar.org"
  fijar_env_local PASSPHRASE '"Test SDF Network ; September 2015"'
  fijar_env_local KEEPER_SECRET "$keeper_secret"
  if [[ "$variante" == semanal ]]; then
    fijar_env_local NEXT_PUBLIC_POZO_SEMANAL "$pozo"
    fijar_env_local POZO_SEMANAL "$pozo"
    fijar_env_local FUENTE_SEMANAL "$fuente"
  else
    fijar_env_local NEXT_PUBLIC_POZO "$pozo"
    fijar_env_local POZO "$pozo"
    fijar_env_local FUENTE "$fuente"
  fi
  echo "  $archivo: pozo $variante → $pozo"
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
#   desplegar_pozo <red> <token> <fuente> <periodo> [tope] [origen]   → imprime la dirección
#
# El tope es el capital total máximo en stroops; 0 = sin tope. `origen` es la
# identidad que paga el deploy (pozo-admin por defecto).
desplegar_pozo() {
  local red="$1" token="$2" fuente="$3" periodo="$4" tope="${5:-0}" origen="${6:-pozo-admin}" pozo
  pozo=$(stellar contract deploy --fee "$STELLAR_FEE" \
    --wasm target/wasm32v1-none/release/pozo.wasm \
    --source "$origen" --network "$red" \
    -- \
    --token "$token" \
    --fuente "$fuente" \
    --periodo "$periodo" \
    --tope "$tope" \
    --drand_pk "$DRAND_PK" \
    --drand_genesis "$DRAND_GENESIS" \
    --drand_periodo "$DRAND_PERIODO")
  [[ -n "$pozo" ]] || { echo "el deploy del pozo no devolvió dirección" >&2; return 1; }
  stellar contract extend --fee "$STELLAR_FEE" --id "$pozo" --durability persistent \
    --ledgers-to-extend 518400 --source "$origen" --network "$red" >/dev/null
  echo "$pozo"
}
