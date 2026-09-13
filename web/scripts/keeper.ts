/**
 * Keeper del pozo: cierra la ronda cuando vence y trae la firma de drand
 * cuando sale. Ninguna de las dos acciones necesita permiso —cualquiera puede
 * hacerlas— así que este proceso solo paga las fees. Si se cae, otro lo
 * reemplaza sin que haga falta rotar nada.
 *
 *   SOLO_MIRAR=1 npm run keeper    # mira y cuenta qué haría, no firma nada
 *   npm run keeper                 # necesita KEEPER_SECRET con XLM para fees
 *
 * NUNCA SE CORRIÓ CONTRA LA RED. El primer sorteo real en testnet es el
 * primer test de la verificación BLS on-chain con una firma de drand de
 * verdad; hasta ahí, la única evidencia son los tests con una clave propia.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { beacon, descomprimirG1, info, momentoDe } from "../src/lib/drand";
import { aTexto } from "../src/lib/montos";

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
const POZO = env("POZO");
const INTERVALO_MS = Number(env("INTERVALO_MS", "10000"));
const SOLO_MIRAR = process.env.SOLO_MIRAR === "1";

const servidor = new rpc.Server(RPC_URL);

type Estado = {
  participantes: number;
  principal: bigint;
  premio: bigint;
  ronda: number;
  cierra_at: bigint;
  sorteo_pendiente: boolean;
  ronda_drand: bigint | number | null | undefined;
};

async function estado(): Promise<Estado> {
  const { result } = await servidor.queryContract<Estado>(
    POZO,
    "estado",
    {},
    PASSPHRASE,
  );
  return result;
}

async function invocar(
  firmante: Keypair,
  metodo: string,
  args: xdr.ScVal[],
): Promise<string> {
  const cuenta = await servidor.getAccount(firmante.publicKey());
  const tx = new TransactionBuilder(
    new Account(cuenta.accountId(), cuenta.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase: PASSPHRASE },
  )
    .addOperation(new Contract(POZO).call(metodo, ...args))
    .setTimeout(60)
    .build();

  const sim = await servidor.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulación de ${metodo}: ${sim.error}`);
  }
  const lista = rpc.assembleTransaction(tx, sim).build();
  lista.sign(firmante);

  const enviada = await servidor.sendTransaction(lista);
  if (enviada.status === "ERROR") {
    throw new Error(`envío de ${metodo}: ${JSON.stringify(enviada.errorResult)}`);
  }
  const r = await servidor.pollTransaction(enviada.hash, { attempts: 60 });
  if (r.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${metodo} no entró: ${r.status}`);
  }
  return enviada.hash;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ahora = () => Math.floor(Date.now() / 1000);

async function main() {
  const firmante = SOLO_MIRAR ? null : Keypair.fromSecret(env("KEEPER_SECRET"));
  const drand = await info();

  console.log(`pozo    ${POZO}`);
  console.log(`rpc     ${RPC_URL}`);
  console.log(`drand   quicknet, genesis ${drand.genesis_time}, cada ${drand.period}s`);
  console.log(
    SOLO_MIRAR ? "modo    SOLO MIRAR — no firma nada" : `firma   ${firmante!.publicKey()}`,
  );
  console.log();

  for (;;) {
    try {
      const e = await estado();
      const t = ahora();

      if (e.sorteo_pendiente) {
        const ronda = Number(e.ronda_drand);
        const sale = momentoDe(drand.genesis_time, drand.period, ronda);
        if (t < sale) {
          console.log(`· ronda ${e.ronda} cerrada; drand #${ronda} sale en ${sale - t}s`);
        } else {
          const b = await beacon(ronda);
          if (!b) {
            console.log(`· drand #${ronda} todavía no publicada, reintento`);
          } else {
            const firma = descomprimirG1(b.signature);
            console.log(
              `· drand #${ronda} publicada → sortear (premio ${aTexto(BigInt(e.premio))})`,
            );
            if (firmante) {
              const hash = await invocar(firmante, "ejecutar_sorteo", [
                nativeToScVal(Buffer.from(firma, "hex"), { type: "bytes" }),
              ]);
              console.log(`  ✓ sorteado · tx ${hash}`);
            } else {
              console.log("  (solo mirar: no se firma)");
            }
          }
        }
      } else if (t >= Number(e.cierra_at)) {
        if (e.participantes === 0 || e.principal === 0n) {
          console.log(`· ronda ${e.ronda} vencida pero sin participantes; espero`);
        } else {
          console.log(
            `· ronda ${e.ronda} vencida hace ${t - Number(e.cierra_at)}s → cerrar`,
          );
          if (firmante) {
            const hash = await invocar(firmante, "cerrar_ronda", []);
            console.log(`  ✓ cerrada · tx ${hash}`);
          } else {
            console.log("  (solo mirar: no se firma)");
          }
        }
      } else {
        console.log(
          `· ronda ${e.ronda}: ${e.participantes} participantes, ` +
            `${aTexto(BigInt(e.principal))} depositados, premio ${aTexto(BigInt(e.premio))}, ` +
            `cierra en ${Number(e.cierra_at) - t}s`,
        );
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
