import { Networks } from "@stellar/stellar-sdk";

export type Red = "testnet" | "mainnet";

const RPC: Record<Red, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.stellar.org",
};

// Nunca hardcodear el passphrase: un mismatch da `tx_bad_auth`, que parece
// error de red pero no lo es. Ver CLAUDE.md.
const PASSPHRASE: Record<Red, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

function leerRed(valor: string | undefined): Red {
  return valor === "mainnet" ? "mainnet" : "testnet";
}

export const RED = leerRed(process.env.NEXT_PUBLIC_RED);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || RPC[RED];
export const PASSPHRASE_RED = PASSPHRASE[RED];

// ---------------------------------------------------------------------------
// Pozos
// ---------------------------------------------------------------------------

export type ClavePozo = "demo" | "semanal";

export type Pozo = {
  clave: ClavePozo;
  /** Contract id. */
  id: string;
  nombre: string;
  /** Cómo se explica la duración de la ronda en la pantalla. */
  ritmo: string;
};

/**
 * Direcciones en testnet, para que la app ande sin configurar nada. Las
 * variables de entorno las pisan, y en mainnet son obligatorias.
 */
const TESTNET: Record<ClavePozo, string> = {
  demo: "CCAM3QUEKETEFA4TL27TD63ZD5LB646NJJF4OOWRQBP2RZ6O4Q7HWHRZ",
  semanal: "",
};

function direccion(clave: ClavePozo, env: string | undefined): string {
  if (env) return env;
  return RED === "testnet" ? TESTNET[clave] : "";
}

/** Los pozos que muestra la app, en el orden de las pestañas. Sin id, no está. */
export const POZOS: Pozo[] = (
  [
    {
      clave: "semanal",
      id: direccion("semanal", process.env.NEXT_PUBLIC_POZO_SEMANAL),
      nombre: "Semanal",
      ritmo: "Se sortea una vez por semana",
    },
    {
      clave: "demo",
      id: direccion("demo", process.env.NEXT_PUBLIC_POZO),
      nombre: "Demo · 10 min",
      ritmo: "Una ronda cada 10 minutos, para verlo funcionar",
    },
  ] satisfies Pozo[]
).filter((p) => p.id.length > 0);

/** El pozo por defecto: el semanal si existe, si no el que haya. */
export const POZO = POZOS[0]?.id ?? "";
export const pozoConfigurado = POZOS.length > 0;

// ---------------------------------------------------------------------------
// Ronda rotativa (el primer producto, sigue en /ronda)
// ---------------------------------------------------------------------------

/** Contract id del contrato `ronda` desplegado. Vacío hasta que haya deploy. */
export const CONTRATO = process.env.NEXT_PUBLIC_CONTRATO || "";

/** Qué ronda muestra la app. El contrato soporta varias por deploy. */
export const RONDA_ID = Number(process.env.NEXT_PUBLIC_RONDA_ID || "0");

export const configurado = CONTRATO.length > 0;
