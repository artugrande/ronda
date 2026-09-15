/**
 * Qué paga Blend hoy por prestar cada token en cada pool. Para elegir dónde
 * pone su capital el pozo, y para ver qué tokens tienen reserva (si un
 * token no aparece, Blend no lo presta y no puede ser el token de un pozo).
 *
 *   npx tsx scripts/apy-blend.ts            # mainnet
 *   npx tsx scripts/apy-blend.ts testnet
 *
 * Direcciones de los pools de blend-utils/{mainnet,testnet}.contracts.json.
 * Las reservas se leen del pool (`get_reserve_list`), y el símbolo de cada
 * token, del token.
 */

import { PASSPHRASE, RPC, type Red } from "../src/lib/config";
import { porcentaje, tasaDeReserva } from "../src/lib/blend";
import { servidorDe } from "../src/lib/contrato";

const POOLS: Record<Red, Record<string, string>> = {
  mainnet: {
    Fixed: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    YieldBlox: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS",
  },
  testnet: {
    TestnetV2: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
  },
};

async function main() {
  const red: Red = process.argv[2] === "testnet" ? "testnet" : "mainnet";
  const servidor = servidorDe(RPC[red]);
  console.log(`Blend v2 en ${red}\n`);
  console.log("pool        token   presta al  piden al  uso     ofrecido        prestado   contrato");
  for (const [pool, poolId] of Object.entries(POOLS[red])) {
    const { result: reservas } = await servidor.queryContract<string[]>(
      poolId,
      "get_reserve_list",
      {},
      PASSPHRASE[red],
    );
    for (const tokenId of reservas) {
      const simbolo = await simboloDe(servidor, tokenId, PASSPHRASE[red]);
      try {
        const t = await tasaDeReserva(RPC[red], PASSPHRASE[red], poolId, tokenId);
        console.log(
          `${pool.padEnd(11)} ${simbolo.padEnd(7)} ${porcentaje(t.apy).padStart(9)} ${porcentaje(t.aprPrestamo).padStart(9)} ${(t.utilizacion * 100).toFixed(1).padStart(5)} %  ${miles(t.oferta).padStart(14)}  ${miles(t.deuda).padStart(14)}   ${tokenId}`,
        );
      } catch (e) {
        console.log(`${pool.padEnd(11)} ${simbolo.padEnd(7)} no se pudo leer (${e instanceof Error ? e.message.slice(0, 40) : e})`);
      }
    }
  }
}

async function simboloDe(servidor: ReturnType<typeof servidorDe>, token: string, passphrase: string) {
  try {
    const { result } = await servidor.queryContract<string>(token, "symbol", {}, passphrase);
    // El SAC de XLM nativo dice "native".
    return result === "native" ? "XLM" : result;
  } catch {
    return token.slice(0, 6) + "…";
  }
}

const miles = (n: number) => Math.round(n).toLocaleString("es-AR");

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
