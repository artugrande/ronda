/**
 * Cliente del contrato `pozo`.
 *
 * Lecturas por `queryContract`; escrituras por el ciclo completo (simular,
 * ensamblar, firmar, mandar, pollear) que ya implementa `contrato.ts`. Todas
 * reciben el contract id: la app muestra más de un pozo.
 */

import { Address, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";
import { PASSPHRASE_RED } from "./config";
import { addr, i128, invocarEn, servidor, type Firmante } from "./contrato";
import { momentoDe } from "./drand";

// ---------------------------------------------------------------------------
// Tipos, espejo de `Vista` en el contrato
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
    apyBps: c.apy_bps == null ? null : BigInt(c.apy_bps),
    sorteoPendiente: Boolean(c.sorteo_pendiente),
    rondaDrand: c.ronda_drand == null ? null : BigInt(c.ronda_drand),
  };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function estado(pozo: string): Promise<Vista> {
  const { result } = await servidor.queryContract<VistaCruda>(
    pozo,
    "estado",
    {},
    PASSPHRASE_RED,
  );
  return leerVista(result);
}

/** Capital de una cuenta en el pozo. */
export async function saldo(pozo: string, usuario: string): Promise<bigint> {
  const { result } = await servidor.queryContract<bigint>(
    pozo,
    "saldo",
    { usuario },
    PASSPHRASE_RED,
  );
  return BigInt(result);
}

/** Chances de una cuenta en la ronda en curso, en puntos básicos. */
export async function chancesBps(pozo: string, usuario: string): Promise<number> {
  const { result } = await servidor.queryContract<bigint>(
    pozo,
    "chances_bps",
    { usuario },
    PASSPHRASE_RED,
  );
  return Number(result);
}

type ConfigCruda = { drand_genesis: bigint; drand_periodo: bigint; periodo: bigint };

const configs = new Map<string, Promise<ConfigCruda>>();

/** Lo que no cambia en la vida del pozo. Se pide una vez por pestaña. */
export function config(pozo: string): Promise<ConfigCruda> {
  let c = configs.get(pozo);
  if (!c) {
    c = servidor
      .queryContract<ConfigCruda>(pozo, "config", {}, PASSPHRASE_RED)
      .then((r) => r.result);
    c.catch(() => configs.delete(pozo));
    configs.set(pozo, c);
  }
  return c;
}

/**
 * Cuándo se conoce el ganador de un sorteo pendiente (Unix, segundos): el
 * momento en que drand publica la ronda que lo decide. Después de eso solo
 * falta que alguien, el keeper o una visita, la traiga.
 */
export async function ganadorSeConoceEn(pozo: string, v: Vista): Promise<number | null> {
  if (!v.sorteoPendiente || v.rondaDrand == null) return null;
  const c = await config(pozo);
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
 * Los últimos sorteos, del más nuevo al más viejo. El RPC de testnet guarda
 * unos 7 días de eventos; un historial más largo necesita un indexer.
 */
export async function ganadores(pozo: string, maximo = 10): Promise<Ganador[]> {
  const ultimo = await servidor.getLatestLedger();
  // ~7 días a 5s por ledger, que es lo que retiene el RPC público. Si pide
  // más atrás de lo que tiene, el RPC contesta con error: se acota.
  const desde = Math.max(1, ultimo.sequence - 120_000);
  const topico = nativeToScVal("sorteo_ejecutado", { type: "symbol" }).toXDR("base64");
  const salida: Ganador[] = [];
  let cursor: string | null = null;
  for (let pagina = 0; pagina < 20; pagina++) {
    const filtros: rpc.Api.EventFilter[] = [
      { type: "contract", contractIds: [pozo], topics: [[topico, "*", "*"]] },
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

export const depositar = (pozo: string, usuario: string, monto: bigint, f: Firmante) =>
  invocarEn(pozo, usuario, "depositar", [addr(usuario), i128(monto)], f);

export const retirar = (pozo: string, usuario: string, monto: bigint, f: Firmante) =>
  invocarEn(pozo, usuario, "retirar", [addr(usuario), i128(monto)], f);

/** "12,34 %" a partir de puntos básicos. */
export function apyTexto(bps: bigint | null): string | null {
  if (bps == null) return null;
  const entero = bps / 100n;
  const dec = (bps % 100n).toString().padStart(2, "0");
  return `${entero},${dec} %`;
}
