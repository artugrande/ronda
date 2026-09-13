# Chequeos previos compartidos por deploy.sh y ensayo-testnet.sh.
# Se usa con `source`, no se ejecuta suelto.

# soroban-sdk 27 pide esto. rust-toolchain.toml ya lo resuelve para quien use
# rustup; este chequeo es para quien tenga Rust del sistema, donde el pin no
# aplica y el error de cargo aparece recién después de bajar 178 crates.
MSRV=1.91.0

exigir_rustc() {
  command -v rustc >/dev/null || {
    echo "falta rustc. Instalá Rust desde https://rustup.rs" >&2
    return 1
  }

  local actual
  actual=$(rustc --version | awk '{print $2}')

  # El menor de los dos según orden de versión. Si no es el MSRV, estamos abajo.
  if [[ "$(printf '%s\n%s\n' "$MSRV" "$actual" | sort -V | head -1)" != "$MSRV" ]]; then
    echo "rustc $actual es muy viejo: soroban-sdk 27 pide $MSRV o más." >&2
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
    echo "Usá el binario precompilado, NO cargo install: compilar desde" >&2
    echo "crates.io falla en un build script de libdbus-sys. Ver SETUP.md." >&2
    return 1
  }
}
