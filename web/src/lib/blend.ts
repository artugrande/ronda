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
const DOCE = 1_000_000_000_000; // b_rate, d_rate e ir_mod tienen 12 decimales en v2
const UTIL_95 = 0.95;

export type TasaBlend = {
  /** Lo que cobra el que presta, anual, como fracción (0.032 = 3,2 %). */
  apy: number;
  /** Deuda / oferta del pool, como fracción. */
  utilizacion: number;
};

export async function tasaBlend(p: Pozo): Promise<TasaBlend | null> {
  if (!p.blendPool) return null;
  const servidor = servidorDe(p.rpcUrl);
  const [reserva, config] = await Promise.all([
    servidor
      .queryContract<Reserva>(p.blendPool, "get_reserve", { asset: p.token }, p.passphrase)
      .then((r) => r.result),
    servidor.queryContract<ConfigPool>(p.blendPool, "get_config", {}, p.passphrase).then((r) => r.result),
  ]);

  const oferta = Number(reserva.data.b_supply) * (Number(reserva.data.b_rate) / DOCE);
  const deuda = Number(reserva.data.d_supply) * (Number(reserva.data.d_rate) / DOCE);
  if (oferta <= 0) return { apy: 0, utilizacion: 0 };
  const util = Math.min(deuda / oferta, 1);

  const c = reserva.config;
  const objetivo = c.util / SIETE;
  const rBase = c.r_base / SIETE;
  const rOne = c.r_one / SIETE;
  const rTwo = c.r_two / SIETE;
  const rThree = c.r_three / SIETE;
  // ir_mod está acotado por Blend entre 0,1× y 10×: con 12 decimales vale
  // entre 1e11 y 1e13, con 9 (como en v1) entre 1e8 y 1e10. Se infiere.
  const irModCrudo = Number(reserva.data.ir_mod);
  const irMod = irModCrudo >= 5e10 ? irModCrudo / DOCE : irModCrudo / 1e9;

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
  return { apy, utilizacion: util };
}

/** "3,21 %" */
export function porcentaje(fraccion: number): string {
  return `${(fraccion * 100).toFixed(2).replace(".", ",")} %`;
}
