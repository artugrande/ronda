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
  nombre: string;
  /** Cómo se explica la duración de la ronda en la pantalla. */
  ritmo: string;
  /** La ruta de la app donde se muestra. */
  ruta: string;
};

/**
 * Direcciones fijas, para que la app ande sin configurar nada. Las variables
 * de entorno las pisan. Vacío = todavía no hay deploy de esa variante.
 */
const DIRECCIONES = {
  mainnet: process.env.NEXT_PUBLIC_POZO_MAINNET || "",
  // Pozo de prueba en testnet, rondas de 10 min, generando en Blend TestnetV2.
  testnet: process.env.NEXT_PUBLIC_POZO || "CDNKUQX5YT5JYDF2UB3NZXI7UFKRKUTU7W23P42TLXUTGY4WE5IZI5X2",
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
