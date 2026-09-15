/**
 * Cambiar por el DEX clásico de Stellar: un path payment. Es lo que usan
 * Freighter y Lobstr cuando cambian, y donde USDT0 tiene liquidez hoy.
 *
 * La cotización sale de Horizon (`/paths/strict-send`): para un monto exacto
 * de la moneda de entrada, qué caminos hay hasta el token del pozo y cuánto
 * da cada uno. El cambio es `pathPaymentStrictSend` con el usuario como
 * origen y destino: manda X de la moneda y recibe al menos el mínimo del
 * token del pozo, o la operación falla entera. No hay estado intermedio.
 *
 * Es una transacción clásica, sin Soroban. Se manda igual por el RPC y se
 * lee cuánto se recibió del resultado de la operación.
 */

import { Asset, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { SLIPPAGE_BPS } from "./cambio";
import type { Entrada, Pozo } from "./config";
import { feeDeInclusion, servidorDe, type Firmante } from "./contrato";
import { aTexto } from "./montos";

export type CotizacionSdex = {
  via: "sdex";
  moneda: Entrada;
  entra: bigint;
  sale: bigint;
  minimo: bigint;
  /** Los activos intermedios del camino que más da. Vacío si es directo. */
  camino: Asset[];
};

type ActivoHorizon = { asset_type: string; asset_code?: string; asset_issuer?: string };
type CaminoHorizon = { destination_amount: string; path: ActivoHorizon[] };

function activo(a: Entrada["activo"]): Asset {
  return a ? new Asset(a.code, a.issuer) : Asset.native();
}

function activoDe(h: ActivoHorizon): Asset {
  return h.asset_type === "native" ? Asset.native() : new Asset(h.asset_code!, h.asset_issuer!);
}

/** "12.3456789" → stroops. Horizon siempre manda 7 decimales. */
function aStroops(texto: string): bigint {
  const [entera, dec = ""] = texto.split(".");
  return BigInt(entera) * 10_000_000n + BigInt((dec + "0000000").slice(0, 7));
}

function parametros(a: Asset, prefijo: string): string {
  if (a.isNative()) return `${prefijo}_asset_type=native`;
  const tipo = a.getCode().length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  return `${prefijo}_asset_type=${tipo}&${prefijo}_asset_code=${a.getCode()}&${prefijo}_asset_issuer=${a.getIssuer()}`;
}

/** Cuánto del token del pozo da el DEX hoy por `entra` de `moneda`. */
export async function cotizarSdex(p: Pozo, moneda: Entrada, entra: bigint): Promise<CotizacionSdex> {
  const origen = activo(moneda.activo);
  const destino = activo(p.activo);
  const destinoTexto = destino.isNative() ? "native" : `${destino.getCode()}:${destino.getIssuer()}`;
  const url =
    `${p.horizon}/paths/strict-send?${parametros(origen, "source")}` +
    `&source_amount=${aTexto(entra, 7)}&destination_assets=${encodeURIComponent(destinoTexto)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Horizon: HTTP ${r.status}`);
  const j = (await r.json()) as { _embedded: { records: CaminoHorizon[] } };
  const mejor = j._embedded.records
    .map((c) => ({ sale: aStroops(c.destination_amount), camino: c.path.map(activoDe) }))
    .filter((c) => c.sale > 0n)
    .sort((a, b) => (a.sale > b.sale ? -1 : a.sale < b.sale ? 1 : 0))[0];
  if (!mejor) throw new Error(`el DEX no cotiza ${moneda.simbolo} → ${p.simbolo}`);
  return {
    via: "sdex",
    moneda,
    entra,
    sale: mejor.sale,
    minimo: mejor.sale - (mejor.sale * SLIPPAGE_BPS) / 10_000n,
    camino: mejor.camino,
  };
}

/**
 * Hace el path payment y devuelve cuánto del token del pozo recibió, en
 * stroops. Si no puede leer el resultado, devuelve el mínimo aceptado: lo que
 * seguro está en la wallet.
 */
export async function cambiarSdex(
  p: Pozo,
  usuario: string,
  c: CotizacionSdex,
  firmar: Firmante,
): Promise<bigint> {
  const servidor = servidorDe(p.rpcUrl);
  const [cuenta, fee] = await Promise.all([servidor.getAccount(usuario), feeDeInclusion(servidor)]);
  const tx = new TransactionBuilder(cuenta, { fee, networkPassphrase: p.passphrase })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: activo(c.moneda.activo),
        sendAmount: aTexto(c.entra, 7),
        destination: usuario,
        destAsset: activo(p.activo),
        destMin: aTexto(c.minimo, 7),
        path: c.camino,
      }),
    )
    .setTimeout(120)
    .build();
  const firmada = await firmar(tx.toXDR());
  const enviada = await servidor.sendTransaction(TransactionBuilder.fromXDR(firmada, p.passphrase));
  if (enviada.status === "ERROR") {
    throw new Error(`el cambio falló: ${JSON.stringify(enviada.errorResult)}`);
  }
  const r = await servidor.pollTransaction(enviada.hash, { attempts: 60 });
  if (r.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`el cambio no entró: ${r.status}`);
  }
  try {
    // La forma "wire" del XDR: uniones como objetos con `code`/`type` y el
    // brazo elegido como campo. En éxito, la única operación es el path
    // payment y `last.amount` es lo que llegó al destino.
    type Wire = {
      result: { results?: { tr?: { pathPaymentStrictSendResult?: { success?: { last: { amount: bigint } } } } }[] };
    };
    const w = r.resultXdr.toXdrObject() as unknown as Wire;
    const monto = w.result.results?.[0]?.tr?.pathPaymentStrictSendResult?.success?.last.amount;
    return monto != null ? BigInt(monto) : c.minimo;
  } catch {
    return c.minimo;
  }
}
