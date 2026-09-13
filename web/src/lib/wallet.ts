/**
 * Conexión de wallet.
 *
 * Todo el módulo se carga con `import()` dinámico dentro de funciones async: el
 * kit y los módulos de wallet tocan globals de browser y rompen en SSR si se
 * importan estáticamente desde un componente de Next. Ver CLAUDE.md §Freighter.
 */

import { PASSPHRASE_RED, RED } from "./config";

type Kit = typeof import("@creit.tech/stellar-wallets-kit").StellarWalletsKit;

let iniciado = false;

/**
 * Si la extensión no está instalada, algunas wallets cuelgan para siempre en
 * vez de rechazar. Un timeout convierte eso en un error que la UI puede mostrar.
 */
function conLimite<T>(p: Promise<T>, ms: number, que: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rechazar) =>
      setTimeout(
        () => rechazar(new Error(`${que}: la wallet no respondió en ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

async function kit(): Promise<Kit> {
  const { StellarWalletsKit, Networks } = await import(
    "@creit.tech/stellar-wallets-kit"
  );

  if (!iniciado) {
    const [{ FreighterModule }, { xBullModule }, { LobstrModule }] =
      await Promise.all([
        import("@creit.tech/stellar-wallets-kit/modules/freighter"),
        import("@creit.tech/stellar-wallets-kit/modules/xbull"),
        import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
      ]);

    StellarWalletsKit.init({
      network: RED === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
      modules: [new FreighterModule(), new xBullModule(), new LobstrModule()],
    });
    iniciado = true;
  }

  return StellarWalletsKit;
}

/** Abre el modal de wallets y devuelve la dirección conectada. */
export async function conectar(): Promise<string> {
  const k = await kit();
  const { address } = await conLimite(k.authModal(), 120_000, "conectar");
  return address;
}

/** La dirección ya conectada, o `null` si no hay ninguna. */
export async function direccionActual(): Promise<string | null> {
  try {
    const k = await kit();
    const { address } = await conLimite(k.getAddress(), 10_000, "getAddress");
    return address || null;
  } catch {
    return null;
  }
}

export async function desconectar(): Promise<void> {
  const k = await kit();
  await k.disconnect();
}

/**
 * Firma una transacción. En v2 `signTransaction` devuelve un objeto: hay que
 * usar `signedTxXdr`, no el valor entero.
 */
export async function firmar(xdrTx: string): Promise<string> {
  const k = await kit();
  const { signedTxXdr } = await conLimite(
    k.signTransaction(xdrTx, { networkPassphrase: PASSPHRASE_RED }),
    120_000,
    "firmar",
  );
  return signedTxXdr;
}
