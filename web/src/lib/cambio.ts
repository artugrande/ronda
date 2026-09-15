/**
 * Entrar al pozo pagando con otra moneda (XLM, USDT0). El pozo es de USDC y
 * no cambia: el cambio pasa por la wallet del usuario y lo que sale es lo
 * que se deposita. Dos firmas: el cambio y el depósito.
 *
 * Hay dos lugares donde cambiar en Stellar, y ninguno gana siempre:
 *
 *   - Soroswap, un AMM en Soroban (`soroswap.ts`);
 *   - el DEX clásico, libro de órdenes y pools nativos, por path payment
 *     (`sdex.ts`). Es lo que usan Freighter y Lobstr.
 *
 * Se cotiza en los dos a la vez y se cambia por el que más da en ese
 * momento. Una vía sin par para esa moneda no cotiza y queda afuera; si las
 * dos fallan, no hay cotización.
 */

import type { Entrada, Pozo } from "./config";
import type { Firmante } from "./contrato";
import { cambiarSdex, cotizarSdex, type CotizacionSdex } from "./sdex";
import { cambiarSoroswap, cotizarSoroswap, type CotizacionSoroswap } from "./soroswap";

/** Cuánto menos que la cotización se acepta recibir, en puntos básicos. */
export const SLIPPAGE_BPS = 50n;

export type Cotizacion = CotizacionSoroswap | CotizacionSdex;

/** Cómo se cuenta en pantalla por dónde va el cambio. */
export function dondeCambia(c: Cotizacion): string {
  if (c.via === "sdex") return c.camino.length > 0 ? "el DEX de Stellar, pasando por otro activo" : "el DEX de Stellar";
  return c.camino.length > 2 ? "Soroswap, pasando por XLM" : "Soroswap";
}

/** La mejor cotización de las dos vías para `entra` de `moneda`. */
export async function cotizar(
  p: Pozo,
  usuario: string,
  moneda: Entrada,
  entra: bigint,
): Promise<Cotizacion> {
  const intentos: Promise<Cotizacion>[] = [
    cotizarSoroswap(p, usuario, moneda, entra),
    cotizarSdex(p, moneda, entra),
  ];
  const validas = (await Promise.allSettled(intentos))
    .filter((r): r is PromiseFulfilledResult<Cotizacion> => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => (a.sale > b.sale ? -1 : a.sale < b.sale ? 1 : 0));
  if (validas.length === 0) throw new Error(`nadie cotiza ${moneda.simbolo} → ${p.simbolo}`);
  return validas[0];
}

/** Hace el cambio por la vía de la cotización y devuelve cuánto se recibió. */
export function cambiar(p: Pozo, usuario: string, c: Cotizacion, firmar: Firmante): Promise<bigint> {
  return c.via === "sdex" ? cambiarSdex(p, usuario, c, firmar) : cambiarSoroswap(p, usuario, c, firmar);
}
