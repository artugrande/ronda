/**
 * Cliente del contrato `ronda`.
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
import { CONTRATO, PASSPHRASE_RED, RPC_URL } from "./config";

export const servidor = new rpc.Server(RPC_URL);

/** A qué red hablar. Cada pozo trae la suya; la ronda usa la por defecto. */
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
// Tipos, espejo de los `#[contracttype]` del contrato
// ---------------------------------------------------------------------------

export type EstadoMiembro = "Activo" | "Cobro" | "Moroso";
export type EstadoRonda = "EnCurso" | "Finalizada";

export type Miembro = {
  addr: string;
  estado: EstadoMiembro;
  aportado: bigint;
  cobrado: bigint;
  incumplimientos: number;
};

export type Vista = {
  turno: number;
  beneficiario: string | null;
  pozo: bigint;
  montoTurno: bigint;
  proximoTurnoAt: bigint;
  estado: EstadoRonda;
  miembros: Miembro[];
  pendientes: string[];
};

/**
 * Los enums unitarios de Soroban llegan como string, como `["Variante"]` o como
 * `{ tag }` según por dónde pase la decodificación. Normalizamos en un solo
 * lugar en vez de asumir una forma.
 */
function variante(valor: unknown): string {
  if (typeof valor === "string") return valor;
  if (Array.isArray(valor) && typeof valor[0] === "string") return valor[0];
  if (valor && typeof valor === "object" && "tag" in valor) {
    return String((valor as { tag: unknown }).tag);
  }
  throw new Error(`no pude leer la variante de ${JSON.stringify(valor)}`);
}

function direccion(valor: unknown): string {
  if (typeof valor === "string") return valor;
  if (valor && typeof valor === "object" && "toString" in valor) {
    return String(valor);
  }
  throw new Error(`no pude leer la dirección de ${JSON.stringify(valor)}`);
}

// El decoder devuelve las claves con los nombres del contrato (snake_case).
type VistaCruda = {
  turno: number;
  beneficiario: unknown;
  pozo: bigint;
  monto_turno: bigint;
  proximo_turno_at: bigint;
  estado: unknown;
  miembros: {
    addr: unknown;
    estado: unknown;
    aportado: bigint;
    cobrado: bigint;
    incumplimientos: number;
  }[];
  pendientes: unknown[];
};

function leerVista(cruda: VistaCruda): Vista {
  return {
    turno: Number(cruda.turno),
    beneficiario:
      cruda.beneficiario == null ? null : direccion(cruda.beneficiario),
    pozo: BigInt(cruda.pozo),
    montoTurno: BigInt(cruda.monto_turno),
    proximoTurnoAt: BigInt(cruda.proximo_turno_at),
    estado: variante(cruda.estado) as EstadoRonda,
    miembros: cruda.miembros.map((m) => ({
      addr: direccion(m.addr),
      estado: variante(m.estado) as EstadoMiembro,
      aportado: BigInt(m.aportado),
      cobrado: BigInt(m.cobrado),
      incumplimientos: Number(m.incumplimientos),
    })),
    pendientes: cruda.pendientes.map(direccion),
  };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function estado(rondaId: number): Promise<Vista> {
  const { result } = await servidor.queryContract<VistaCruda>(
    CONTRATO,
    "estado",
    { ronda_id: rondaId },
    PASSPHRASE_RED,
  );
  return leerVista(result);
}

/** Monto etiquetado pendiente de un miembro, o `null` si no pidió ninguno. */
export async function intencionDe(
  rondaId: number,
  miembro: string,
): Promise<bigint | null> {
  const { result } = await servidor.queryContract<bigint | null>(
    CONTRATO,
    "intencion_de",
    { ronda_id: rondaId, miembro },
    PASSPHRASE_RED,
  );
  return result == null ? null : BigInt(result);
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
export function invocar(
  fuente: string,
  metodo: string,
  args: xdr.ScVal[],
  firmar: Firmante,
): Promise<string> {
  return invocarEn(CONTRATO, fuente, metodo, args, firmar);
}

/** Lo mismo, contra cualquier contrato. El pozo y la ronda comparten el ciclo. */
export async function invocarEn(
  contratoId: string,
  fuente: string,
  metodo: string,
  args: xdr.ScVal[],
  firmar: Firmante,
  cx: Conexion = CONEXION_POR_DEFECTO,
): Promise<string> {
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
  return enviada.hash;
}

export const acreditar = (rondaId: number, miembro: string, f: Firmante) =>
  invocar(miembro, "acreditar", [u32(rondaId), addr(miembro)], f);

export const ejecutarTurno = (rondaId: number, fuente: string, f: Firmante) =>
  invocar(fuente, "ejecutar_turno", [u32(rondaId)], f);

export const registrarIntencion = (
  rondaId: number,
  miembro: string,
  f: Firmante,
) => invocar(miembro, "registrar_intencion", [u32(rondaId), addr(miembro)], f);
