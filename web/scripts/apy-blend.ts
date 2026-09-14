/**
 * Qué paga Blend hoy por prestar cada token en cada pool. Para elegir dónde
 * pone su capital el pozo.
 *
 *   npx tsx scripts/apy-blend.ts            # mainnet
 *   npx tsx scripts/apy-blend.ts testnet
 *
 * Direcciones de blend-utils/{mainnet,testnet}.contracts.json.
 */

import { PASSPHRASE, RPC, type Red } from "../src/lib/config";
import { porcentaje, tasaDeReserva } from "../src/lib/blend";

const POOLS: Record<Red, Record<string, string>> = {
  mainnet: {
    Fixed: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    YieldBlox: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS",
  },
  testnet: {
    TestnetV2: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
  },
};

const TOKENS: Record<Red, Record<string, string>> = {
  mainnet: {
    XLM: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    USDC: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  },
  testnet: {
    XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    USDC: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
  },
};

async function main() {
  const red: Red = process.argv[2] === "testnet" ? "testnet" : "mainnet";
  console.log(`Blend v2 en ${red}\n`);
  console.log("pool        token  presta al  piden al  uso     ofrecido        prestado");
  for (const [pool, poolId] of Object.entries(POOLS[red])) {
    for (const [token, tokenId] of Object.entries(TOKENS[red])) {
      try {
        const t = await tasaDeReserva(RPC[red], PASSPHRASE[red], poolId, tokenId);
        console.log(
          `${pool.padEnd(11)} ${token.padEnd(6)} ${porcentaje(t.apy).padStart(9)} ${porcentaje(t.aprPrestamo).padStart(9)} ${(t.utilizacion * 100).toFixed(1).padStart(5)} %  ${miles(t.oferta).padStart(14)}  ${miles(t.deuda).padStart(14)}`,
        );
      } catch (e) {
        console.log(`${pool.padEnd(11)} ${token.padEnd(6)} sin reserva (${e instanceof Error ? e.message.slice(0, 40) : e})`);
      }
    }
  }
}

const miles = (n: number) => Math.round(n).toLocaleString("es-AR");

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
