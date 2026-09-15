/**
 * Cuánto USDC dan hoy por una cantidad de XLM o USDT0, en Soroswap y en el
 * DEX clásico, con el mismo código que usa la app para entrar con otra
 * moneda. Para probar la cotización sin wallet.
 *
 *   npx tsx scripts/cotizar.ts G... 10          # 10 XLM, mainnet
 *   npx tsx scripts/cotizar.ts G... 10 USDT0    # 10 USDT0
 *
 * La cuenta tiene que existir en mainnet: la simulación la usa de origen y
 * no firma ni gasta nada.
 */

import { PRINCIPAL } from "../src/lib/config";
import { aStroops, aTexto } from "../src/lib/montos";
import { cotizar, dondeCambia } from "../src/lib/cambio";
import { cotizarSdex } from "../src/lib/sdex";
import { cotizarSoroswap } from "../src/lib/soroswap";

async function main() {
  const [cuenta, cuanto = "10", simbolo = "XLM"] = process.argv.slice(2);
  const entra = aStroops(cuanto);
  const p = PRINCIPAL;
  const moneda = p?.entradas?.monedas.find((m) => m.simbolo === simbolo);
  if (!cuenta || entra == null || entra <= 0n || !p || !moneda) {
    console.error("uso: npx tsx scripts/cotizar.ts G... [monto] [XLM|USDT0]");
    process.exit(2);
  }
  const [soroswap, sdex] = await Promise.allSettled([
    cotizarSoroswap(p, cuenta, moneda, entra),
    cotizarSdex(p, moneda, entra),
  ]);
  for (const [nombre, r] of [["Soroswap", soroswap], ["DEX clásico", sdex]] as const) {
    if (r.status === "fulfilled") {
      console.log(`${nombre.padEnd(12)} ${aTexto(r.value.sale, 4)} ${p.simbolo} (${dondeCambia(r.value)})`);
    } else {
      console.log(`${nombre.padEnd(12)} no cotiza (${r.reason instanceof Error ? r.reason.message : r.reason})`);
    }
  }
  const c = await cotizar(p, cuenta, moneda, entra);
  console.log(`\ngana: ${aTexto(c.entra)} ${simbolo} → ${aTexto(c.sale, 4)} ${p.simbolo} en ${dondeCambia(c)}`);
  console.log(`mínimo aceptado (0,5 % de slippage): ${aTexto(c.minimo, 4)} ${p.simbolo}`);
  console.log(`precio: 1 ${simbolo} = ${(Number(c.sale) / Number(c.entra)).toFixed(4)} ${p.simbolo}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
