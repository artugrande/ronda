/**
 * Cliente del contrato `pozo`.
 *
 * Lecturas por `queryContract`; escrituras por el ciclo completo (simular,
 * ensamblar, firmar, mandar, pollear) que ya implementa `contrato.ts`.
 */

import { PASSPHRASE_RED, POZO } from "./config";
import { addr, i128, invocarEn, servidor, type Firmante } from "./contrato";

// ---------------------------------------------------------------------------
// Tipos, espejo de `Vista` en el contrato
// ---------------------------------------------------------------------------

export type Vista = {
  /** Cuentas con capital adentro ahora. */
  participantes: number;
  /** Capital total. Lo que nadie puede perder. */
  principal: bigint;
  /** Rendimiento en juego: el generado hasta ahora o el congelado al cerrar. */
  premio: bigint;
  ronda: number;
  cierraAt: bigint;
  periodo: bigint;
  /** Puntos básicos anuales, o `null` si todavía no hay con qué calcularlo. */
  apyBps: bigint | null;
  /** `true` entre el cierre y el sorteo. */
  sorteoPendiente: boolean;
  /** La ronda de drand que decide, si hay un sorteo pendiente. */
  rondaDrand: bigint | null;
};

type VistaCruda = {
  participantes: number;
  principal: bigint;
  premio: bigint;
  ronda: number;
  cierra_at: bigint;
  periodo: bigint;
  apy_bps: bigint | null | undefined;
  sorteo_pendiente: boolean;
  ronda_drand: bigint | null | undefined;
};

function leerVista(c: VistaCruda): Vista {
  return {
    participantes: Number(c.participantes),
    principal: BigInt(c.principal),
    premio: BigInt(c.premio),
    ronda: Number(c.ronda),
    cierraAt: BigInt(c.cierra_at),
    periodo: BigInt(c.periodo),
    apyBps: c.apy_bps == null ? null : BigInt(c.apy_bps),
    sorteoPendiente: Boolean(c.sorteo_pendiente),
    rondaDrand: c.ronda_drand == null ? null : BigInt(c.ronda_drand),
  };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function estado(): Promise<Vista> {
  const { result } = await servidor.queryContract<VistaCruda>(
    POZO,
    "estado",
    {},
    PASSPHRASE_RED,
  );
  return leerVista(result);
}

/** Capital de una cuenta en el pozo. */
export async function saldo(usuario: string): Promise<bigint> {
  const { result } = await servidor.queryContract<bigint>(
    POZO,
    "saldo",
    { usuario },
    PASSPHRASE_RED,
  );
  return BigInt(result);
}

/** Chances de una cuenta en la ronda en curso, en puntos básicos. */
export async function chancesBps(usuario: string): Promise<number> {
  const { result } = await servidor.queryContract<bigint>(
    POZO,
    "chances_bps",
    { usuario },
    PASSPHRASE_RED,
  );
  return Number(result);
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

export const depositar = (usuario: string, monto: bigint, f: Firmante) =>
  invocarEn(POZO, usuario, "depositar", [addr(usuario), i128(monto)], f);

export const retirar = (usuario: string, monto: bigint, f: Firmante) =>
  invocarEn(POZO, usuario, "retirar", [addr(usuario), i128(monto)], f);

/** "12,34 %" a partir de puntos básicos. */
export function apyTexto(bps: bigint | null): string | null {
  if (bps == null) return null;
  const entero = bps / 100n;
  const dec = (bps % 100n).toString().padStart(2, "0");
  return `${entero},${dec} %`;
}
