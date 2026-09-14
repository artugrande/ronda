/**
 * Cliente del contrato `pozo`.
 *
 * Lecturas por `queryContract`; escrituras por el ciclo completo (simular,
 * ensamblar, firmar, mandar, pollear) que ya implementa `contrato.ts`. Todas
 * reciben el `Pozo`, que trae el contract id y la red: la app muestra el
 * principal en mainnet y el de prueba en testnet.
 */

import { Address, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";
import type { Pozo } from "./config";
import { addr, i128, invocarEn, servidorDe, type Firmante } from "./contrato";
import { momentoDe } from "./drand";

// ---------------------------------------------------------------------------
// Tipos, espejo de `Vista` y `Cuenta` en el contrato
// ---------------------------------------------------------------------------

export type Vista = {
  /** Cuentas con capital adentro ahora. */
  participantes: number;
  /** Capital total. Lo que nadie puede perder. */
  principal: bigint;
  /** Rendimiento en juego: el generado hasta ahora o el congelado al cerrar. */
  premio: bigint;
  ronda: number;
  cierraAt: bigint;
  periodo: bigint;
  /** Capital máximo del pozo. 0 = sin tope. */
  tope: bigint;
  /** Puntos básicos anuales, o `null` si todavía no hay con qué calcularlo. */
  apyBps: bigint | null;
  /** `true` entre el cierre y el sorteo. */
  sorteoPendiente: boolean;
  /** La ronda de drand que decide, si hay un sorteo pendiente. */
  rondaDrand: bigint | null;
};

type VistaCruda = {
  participantes: number;
  principal: bigint;
  premio: bigint;
  ronda: number;
  cierra_at: bigint;
  periodo: bigint;
  tope: bigint;
  apy_bps: bigint | null | undefined;
  sorteo_pendiente: boolean;
  ronda_drand: bigint | null | undefined;
};

function leerVista(c: VistaCruda): Vista {
  return {
    participantes: Number(c.participantes),
    principal: BigInt(c.principal),
    premio: BigInt(c.premio),
    ronda: Number(c.ronda),
    cierraAt: BigInt(c.cierra_at),
    periodo: BigInt(c.periodo),
    tope: BigInt(c.tope ?? 0),
    apyBps: c.apy_bps == null ? null : BigInt(c.apy_bps),
    sorteoPendiente: Boolean(c.sorteo_pendiente),
    rondaDrand: c.ronda_drand == null ? null : BigInt(c.ronda_drand),
  };
}

export type Cuenta = {
  deposito: bigint;
  /** Días seguidos de "ahorré hoy". */
  racha: number;
  /** Último día UTC (timestamp / 86400) en que marcó la racha. */
  ultimoDia: number;
  referente: string | null;
  referidos: number;
  /** Lo que le suman sus referidos, en unidades de capital. */
  bonoRef: bigint;
};

type CuentaCruda = {
  deposito: bigint;
  racha: number;
  ultimo_dia: bigint;
  referente: string | null | undefined;
  referidos: number;
  bono_ref: bigint;
};

/** Cada cuánto, como mucho, se marca la racha: un día UTC. */
export const SEGUNDOS_DIA = 86_400;
export const RACHA_MAX = 7;

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

async function leer<T>(p: Pozo, metodo: string, args: Record<string, unknown> = {}): Promise<T> {
  const { result } = await servidorDe(p.rpcUrl).queryContract<T>(p.id, metodo, args, p.passphrase);
  return result;
}

export async function estado(p: Pozo): Promise<Vista> {
  return leerVista(await leer<VistaCruda>(p, "estado"));
}

/** Capital de una cuenta en el pozo. */
export async function saldo(p: Pozo, usuario: string): Promise<bigint> {
  return BigInt(await leer<bigint>(p, "saldo", { usuario }));
}

/** Chances de una cuenta en la ronda en curso, en puntos básicos. */
export async function chancesBps(p: Pozo, usuario: string): Promise<number> {
  return Number(await leer<bigint>(p, "chances_bps", { usuario }));
}

/** La cuenta entera, o `null` si nunca depositó. */
export async function cuentaDe(p: Pozo, usuario: string): Promise<Cuenta | null> {
  let c: CuentaCruda | null | undefined;
  try {
    c = await leer<CuentaCruda | null | undefined>(p, "cuenta_de", { usuario });
  } catch {
    // Un pozo desplegado con una versión anterior del contrato no tiene esta
    // vista: la pantalla sigue andando sin racha ni referidos.
    return null;
  }
  if (c == null) return null;
  return {
    deposito: BigInt(c.deposito),
    racha: Number(c.racha),
    ultimoDia: Number(c.ultimo_dia),
    referente: c.referente ?? null,
    referidos: Number(c.referidos),
    bonoRef: BigInt(c.bono_ref),
  };
}

type ConfigCruda = { drand_genesis: bigint; drand_periodo: bigint; periodo: bigint };

const configs = new Map<string, Promise<ConfigCruda>>();

/** Lo que no cambia en la vida del pozo. Se pide una vez por pestaña. */
export function config(p: Pozo): Promise<ConfigCruda> {
  let c = configs.get(p.id);
  if (!c) {
    c = leer<ConfigCruda>(p, "config");
    c.catch(() => configs.delete(p.id));
    configs.set(p.id, c);
  }
  return c;
}

/**
 * Cuándo se conoce el ganador de un sorteo pendiente (Unix, segundos): el
 * momento en que drand publica la ronda que lo decide. Después de eso solo
 * falta que alguien, el keeper o una visita, la traiga.
 */
export async function ganadorSeConoceEn(p: Pozo, v: Vista): Promise<number | null> {
  if (!v.sorteoPendiente || v.rondaDrand == null) return null;
  const c = await config(p);
  return momentoDe(Number(c.drand_genesis), Number(c.drand_periodo), Number(v.rondaDrand));
}

// ---------------------------------------------------------------------------
// Ganadores: los eventos `sorteo_ejecutado` que todavía guarda el RPC
// ---------------------------------------------------------------------------

export type Ganador = {
  ronda: number;
  ganador: string;
  premio: bigint;
  /** Hash de la transacción del sorteo, para enlazar al explorer. */
  tx: string;
  ledger: number;
};

/**
 * Los últimos sorteos, del más nuevo al más viejo. El RPC público guarda
 * unos 7 días de eventos; un historial más largo necesita un indexer.
 */
export async function ganadores(p: Pozo, maximo = 10): Promise<Ganador[]> {
  const servidor = servidorDe(p.rpcUrl);
  const ultimo = await servidor.getLatestLedger();
  // ~7 días a 5s por ledger, que es lo que retiene el RPC público. Si pide
  // más atrás de lo que tiene, el RPC contesta con error: se acota.
  const desde = Math.max(1, ultimo.sequence - 120_000);
  const topico = nativeToScVal("sorteo_ejecutado", { type: "symbol" }).toXDR("base64");
  const salida: Ganador[] = [];
  let cursor: string | null = null;
  for (let pagina = 0; pagina < 20; pagina++) {
    const filtros: rpc.Api.EventFilter[] = [
      { type: "contract", contractIds: [p.id], topics: [[topico, "*", "*"]] },
    ];
    const r: rpc.Api.GetEventsResponse = await servidor.getEvents(
      cursor === null
        ? { startLedger: desde, filters: filtros, limit: 200 }
        : { cursor, filters: filtros, limit: 200 },
    );
    for (const e of r.events) salida.push(leerGanador(e));
    if (r.events.length < 200) break;
    cursor = r.cursor;
  }
  return salida.sort((a, b) => b.ronda - a.ronda).slice(0, maximo);
}

function leerGanador(e: rpc.Api.EventResponse): Ganador {
  // topics: ["sorteo_ejecutado", ronda: u32, ganador: Address]; data: map.
  const ronda = Number(scValToNative(e.topic[1]));
  const ganador = Address.fromScVal(e.topic[2]).toString();
  const datos = scValToNative(e.value) as { premio: bigint };
  return {
    ronda,
    ganador,
    premio: BigInt(datos.premio),
    tx: e.txHash,
    ledger: e.ledger,
  };
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

const cx = (p: Pozo) => ({ rpcUrl: p.rpcUrl, passphrase: p.passphrase });

export const depositar = (p: Pozo, usuario: string, monto: bigint, f: Firmante) =>
  invocarEn(p.id, usuario, "depositar", [addr(usuario), i128(monto)], f, cx(p));

export const depositarConReferente = (
  p: Pozo,
  usuario: string,
  monto: bigint,
  referente: string,
  f: Firmante,
) =>
  invocarEn(
    p.id,
    usuario,
    "depositar_con_referente",
    [addr(usuario), i128(monto), addr(referente)],
    f,
    cx(p),
  );

export const retirar = (p: Pozo, usuario: string, monto: bigint, f: Firmante) =>
  invocarEn(p.id, usuario, "retirar", [addr(usuario), i128(monto)], f, cx(p));

export const ahorrarHoy = (p: Pozo, usuario: string, f: Firmante) =>
  invocarEn(p.id, usuario, "ahorrar_hoy", [addr(usuario)], f, cx(p));

/** "12,34 %" a partir de puntos básicos. */
export function apyTexto(bps: bigint | null): string | null {
  if (bps == null) return null;
  const entero = bps / 100n;
  const dec = (bps % 100n).toString().padStart(2, "0");
  return `${entero},${dec} %`;
}
