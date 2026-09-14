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
  mainnet: "",
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
