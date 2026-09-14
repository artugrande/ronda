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
  /** El token del pozo (SAC de XLM nativo en las dos redes). */
  token: string;
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
  // Zorrito en mainnet: semanal, tope 5.000 XLM, generando en el pool Fixed de Blend.
  mainnet: "CAR46DV7YNGNEOAI67SWY3WAQX2IGDWTHBRGDHJSW6EQQDR7XMGKUKQP",
  // Pozo de prueba en testnet, rondas de 10 min, generando en Blend TestnetV2.
  testnet: process.env.NEXT_PUBLIC_POZO_LOCAL || "CDNKUQX5YT5JYDF2UB3NZXI7UFKRKUTU7W23P42TLXUTGY4WE5IZI5X2",
};

/** SAC de XLM nativo y pool de Blend v2 con reserva XLM, por red. */
const TOKEN: Record<Red, string> = {
  mainnet: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  testnet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
};
export const BLEND_POOL: Record<Red, string> = {
  mainnet: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD", // Fixed
  testnet: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF", // TestnetV2
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
    token: TOKEN[red],
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
