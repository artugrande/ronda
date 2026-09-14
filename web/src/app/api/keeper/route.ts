/**
 * El keeper del pozo como función serverless.
 *
 * Cada request hace un paso por pozo (`src/lib/keeper.ts`): cierra la ronda
 * si venció, sortea si drand ya publicó, o no hace nada y cuenta por qué. Lo
 * disparan dos cosas:
 *
 *   - el cron de Vercel (`vercel.json`), como piso;
 *   - la página, cada vez que alguien la abre y ve una ronda vencida o un
 *     sorteo pendiente. Con una visita por semana alcanza.
 *
 * Es público a propósito: las dos acciones son permissionless y el contrato
 * deja pasar cada una una sola vez, así que un request de más no firma nada
 * que no haga falta. Lo único que expone es la cuenta que paga fees
 * (KEEPER_SECRET), y solo para esas dos llamadas. La misma clave sirve en las
 * dos redes: la cuenta tiene que existir (tener XLM) en cada una.
 *
 * Variables: las direcciones de los pozos (o las fijas de `config.ts`) y
 * KEEPER_SECRET. Sin la última solo mira, y lo dice en la respuesta.
 */

import { NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { POZOS, pozoConfigurado } from "@/lib/config";
import { info } from "@/lib/drand";
import { paso, type Conexion, type Paso } from "@/lib/keeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Cerrar o sortear es simular, firmar, mandar y pollear: entra holgado. */
export const maxDuration = 60;

type Resultado = { pozo: string; clave: string; red: string } & (
  | { ok: true; paso: Paso }
  | { ok: false; error: string }
);

type Respuesta =
  | { ok: true; firma: boolean; pozos: Resultado[] }
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
    return { ok: false, error: "no hay ningún pozo configurado" };
  }
  const secreto = process.env.KEEPER_SECRET;
  const firmante = secreto ? Keypair.fromSecret(secreto) : null;
  const d = await drand();
  const pozos: Resultado[] = [];
  // En serie: el firmante es una sola cuenta y dos transacciones a la vez en
  // la misma red pelearían por el mismo número de secuencia.
  for (const p of POZOS) {
    const conexion: Conexion = {
      rpcUrl: p.rpcUrl,
      passphrase: p.passphrase,
      pozo: p.id,
      drand: d,
      firmante,
    };
    const base = { pozo: p.id, clave: p.clave, red: p.red };
    try {
      pozos.push({ ...base, ok: true, paso: await paso(conexion) });
    } catch (e) {
      pozos.push({ ...base, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: true, firma: firmante !== null, pozos };
}

async function manejar() {
  enCurso ??= unPaso().finally(() => (enCurso = null));
  const r = await enCurso;
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}

export const GET = manejar;
export const POST = manejar;
