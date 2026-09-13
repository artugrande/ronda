/**
 * Un paso del keeper del pozo, para correrlo desde donde sea: el script que
 * hace un bucle en una terminal, o la función serverless que Vercel dispara
 * por cron y la página por visita.
 *
 * Cada paso mira el estado y hace, a lo sumo, una cosa:
 *
 *   - si hay un sorteo pendiente y drand ya publicó la ronda, sortea;
 *   - si no, si la ronda venció y hay participantes, la cierra;
 *   - si no, no hace nada y cuenta por qué.
 *
 * Ninguna de las dos acciones necesita permiso: cualquiera puede hacerlas, el
 * que las hace solo paga las fees. Por eso es seguro exponerlo en una URL
 * pública: un paso de más no firma nada que no haga falta, y dos pasos a la
 * vez compiten por una transacción que el contrato deja pasar una sola vez.
 *
 * No lee variables de entorno: recibe todo por parámetro y el que lo llama
 * decide de dónde salen.
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
import { beacon, descomprimirG1, momentoDe } from "./drand";
import { aTexto } from "./montos";

export type Conexion = {
  rpcUrl: string;
  passphrase: string;
  pozo: string;
  /** Genesis y período de drand quicknet, los mismos que tiene el contrato. */
  drand: { genesis: number; periodo: number };
  /** Sin firmante solo se mira y se cuenta qué se haría. */
  firmante: Keypair | null;
};

export type Paso =
  | { accion: "espera"; detalle: string }
  | { accion: "cerrar" | "sortear"; detalle: string; tx: string | null };

type Estado = {
  participantes: number;
  principal: bigint;
  premio: bigint;
  ronda: number;
  cierra_at: bigint;
  sorteo_pendiente: boolean;
  ronda_drand: bigint | number | null | undefined;
};

export async function estadoDelPozo(c: Conexion): Promise<Estado> {
  const servidor = new rpc.Server(c.rpcUrl);
  const { result } = await servidor.queryContract<Estado>(
    c.pozo,
    "estado",
    {},
    c.passphrase,
  );
  return result;
}

async function invocar(c: Conexion, firmante: Keypair, metodo: string, args: xdr.ScVal[]) {
  const servidor = new rpc.Server(c.rpcUrl);
  const cuenta = await servidor.getAccount(firmante.publicKey());
  const tx = new TransactionBuilder(new Account(cuenta.accountId(), cuenta.sequenceNumber()), {
    fee: BASE_FEE,
    networkPassphrase: c.passphrase,
  })
    .addOperation(new Contract(c.pozo).call(metodo, ...args))
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

/** Mira el pozo y hace a lo sumo una cosa. */
export async function paso(c: Conexion, fetchImpl: typeof fetch = fetch): Promise<Paso> {
  const e = await estadoDelPozo(c);
  const t = Math.floor(Date.now() / 1000);

  if (e.sorteo_pendiente) {
    const ronda = Number(e.ronda_drand);
    const sale = momentoDe(c.drand.genesis, c.drand.periodo, ronda);
    if (t < sale) {
      return {
        accion: "espera",
        detalle: `ronda ${e.ronda} cerrada; drand #${ronda} sale en ${sale - t}s`,
      };
    }
    const b = await beacon(ronda, fetchImpl);
    if (!b) {
      return { accion: "espera", detalle: `drand #${ronda} todavía no publicada` };
    }
    const firma = descomprimirG1(b.signature);
    const detalle = `drand #${ronda} publicada → sortear (premio ${aTexto(BigInt(e.premio))})`;
    const tx = c.firmante
      ? await invocar(c, c.firmante, "ejecutar_sorteo", [
          nativeToScVal(Buffer.from(firma, "hex"), { type: "bytes" }),
        ])
      : null;
    return { accion: "sortear", detalle, tx };
  }

  if (t >= Number(e.cierra_at)) {
    if (e.participantes === 0 || BigInt(e.principal) === 0n) {
      return {
        accion: "espera",
        detalle: `ronda ${e.ronda} vencida pero sin participantes`,
      };
    }
    const detalle = `ronda ${e.ronda} vencida hace ${t - Number(e.cierra_at)}s → cerrar`;
    const tx = c.firmante ? await invocar(c, c.firmante, "cerrar_ronda", []) : null;
    return { accion: "cerrar", detalle, tx };
  }

  return {
    accion: "espera",
    detalle:
      `ronda ${e.ronda}: ${e.participantes} participantes, ` +
      `${aTexto(BigInt(e.principal))} depositados, premio ${aTexto(BigInt(e.premio))}, ` +
      `cierra en ${Number(e.cierra_at) - t}s`,
  };
}
