/**
 * El keeper del pozo como función serverless.
 *
 * Cada request hace un paso (`src/lib/keeper.ts`): cierra la ronda si venció,
 * sortea si drand ya publicó, o no hace nada y cuenta por qué. Lo disparan
 * dos cosas:
 *
 *   - el cron de Vercel (`vercel.json`), como piso;
 *   - la página, cada vez que alguien la abre y ve una ronda vencida o un
 *     sorteo pendiente. Con una visita por semana alcanza.
 *
 * Es público a propósito: las dos acciones son permissionless y el contrato
 * deja pasar cada una una sola vez, así que un request de más no firma nada
 * que no haga falta. Lo único que expone es la cuenta que paga fees
 * (KEEPER_SECRET), y solo para esas dos llamadas.
 *
 * Variables: NEXT_PUBLIC_RED, NEXT_PUBLIC_POZO y KEEPER_SECRET. Sin la última
 * solo mira, y lo dice en la respuesta.
 */

import { NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { PASSPHRASE_RED, POZO, RPC_URL, pozoConfigurado } from "@/lib/config";
import { info } from "@/lib/drand";
import { paso, type Conexion, type Paso } from "@/lib/keeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Cerrar o sortear es simular, firmar, mandar y pollear: entra holgado. */
export const maxDuration = 60;

type Respuesta =
  | { ok: true; firma: boolean; paso: Paso }
  | { ok: false; error: string };

/** Genesis y período de quicknet no cambian: se piden una vez por instancia. */
let drandCache: Promise<{ genesis: number; periodo: number }> | null = null;
function drand() {
  drandCache ??= info().then((i) => ({ genesis: i.genesis_time, periodo: i.period }));
  drandCache.catch(() => (drandCache = null));
  return drandCache;
}

/**
 * Dos requests a la vez (el cron y una visita, o dos visitas) comparten el
 * mismo paso en vez de mandar dos transacciones que compiten por lo mismo.
 * Solo dentro de una instancia; entre instancias decide el contrato.
 */
let enCurso: Promise<Respuesta> | null = null;

async function unPaso(): Promise<Respuesta> {
  if (!pozoConfigurado) {
    return { ok: false, error: "falta NEXT_PUBLIC_POZO" };
  }
  const secreto = process.env.KEEPER_SECRET;
  const conexion: Conexion = {
    rpcUrl: RPC_URL,
    passphrase: PASSPHRASE_RED,
    pozo: POZO,
    drand: await drand(),
    firmante: secreto ? Keypair.fromSecret(secreto) : null,
  };
  try {
    return { ok: true, firma: conexion.firmante !== null, paso: await paso(conexion) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function manejar() {
  enCurso ??= unPaso().finally(() => (enCurso = null));
  const r = await enCurso;
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}

export const GET = manejar;
export const POST = manejar;
