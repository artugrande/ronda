/**
 * Keeper del pozo en una terminal: un bucle sobre `src/lib/keeper.ts`.
 *
 * Cierra la ronda cuando vence y trae la firma de drand cuando sale. Ninguna
 * de las dos acciones necesita permiso —cualquiera puede hacerlas— así que
 * este proceso solo paga las fees. Si se cae, otro lo reemplaza sin rotar
 * nada. En Vercel corre la misma lógica en `app/api/keeper/route.ts`.
 *
 *   SOLO_MIRAR=1 npm run keeper    # mira y cuenta qué haría, no firma nada
 *   npm run keeper                 # necesita KEEPER_SECRET con XLM para fees
 *
 * Probado en testnet: más de 20 rondas seguidas cerradas y sorteadas con
 * firmas reales de drand quicknet, sin intervención.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { info } from "../src/lib/drand";
import { paso, type Conexion } from "../src/lib/keeper";

const env = (clave: string, porDefecto?: string): string => {
  const v = process.env[clave] ?? porDefecto;
  if (v === undefined) {
    console.error(`falta la variable de entorno ${clave}`);
    process.exit(2);
  }
  return v;
};

const RPC_URL = env("RPC_URL", "https://soroban-testnet.stellar.org");
const PASSPHRASE = env("PASSPHRASE", "Test SDF Network ; September 2015");
const POZO = env("POZO", process.env.NEXT_PUBLIC_POZO);
const INTERVALO_MS = Number(env("INTERVALO_MS", "10000"));
const SOLO_MIRAR = process.env.SOLO_MIRAR === "1";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const firmante = SOLO_MIRAR ? null : Keypair.fromSecret(env("KEEPER_SECRET"));
  const drand = await info();
  const conexion: Conexion = {
    rpcUrl: RPC_URL,
    passphrase: PASSPHRASE,
    pozo: POZO,
    drand: { genesis: drand.genesis_time, periodo: drand.period },
    firmante,
  };

  console.log(`pozo    ${POZO}`);
  console.log(`rpc     ${RPC_URL}`);
  console.log(`drand   quicknet, genesis ${drand.genesis_time}, cada ${drand.period}s`);
  console.log(
    SOLO_MIRAR ? "modo    SOLO MIRAR — no firma nada" : `firma   ${firmante!.publicKey()}`,
  );
  console.log();

  for (;;) {
    try {
      const p = await paso(conexion);
      console.log(`· ${p.detalle}`);
      if (p.accion !== "espera") {
        const hecho = p.accion === "cerrar" ? "cerrada" : "sorteado";
        console.log(p.tx ? `  ✓ ${hecho} · tx ${p.tx}` : "  (solo mirar: no se firma)");
      }
    } catch (err) {
      console.error(`bucle: ${err instanceof Error ? err.message : err}`);
    }
    await dormir(INTERVALO_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
