/**
 * El APY que Blend está pagando ahora por prestar el token del pozo, leído
 * del pool. No hace falta esperar a que el pozo genere: la tasa vive en la
 * reserva.
 *
 * Es el modelo de interés de Blend v2 (`interest.rs`), con tres tramos según
 * la utilización del pool (deuda / oferta):
 *
 *   util ≤ objetivo:   tasa = ir_mod × (r_base + r_one × util / objetivo)
 *   objetivo < util ≤ 95 %:
 *                      tasa = ir_mod × (r_base + r_one + r_two × (util − objetivo) / (95 % − objetivo))
 *   util > 95 %:       tasa = ir_mod × (r_base + r_one + r_two) + r_three × (util − 95 %) / 5 %
 *
 * Eso es lo que pagan los que piden prestado. Lo que cobra el que presta es
 * esa tasa por la utilización, menos la parte que se lleva el backstop.
 */

import type { Pozo } from "./config";
import { servidorDe } from "./contrato";

type Reserva = {
  config: {
    util: number;
    r_base: number;
    r_one: number;
    r_two: number;
    r_three: number;
  };
  data: {
    b_rate: bigint;
    d_rate: bigint;
    ir_mod: bigint;
    b_supply: bigint;
    d_supply: bigint;
  };
};

type ConfigPool = { bstop_rate: number };

const SIETE = 10_000_000; // los parámetros de la curva tienen 7 decimales
const DOCE = 1_000_000_000_000; // b_rate y d_rate tienen 12 decimales en v2
const UTIL_95 = 0.95;

export type TasaBlend = {
  /** Lo que cobra el que presta, anual, como fracción (0.032 = 3,2 %). */
  apy: number;
  /** Lo que pagan los que piden prestado, anual, como fracción. */
  aprPrestamo: number;
  /** Deuda / oferta del pool, como fracción. */
  utilizacion: number;
  /** Oferta y deuda totales, en unidades del token (7 decimales). */
  oferta: number;
  deuda: number;
};

export async function tasaBlend(p: Pozo): Promise<TasaBlend | null> {
  if (!p.blendPool) return null;
  return tasaDeReserva(p.rpcUrl, p.passphrase, p.blendPool, p.token);
}

/** La tasa de cualquier reserva de cualquier pool de Blend v2. */
export async function tasaDeReserva(
  rpcUrl: string,
  passphrase: string,
  pool: string,
  token: string,
): Promise<TasaBlend> {
  const servidor = servidorDe(rpcUrl);
  const [reserva, config] = await Promise.all([
    servidor
      .queryContract<Reserva>(pool, "get_reserve", { asset: token }, passphrase)
      .then((r) => r.result),
    servidor.queryContract<ConfigPool>(pool, "get_config", {}, passphrase).then((r) => r.result),
  ]);

  const oferta = Number(reserva.data.b_supply) * (Number(reserva.data.b_rate) / DOCE);
  const deuda = Number(reserva.data.d_supply) * (Number(reserva.data.d_rate) / DOCE);
  if (oferta <= 0) return { apy: 0, aprPrestamo: 0, utilizacion: 0, oferta: 0, deuda: 0 };
  const util = Math.min(deuda / oferta, 1);

  const c = reserva.config;
  const objetivo = c.util / SIETE;
  const rBase = c.r_base / SIETE;
  const rOne = c.r_one / SIETE;
  const rTwo = c.r_two / SIETE;
  const rThree = c.r_three / SIETE;
  // ir_mod tiene 7 decimales (verificado en mainnet: 1_000_000 = 0,1×, el
  // piso que pone Blend cuando la utilización lleva mucho tiempo bajo el
  // objetivo).
  const irMod = Number(reserva.data.ir_mod) / SIETE;

  let tasaPrestamo: number;
  if (util <= objetivo) {
    tasaPrestamo = irMod * (rBase + (rOne * util) / objetivo);
  } else if (util <= UTIL_95) {
    tasaPrestamo = irMod * (rBase + rOne + (rTwo * (util - objetivo)) / (UTIL_95 - objetivo));
  } else {
    tasaPrestamo = irMod * (rBase + rOne + rTwo) + (rThree * (util - UTIL_95)) / (1 - UTIL_95);
  }

  const backstop = config.bstop_rate / SIETE;
  const apr = tasaPrestamo * util * (1 - backstop);
  // Blend capitaliza con cada interacción del pool; diario es una buena
  // aproximación para mostrar.
  const apy = Math.pow(1 + apr / 365, 365) - 1;
  return {
    apy,
    aprPrestamo: tasaPrestamo,
    utilizacion: util,
    oferta: oferta / SIETE,
    deuda: deuda / SIETE,
  };
}

/** "3,21 %" */
export function porcentaje(fraccion: number): string {
  return `${(fraccion * 100).toFixed(2).replace(".", ",")} %`;
}
