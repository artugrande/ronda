/**
 * Cuánto USDC da Soroswap hoy por una cantidad de XLM o USDT0, con el mismo
 * código que usa la app para entrar con otra moneda. Para probar la
 * cotización sin wallet.
 *
 *   npx tsx scripts/cotizar.ts G... 10          # 10 XLM, mainnet
 *   npx tsx scripts/cotizar.ts G... 10 USDT0    # 10 USDT0
 *
 * La cuenta tiene que existir en mainnet: la simulación la usa de origen y
 * no firma ni gasta nada.
 */

import { PRINCIPAL } from "../src/lib/config";
import { aStroops, aTexto } from "../src/lib/montos";
import { cotizar } from "../src/lib/soroswap";

async function main() {
  const [cuenta, cuanto = "10", simbolo = "XLM"] = process.argv.slice(2);
  const entra = aStroops(cuanto);
  const p = PRINCIPAL;
  const moneda = p?.entradas?.monedas.find((m) => m.simbolo === simbolo);
  if (!cuenta || entra == null || entra <= 0n || !p || !moneda) {
    console.error("uso: npx tsx scripts/cotizar.ts G... [monto] [XLM|USDT0]");
    process.exit(2);
  }
  const c = await cotizar(p, cuenta, moneda, entra);
  const via = c.camino.length > 2 ? " (pasando por XLM)" : " (par directo)";
  console.log(`${aTexto(c.entra)} ${simbolo} → ${aTexto(c.sale, 4)} ${p.simbolo} en Soroswap${via}`);
  console.log(`mínimo aceptado (0,5 % de slippage): ${aTexto(c.minimo, 4)} ${p.simbolo}`);
  console.log(`precio: 1 ${simbolo} = ${(Number(c.sale) / Number(c.entra)).toFixed(4)} ${p.simbolo}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
