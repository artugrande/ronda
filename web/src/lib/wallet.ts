/**
 * Conexión de wallet.
 *
 * Todo el módulo se carga con `import()` dinámico dentro de funciones async: el
 * kit y los módulos de wallet tocan globals de browser y rompen en SSR si se
 * importan estáticamente desde un componente de Next. Ver CLAUDE.md §Freighter.
 *
 * La app habla con dos redes (el pozo principal en mainnet, el de prueba en
 * testnet): el kit es un singleton, así que cada página le fija su red antes
 * de conectar o firmar.
 */

import { PASSPHRASE_RED, RED, type Red } from "./config";

type Kit = typeof import("@creit.tech/stellar-wallets-kit").StellarWalletsKit;

let iniciado = false;
let redActual: Red = RED;

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

async function kit(red: Red = redActual): Promise<Kit> {
  const { StellarWalletsKit, Networks, SwkAppLightTheme } = await import(
    "@creit.tech/stellar-wallets-kit"
  );
  const network = red === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  if (!iniciado) {
    const [{ FreighterModule }, { xBullModule }, { LobstrModule }] =
      await Promise.all([
        import("@creit.tech/stellar-wallets-kit/modules/freighter"),
        import("@creit.tech/stellar-wallets-kit/modules/xbull"),
        import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
      ]);

    StellarWalletsKit.init({
      network,
      modules: [new FreighterModule(), new xBullModule(), new LobstrModule()],
      // El modal con los colores de Zorrito. El kit pinta en el DOM de la
      // página (no en shadow DOM) y sus divs de header y footer llevan la
      // clase `glass`, igual que nuestro header: globals.css la aísla.
      theme: {
        ...SwkAppLightTheme,
        background: "#ffffff",
        "background-secondary": "#fff6ea",
        primary: "#fd840e",
        "primary-foreground": "#ffffff",
        border: "rgba(253, 132, 14, 0.25)",
        "border-radius": "16px",
        "font-family": "var(--font-baloo), 'Baloo 2', system-ui, sans-serif",
      },
    });
    iniciado = true;
    redActual = red;
  } else if (red !== redActual) {
    StellarWalletsKit.setNetwork(network);
    redActual = red;
  }

  return StellarWalletsKit;
}

/**
 * Recordar que el usuario conectó en esta app. Sin esto, `getAddress` de
 * Freighter devuelve la dirección aunque el sitio nunca haya pedido permiso,
 * y después cada firma sale con el aviso "not currently connected".
 */
const MARCA = "zorrito:wallet";
const marcado = () => {
  try {
    return localStorage.getItem(MARCA) === "1";
  } catch {
    return false;
  }
};
const marcar = (si: boolean) => {
  try {
    if (si) localStorage.setItem(MARCA, "1");
    else localStorage.removeItem(MARCA);
  } catch {}
};

/** Abre el modal de wallets y devuelve la dirección conectada. */
export async function conectar(red: Red = RED): Promise<string> {
  const k = await kit(red);
  const { address } = await conLimite(k.authModal(), 120_000, "conectar");
  marcar(true);
  return address;
}

/** La dirección ya conectada en esta app, o `null` si no hay ninguna. */
export async function direccionActual(red: Red = RED): Promise<string | null> {
  if (!marcado()) return null;
  try {
    const k = await kit(red);
    const { address } = await conLimite(k.getAddress(), 10_000, "getAddress");
    return address || null;
  } catch {
    return null;
  }
}

export async function desconectar(): Promise<void> {
  marcar(false);
  try {
    const k = await kit();
    await k.disconnect();
  } catch {}
}

/**
 * Firma una transacción. En v2 `signTransaction` devuelve un objeto: hay que
 * usar `signedTxXdr`, no el valor entero.
 */
export async function firmar(xdrTx: string, passphrase: string = PASSPHRASE_RED): Promise<string> {
  const k = await kit();
  const { signedTxXdr } = await conLimite(
    k.signTransaction(xdrTx, { networkPassphrase: passphrase }),
    120_000,
    "firmar",
  );
  return signedTxXdr;
}
