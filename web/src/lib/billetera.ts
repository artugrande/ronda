/**
 * Lo que la app necesita saber de la wallet del usuario más allá de su
 * dirección: cuánto tiene del token del pozo, y si tiene la trustline para
 * recibirlo. XLM nativo no necesita trustline; USDC sí.
 *
 * Se lee de Horizon, que es donde viven los balances clásicos. El RPC de
 * Soroban no los da.
 */

import { Asset, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { Pozo } from "./config";
import { feeDeInclusion, servidorDe, type Firmante } from "./contrato";

export type EstadoBilletera = {
  /** Saldo del token del pozo en la wallet, en stroops. */
  saldo: bigint;
  /** `false` solo si el token exige trustline y la wallet no la tiene. */
  trustline: boolean;
  /** La cuenta existe en la red. */
  existe: boolean;
};

type Balance = {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
};

export async function estadoBilletera(p: Pozo, usuario: string): Promise<EstadoBilletera> {
  const r = await fetch(`${p.horizon}/accounts/${usuario}`);
  if (r.status === 404) return { saldo: 0n, trustline: !p.activo, existe: false };
  if (!r.ok) throw new Error(`Horizon: HTTP ${r.status}`);
  const cuenta = (await r.json()) as { balances: Balance[] };
  const linea = cuenta.balances.find((b) =>
    p.activo
      ? b.asset_code === p.activo.code && b.asset_issuer === p.activo.issuer
      : b.asset_type === "native",
  );
  return {
    saldo: linea ? aStroops(linea.balance) : 0n,
    trustline: p.activo ? linea != null : true,
    existe: true,
  };
}

/** "12.3456789" → stroops. Horizon siempre manda 7 decimales. */
function aStroops(texto: string): bigint {
  const [entera, dec = ""] = texto.split(".");
  return BigInt(entera) * 10_000_000n + BigInt((dec + "0000000").slice(0, 7));
}

/**
 * Agrega la trustline del token del pozo a la wallet. Es una operación
 * clásica (ChangeTrust), no un contrato: se manda igual por el RPC.
 */
export async function agregarTrustline(p: Pozo, usuario: string, firmar: Firmante): Promise<string> {
  if (!p.activo) throw new Error("XLM no necesita trustline");
  const servidor = servidorDe(p.rpcUrl);
  const [cuenta, fee] = await Promise.all([servidor.getAccount(usuario), feeDeInclusion(servidor)]);
  const tx = new TransactionBuilder(cuenta, { fee, networkPassphrase: p.passphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset(p.activo.code, p.activo.issuer) }))
    .setTimeout(60)
    .build();
  const firmada = await firmar(tx.toXDR());
  const enviada = await servidor.sendTransaction(TransactionBuilder.fromXDR(firmada, p.passphrase));
  if (enviada.status === "ERROR") {
    throw new Error(`no se pudo agregar la trustline: ${JSON.stringify(enviada.errorResult)}`);
  }
  const r = await servidor.pollTransaction(enviada.hash, { attempts: 30 });
  if (r.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`la trustline no entró: ${r.status}`);
  }
  return enviada.hash;
}
