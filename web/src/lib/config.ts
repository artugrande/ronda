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

/** Contract id del contrato `ronda` desplegado. Vacío hasta que haya deploy. */
export const CONTRATO = process.env.NEXT_PUBLIC_CONTRATO || "";

/** Qué ronda muestra la app. El contrato soporta varias por deploy. */
export const RONDA_ID = Number(process.env.NEXT_PUBLIC_RONDA_ID || "0");

export const configurado = CONTRATO.length > 0;

/** Contract id del `pozo` desplegado. Vacío hasta que haya deploy. */
export const POZO = process.env.NEXT_PUBLIC_POZO || "";
export const pozoConfigurado = POZO.length > 0;
