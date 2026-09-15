import { Networks } from "@stellar/stellar-sdk";

export type Red = "testnet" | "mainnet";

export const RPC: Record<Red, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
};

// Nunca hardcodear el passphrase: un mismatch da `tx_bad_auth`, que parece
// error de red pero no lo es. Ver CLAUDE.md.
export const PASSPHRASE: Record<Red, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

function leerRed(valor: string | undefined): Red {
  return valor === "mainnet" ? "mainnet" : "testnet";
}

/** La red por defecto (la de la ronda rotativa y de lo que no es un pozo). */
export const RED = leerRed(process.env.NEXT_PUBLIC_RED);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || RPC[RED];
export const PASSPHRASE_RED = PASSPHRASE[RED];

// ---------------------------------------------------------------------------
// Pozos: el principal vive en mainnet, el de prueba en testnet
// ---------------------------------------------------------------------------

export type ClavePozo = "principal" | "test";

/** Una moneda con la que se puede entrar al pozo, cambiándola en Soroswap. */
export type Entrada = {
  simbolo: string;
  /** Contract id (SAC). */
  token: string;
  /** Código e issuer, o `null` si es XLM nativo. Para saber si la wallet la tiene. */
  activo: { code: string; issuer: string } | null;
  /**
   * Caminos posibles hasta el token del pozo, en orden de preferencia. Se
   * cotizan todos y gana el que más da: un par directo puede tener menos
   * liquidez que ir por XLM.
   */
  caminos: string[][];
};

export type Pozo = {
  clave: ClavePozo;
  /** Contract id. */
  id: string;
  red: Red;
  rpcUrl: string;
  passphrase: string;
  /** Contract id del token del pozo (un SAC). */
  token: string;
  /** Cómo se muestra el token: "USDC", "XLM". */
  simbolo: string;
  /** Código e issuer del activo, o `null` si es XLM nativo. Para la trustline. */
  activo: { code: string; issuer: string } | null;
  /** Horizon de la red, para leer balances y trustlines de la wallet. */
  horizon: string;
  /** El pool de Blend v2 donde genera, para leer el APY. */
  blendPool: string;
  /**
   * Con qué otras monedas se puede entrar: se cambian por el token del pozo
   * en Soroswap, en la wallet del usuario, y el pozo recibe el token de
   * siempre. `null` si no hay router o el pozo es de XLM.
   */
  entradas: { router: string; monedas: Entrada[] } | null;
  nombre: string;
  /** Cómo se explica la duración de la ronda en la pantalla. */
  ritmo: string;
  /** La ruta de la app donde se muestra. */
  ruta: string;
};

/**
 * Las direcciones de los pozos viven acá, en el código, y en ningún otro
 * lado: un deploy nuevo es un commit. Las variables de entorno no las pisan,
 * para que un valor viejo olvidado en Vercel no apunte la app a un pozo
 * anterior. Para desarrollo local, NEXT_PUBLIC_POZO_LOCAL apunta el pozo de
 * prueba a otro.
 */
const DIRECCIONES = {
  // Zorrito en mainnet: USDC, semanal, tope 5.000, generando en el pool Fixed
  // de Blend. (El primer deploy, CAR46DV7…UKQP, era de XLM y pagaba 0 %.)
  mainnet: "CBPOMGHGCWH2QMG4V4FTZKGBCEN7K37R2OIDGD5VWBAKYTOWG7CDCGGA",
  // Pozo de prueba en testnet, rondas de 10 min, generando en Blend TestnetV2.
  testnet: process.env.NEXT_PUBLIC_POZO_LOCAL || "CDNKUQX5YT5JYDF2UB3NZXI7UFKRKUTU7W23P42TLXUTGY4WE5IZI5X2",
};

/**
 * El token de cada red y el pool de Blend v2 donde genera. En mainnet, USDC
 * en el pool Fixed: es lo que la gente pide prestado en Stellar (81 % de
 * utilización, ~8 % anual para el que presta). XLM ahí paga 0 %. En testnet,
 * XLM nativo, que no necesita trustline ni conseguir USDC de prueba.
 */
const TOKEN: Record<Red, { id: string; simbolo: string; activo: Pozo["activo"] }> = {
  mainnet: {
    id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    simbolo: "USDC",
    activo: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  },
  testnet: {
    id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    simbolo: "XLM",
    activo: null,
  },
};
export const BLEND_POOL: Record<Red, string> = {
  mainnet: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD", // Fixed
  testnet: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF", // TestnetV2
};
export const HORIZON: Record<Red, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};
/** SAC de XLM nativo, por red. */
export const XLM_SAC: Record<Red, string> = {
  mainnet: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  testnet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
};
/** Router de Soroswap, de soroswap/core public/{mainnet,testnet}.contracts.json. */
export const SOROSWAP_ROUTER: Record<Red, string> = {
  mainnet: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
  testnet: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
};
/** USDT0 (Tether vía LayerZero) en mainnet, de soroswap/token-list. */
export const USDT0_MAINNET = {
  token: "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
  activo: { code: "USDT0", issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q" },
};

/**
 * Las monedas de entrada del pozo de USDC en mainnet: XLM (par directo con
 * USDC) y USDT0 (directo, o por XLM si el par directo da menos). En testnet
 * el pozo es de XLM y no hay nada que cambiar.
 */
function entradasDe(red: Red): Pozo["entradas"] {
  const t = TOKEN[red];
  if (!t.activo) return null;
  const xlm = XLM_SAC[red];
  const monedas: Entrada[] = [{ simbolo: "XLM", token: xlm, activo: null, caminos: [[xlm, t.id]] }];
  if (red === "mainnet") {
    monedas.push({
      simbolo: "USDT0",
      token: USDT0_MAINNET.token,
      activo: USDT0_MAINNET.activo,
      caminos: [
        [USDT0_MAINNET.token, t.id],
        [USDT0_MAINNET.token, xlm, t.id],
      ],
    });
  }
  return { router: SOROSWAP_ROUTER[red], monedas };
}

function armar(clave: ClavePozo, red: Red, id: string): Pozo | null {
  if (!id) return null;
  const principal = clave === "principal";
  return {
    clave,
    id,
    red,
    rpcUrl: RPC[red],
    passphrase: PASSPHRASE[red],
    token: TOKEN[red].id,
    simbolo: TOKEN[red].simbolo,
    activo: TOKEN[red].activo,
    horizon: HORIZON[red],
    blendPool: BLEND_POOL[red],
    entradas: entradasDe(red),
    nombre: principal ? "Zorrito" : "Pozo de prueba",
    ritmo: principal
      ? "Se sortea una vez por semana"
      : "Rondas de 10 minutos en testnet, para verlo funcionar",
    ruta: principal ? "/" : "/test",
  };
}

/** El pozo de prueba: testnet, rondas cortas. Solo se enlaza desde Docs. */
export const TEST: Pozo | null = armar("test", "testnet", DIRECCIONES.testnet);

/**
 * El pozo de la home. Mainnet cuando está desplegado; hasta entonces, el de
 * prueba, con la red a la vista, para que la app nunca quede vacía.
 */
export const PRINCIPAL: Pozo | null =
  armar("principal", "mainnet", DIRECCIONES.mainnet) ??
  (TEST ? { ...TEST, clave: "principal", ruta: "/" } : null);

/** Todos los pozos que hay que atender (keeper) y mostrar. Sin repetidos. */
export const POZOS: Pozo[] = [PRINCIPAL, TEST].filter(
  (p, i, todos): p is Pozo => p != null && todos.findIndex((q) => q?.id === p.id) === i,
);

export const pozoConfigurado = POZOS.length > 0;

// ---------------------------------------------------------------------------
// Ronda rotativa (el primer producto, sigue en /ronda)
// ---------------------------------------------------------------------------

/** Contract id del contrato `ronda` desplegado. Vacío hasta que haya deploy. */
export const CONTRATO = process.env.NEXT_PUBLIC_CONTRATO || "";

/** Qué ronda muestra la app. El contrato soporta varias por deploy. */
export const RONDA_ID = Number(process.env.NEXT_PUBLIC_RONDA_ID || "0");

export const configurado = CONTRATO.length > 0;
