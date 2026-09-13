# Chequeos previos compartidos por deploy.sh y ensayo-testnet.sh.
# Se usa con `source`, no se ejecuta suelto.

# La versión de Rust está encajonada entre dos restricciones que se pisan:
#
#   soroban-sdk 27  pide  >= 1.91.0
#   stellar-cli     bloquea  1.81, 1.82, 1.83 y 1.91.0  (generan wasm malo)
#
# Un solo piso en 1.91.1 cubre las dos: excluye 1.91.0 y, por ser más alto,
# también 1.81, 1.82 y 1.83.
#
# rust-toolchain.toml ya lo resuelve para quien use rustup; este chequeo es para
# quien tenga Rust del sistema, donde el pin no aplica y el error de cargo
# aparece recién después de bajar 178 crates.
MSRV=1.91.1

exigir_rustc() {
  command -v rustc >/dev/null || {
    echo "falta rustc. Instalá Rust desde https://rustup.rs" >&2
    return 1
  }

  local actual
  actual=$(rustc --version | awk '{print $2}')

  # El menor de los dos según orden de versión. Si no es el MSRV, estamos abajo.
  if [[ "$(printf '%s\n%s\n' "$MSRV" "$actual" | sort -V | head -1)" != "$MSRV" ]]; then
    if [[ "$actual" == "1.91.0" ]]; then
      echo "rustc 1.91.0 cumple el mínimo de soroban-sdk, pero el CLI de" >&2
      echo "Stellar la bloquea: genera wasm malo. Necesitás $MSRV o más." >&2
    else
      echo "rustc $actual es muy viejo: hace falta $MSRV o más." >&2
    fi
    echo >&2
    if command -v rustup >/dev/null; then
      echo "  rustup update stable" >&2
      echo >&2
      echo "O dejá que rust-toolchain.toml lo resuelva: rustup instala $MSRV" >&2
      echo "solo al entrar al repo. Si ves esto teniendo rustup, puede que" >&2
      echo "estés corriendo un rustc del sistema que le gana en el PATH." >&2
    else
      echo "No tenés rustup. Instalalo desde https://rustup.rs y va a leer" >&2
      echo "rust-toolchain.toml, que ya fija $MSRV." >&2
    fi
    return 1
  fi
}

exigir_stellar() {
  command -v stellar >/dev/null || {
    echo "falta el CLI de stellar." >&2
    echo >&2
    if [[ "$(uname -s)" == "Darwin" ]]; then
      echo "  brew install stellar-cli" >&2
    else
      echo "  Bajá el binario precompilado de tu plataforma desde" >&2
      echo "  https://github.com/stellar/stellar-cli/releases — ver SETUP.md." >&2
    fi
    echo >&2
    echo "NO uses cargo install: compilar desde crates.io falla en un build" >&2
    echo "script de libdbus-sys, y aun con la lib tarda ~10 minutos." >&2
    return 1
  }
}
