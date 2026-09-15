/**
 * Entrar al pozo pagando con otra moneda (XLM, USDT0). El pozo es de USDC y
 * no cambia: el swap pasa por la wallet del usuario, en Soroswap, y lo que
 * sale del swap es lo que se deposita. Dos firmas: el swap y el depósito.
 *
 * El swap es `swap_exact_tokens_for_tokens` del router: entra un monto exacto
 * y sale lo que dé el pool, con un piso (`amount_out_min`) para que un
 * cambio de precio entre la cotización y la firma no sorprenda. `to` es el
 * que paga y el que recibe: el router le pide `require_auth` a esa dirección.
 *
 * La cotización es `router_get_amounts_out`, una lectura: simula la llamada y
 * lee el resultado. Cada moneda de entrada tiene uno o más caminos posibles
 * (directo, o pasando por XLM); se cotizan todos y gana el que más da. No
 * pasa por `queryContract` porque ese resuelve los tipos desde el spec y el
 * router devuelve un `Result`; armar el XDR a mano y decodificar con
 * `scValToNative` no depende de cómo lo interprete el SDK.
 */

import {
  Account,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Entrada, Pozo } from "./config";
import { addr, i128, invocarConRetorno, servidorDe, u64, vecAddr, type Firmante } from "./contrato";

import { SLIPPAGE_BPS } from "./cambio";

/** Segundos que la wallet tiene para firmar antes de que el router rechace el swap. */
const PLAZO_S = 600;

/** Una cotización de Soroswap: el camino que más da y cuánto da. */
export type CotizacionSoroswap = {
  via: "soroswap";
  moneda: Entrada;
  entra: bigint;
  sale: bigint;
  minimo: bigint;
  /** El camino que más da, del token de entrada al del pozo. */
  camino: string[];
};

function router(p: Pozo): string {
  if (!p.entradas) throw new Error(`el pozo de ${p.simbolo} no acepta otras monedas`);
  return p.entradas.router;
}

/** Cuánto sale por un camino, o `null` si Soroswap no tiene ese par. */
async function cotizarCamino(
  p: Pozo,
  cuenta: Account,
  entra: bigint,
  camino: string[],
): Promise<bigint | null> {
  const servidor = servidorDe(p.rpcUrl);
  const tx = new TransactionBuilder(cuenta, { fee: "100", networkPassphrase: p.passphrase })
    .addOperation(
      new Contract(router(p)).call("router_get_amounts_out", i128(entra), vecAddr(camino)),
    )
    .setTimeout(60)
    .build();
  const sim = await servidor.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
  const montos = scValToNative(sim.result.retval) as bigint[];
  return BigInt(montos[montos.length - 1]);
}

/** Cuánto del token del pozo da Soroswap hoy por `entra` de `moneda`. */
export async function cotizarSoroswap(
  p: Pozo,
  usuario: string,
  moneda: Entrada,
  entra: bigint,
): Promise<CotizacionSoroswap> {
  const servidor = servidorDe(p.rpcUrl);
  const c = await servidor.getAccount(usuario);
  const cuenta = new Account(c.accountId(), c.sequenceNumber());
  const resultados = await Promise.all(
    moneda.caminos.map(async (camino) => ({
      camino,
      sale: await cotizarCamino(p, cuenta, entra, camino),
    })),
  );
  const mejor = resultados
    .filter((r): r is { camino: string[]; sale: bigint } => r.sale != null && r.sale > 0n)
    .sort((a, b) => (a.sale > b.sale ? -1 : a.sale < b.sale ? 1 : 0))[0];
  if (!mejor) throw new Error(`Soroswap no cotiza ${moneda.simbolo} → ${p.simbolo}`);
  return {
    via: "soroswap",
    moneda,
    entra,
    sale: mejor.sale,
    minimo: mejor.sale - (mejor.sale * SLIPPAGE_BPS) / 10_000n,
    camino: mejor.camino,
  };
}

/**
 * Hace el swap en la wallet del usuario y devuelve cuánto del token del pozo
 * recibió, en stroops. Si el RPC no trae el valor de retorno, devuelve el
 * mínimo aceptado: lo que seguro está en la wallet.
 */
export async function cambiarSoroswap(
  p: Pozo,
  usuario: string,
  c: CotizacionSoroswap,
  firmar: Firmante,
): Promise<bigint> {
  const plazo = BigInt(Math.floor(Date.now() / 1000) + PLAZO_S);
  const { retorno } = await invocarConRetorno(
    router(p),
    usuario,
    "swap_exact_tokens_for_tokens",
    [i128(c.entra), i128(c.minimo), vecAddr(c.camino), addr(usuario), u64(plazo)],
    firmar,
    { rpcUrl: p.rpcUrl, passphrase: p.passphrase },
  );
  if (!retorno) return c.minimo;
  const montos = scValToNative(retorno) as bigint[];
  return BigInt(montos[montos.length - 1]);
}
