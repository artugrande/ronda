/**
 * Cuánto USDC da Soroswap hoy por una cantidad de XLM, con el mismo código
 * que usa la app para "pagar con XLM". Para probar la cotización sin wallet.
 *
 *   npx tsx scripts/cotizar.ts G... 10        # 10 XLM, mainnet
 *
 * La cuenta tiene que existir en mainnet: la simulación la usa de origen y
 * no firma ni gasta nada.
 */

import { PASSPHRASE, RPC, SOROSWAP_ROUTER, XLM_SAC, type Pozo } from "../src/lib/config";
import { aStroops, aTexto } from "../src/lib/montos";
import { cotizar } from "../src/lib/soroswap";

const USDC_MAINNET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

async function main() {
  const [cuenta, cuanto = "10"] = process.argv.slice(2);
  const entra = aStroops(cuanto);
  if (!cuenta || entra == null || entra <= 0n) {
    console.error("uso: npx tsx scripts/cotizar.ts G... [XLM]");
    process.exit(2);
  }
  // Lo justo de un Pozo para cotizar: el resto no se usa.
  const p = {
    rpcUrl: RPC.mainnet,
    passphrase: PASSPHRASE.mainnet,
    token: USDC_MAINNET,
    simbolo: "USDC",
    entradaXlm: { router: SOROSWAP_ROUTER.mainnet, xlm: XLM_SAC.mainnet },
  } as Pozo;
  const c = await cotizar(p, cuenta, entra);
  console.log(`${aTexto(c.entra)} XLM → ${aTexto(c.sale, 4)} USDC en Soroswap`);
  console.log(`mínimo aceptado (0,5 % de slippage): ${aTexto(c.minimo, 4)} USDC`);
  console.log(`precio: 1 XLM = ${(Number(c.sale) / Number(c.entra)).toFixed(4)} USDC`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
