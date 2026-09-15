/**
 * Entrar al pozo pagando con XLM. El pozo es de USDC y no cambia: el swap pasa
 * por la wallet del usuario, en Soroswap, y lo que sale del swap es lo que se
 * deposita. Dos firmas: el swap y el depósito.
 *
 * El swap es `swap_exact_tokens_for_tokens` del router: entra un monto exacto
 * de XLM y sale lo que dé el pool, con un piso (`amount_out_min`) para que un
 * cambio de precio entre la cotización y la firma no sorprenda. `to` es el
 * que paga y el que recibe: el router le pide `require_auth` a esa dirección.
 *
 * La cotización es `router_get_amounts_out`, una lectura: simula la llamada y
 * lee el resultado. No pasa por `queryContract` porque ese resuelve los tipos
 * desde el spec y el router devuelve un `Result`; armar el XDR a mano y
 * decodificar con `scValToNative` no depende de cómo lo interprete el SDK.
 */

import {
  Account,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Pozo } from "./config";
import { addr, i128, invocarConRetorno, servidorDe, u64, vecAddr, type Firmante } from "./contrato";

/** Cuánto menos que la cotización se acepta recibir, en puntos básicos. */
export const SLIPPAGE_BPS = 50n;
/** Segundos que la wallet tiene para firmar antes de que el router rechace el swap. */
const PLAZO_S = 600;

export type Cotizacion = {
  /** XLM que entran, en stroops. */
  entra: bigint;
  /** Token del pozo que sale hoy, en stroops. */
  sale: bigint;
  /** Lo mínimo que se acepta recibir: `sale` menos el slippage. */
  minimo: bigint;
};

function camino(p: Pozo): [string, string] {
  if (!p.entradaXlm) throw new Error(`el pozo ya es de ${p.simbolo}`);
  return [p.entradaXlm.xlm, p.token];
}

/** Cuánto USDC da Soroswap hoy por `entra` stroops de XLM. */
export async function cotizar(p: Pozo, usuario: string, entra: bigint): Promise<Cotizacion> {
  if (!p.entradaXlm) throw new Error(`el pozo ya es de ${p.simbolo}`);
  const servidor = servidorDe(p.rpcUrl);
  const cuenta = await servidor.getAccount(usuario);
  const tx = new TransactionBuilder(new Account(cuenta.accountId(), cuenta.sequenceNumber()), {
    fee: "100",
    networkPassphrase: p.passphrase,
  })
    .addOperation(
      new Contract(p.entradaXlm.router).call(
        "router_get_amounts_out",
        i128(entra),
        vecAddr(camino(p)),
      ),
    )
    .setTimeout(60)
    .build();
  const sim = await servidor.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Soroswap no cotiza: ${sim.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error("Soroswap no cotiza");
  }
  const montos = scValToNative(sim.result.retval) as bigint[];
  const sale = BigInt(montos[montos.length - 1]);
  return { entra, sale, minimo: sale - (sale * SLIPPAGE_BPS) / 10_000n };
}

/**
 * Hace el swap en la wallet del usuario y devuelve cuánto del token del pozo
 * recibió, en stroops. Si el RPC no trae el valor de retorno, devuelve el
 * mínimo aceptado: lo que seguro está en la wallet.
 */
export async function cambiar(
  p: Pozo,
  usuario: string,
  c: Cotizacion,
  firmar: Firmante,
): Promise<bigint> {
  if (!p.entradaXlm) throw new Error(`el pozo ya es de ${p.simbolo}`);
  const plazo = BigInt(Math.floor(Date.now() / 1000) + PLAZO_S);
  const { retorno } = await invocarConRetorno(
    p.entradaXlm.router,
    usuario,
    "swap_exact_tokens_for_tokens",
    [i128(c.entra), i128(c.minimo), vecAddr(camino(p)), addr(usuario), u64(plazo)],
    firmar,
    { rpcUrl: p.rpcUrl, passphrase: p.passphrase },
  );
  if (!retorno) return c.minimo;
  const montos = scValToNative(retorno) as bigint[];
  return BigInt(montos[montos.length - 1]);
}
