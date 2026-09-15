/**
 * El ciclo de transacción contra cualquier contrato, y los helpers de XDR
 * que usan los clientes del pozo y del cambio de moneda.
 *
 * Lecturas por `queryContract`, que resuelve el spec desde el wasm desplegado y
 * decodifica solo. Escrituras por el ciclo completo que exige CLAUDE.md:
 * simular, ensamblar, firmar, mandar y **pollear** — `sendTransaction` devuelve
 * PENDING, no éxito.
 */

import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { PASSPHRASE_RED, RPC_URL } from "./config";

export const servidor = new rpc.Server(RPC_URL);

/** A qué red hablar. Cada pozo trae la suya. */
export type Conexion = { rpcUrl: string; passphrase: string };
export const CONEXION_POR_DEFECTO: Conexion = { rpcUrl: RPC_URL, passphrase: PASSPHRASE_RED };

const servidores = new Map<string, rpc.Server>([[RPC_URL, servidor]]);

/**
 * Fee de inclusión (stroops) para entrar en el próximo ledger. En testnet la
 * mínima alcanza; en mainnet hay momentos de demanda en los que 100 stroops
 * quedan afuera con `tx_insufficient_fee`. Se le pregunta a la red y se paga
 * un poco más que la mediana, con techo de 0,05 XLM.
 */
export async function feeDeInclusion(servidor: rpc.Server): Promise<string> {
  const MINIMA = 100;
  const TECHO = 500_000;
  try {
    const stats = await servidor.getFeeStats();
    const p = Number(stats.sorobanInclusionFee.p70 || stats.sorobanInclusionFee.p50 || MINIMA);
    return String(Math.min(Math.max(p, MINIMA) * 2, TECHO));
  } catch {
    return String(MINIMA);
  }
}

/** Un `rpc.Server` por URL, reusado. */
export function servidorDe(rpcUrl: string): rpc.Server {
  let s = servidores.get(rpcUrl);
  if (!s) {
    s = new rpc.Server(rpcUrl);
    servidores.set(rpcUrl, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

export type Firmante = (xdrTx: string) => Promise<string>;

export const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
export const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
export const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
export const addr = (a: string) => new Address(a).toScVal();
export const vecAddr = (as: string[]) =>
  xdr.ScVal.scvVec(as.map((a) => new Address(a).toScVal()));
export const bytes32 = (hex: string) =>
  nativeToScVal(Buffer.from(hex.replace(/^0x/, ""), "hex"), { type: "bytes" });

/**
 * Simula, ensambla, firma, manda y espera. Devuelve el hash de la transacción.
 *
 * Saltear la simulación produce fallos crípticos, y `sendTransaction` devuelve
 * PENDING: sin el poll no sabés si entró.
 */
export async function invocarEn(
  contratoId: string,
  fuente: string,
  metodo: string,
  args: xdr.ScVal[],
  firmar: Firmante,
  cx: Conexion = CONEXION_POR_DEFECTO,
): Promise<string> {
  return (await invocarConRetorno(contratoId, fuente, metodo, args, firmar, cx)).hash;
}

/**
 * El ciclo completo, y además lo que devolvió el contrato (para un swap, la
 * cantidad recibida). `retorno` es `null` si el RPC no lo trajo.
 */
export async function invocarConRetorno(
  contratoId: string,
  fuente: string,
  metodo: string,
  args: xdr.ScVal[],
  firmar: Firmante,
  cx: Conexion = CONEXION_POR_DEFECTO,
): Promise<{ hash: string; retorno: xdr.ScVal | null }> {
  const servidor = servidorDe(cx.rpcUrl);
  const [cuenta, fee] = await Promise.all([servidor.getAccount(fuente), feeDeInclusion(servidor)]);
  const contrato = new Contract(contratoId);

  const tx = new TransactionBuilder(
    new Account(cuenta.accountId(), cuenta.sequenceNumber()),
    { fee, networkPassphrase: cx.passphrase },
  )
    .addOperation(contrato.call(metodo, ...args))
    .setTimeout(60)
    .build();

  const simulacion = await servidor.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulacion)) {
    throw new Error(`la simulación falló: ${simulacion.error}`);
  }

  const ensamblada = rpc.assembleTransaction(tx, simulacion).build();
  const firmada = await firmar(ensamblada.toXDR());

  const enviada = await servidor.sendTransaction(
    TransactionBuilder.fromXDR(firmada, cx.passphrase),
  );
  if (enviada.status === "ERROR") {
    throw new Error(`el envío falló: ${JSON.stringify(enviada.errorResult)}`);
  }

  const resultado = await servidor.pollTransaction(enviada.hash, {
    attempts: 60,
  });
  if (resultado.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`la transacción no entró: ${resultado.status}`);
  }
  return { hash: enviada.hash, retorno: resultado.returnValue ?? null };
}
