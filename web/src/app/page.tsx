"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { POZO, RED, pozoConfigurado } from "@/lib/config";
import {
  apyTexto,
  chancesBps,
  depositar,
  estado,
  retirar,
  saldo,
  type Vista,
} from "@/lib/pozo";
import { aStroops, aTexto } from "@/lib/montos";
import { conectar, direccionActual, firmar } from "@/lib/wallet";
import { Boton, Error as Aviso, Etiqueta, Panel, corta } from "@/components/ui";

type Accion = null | "depositar" | "retirar" | "conectar";

/** Cada cuántos segundos se relee el contrato. El premio crece solo. */
const REFRESCO_S = 20;

/**
 * Cada cuánto, como mucho, una pestaña abierta le pide al keeper serverless
 * que haga un paso. El keeper decide solo si hay algo que hacer; esto es para
 * no martillarlo mientras una ronda vencida espera a drand.
 */
const KEEPER_CADA_S = 60;

/**
 * Le avisa al keeper (`/api/keeper`) que hay trabajo: una ronda vencida con
 * gente adentro o un sorteo esperando la firma de drand. Cualquier visita
 * sirve de keeper; el que paga las fees es el server. Devuelve `true` si el
 * keeper hizo algo, para releer el contrato enseguida.
 */
async function empujarKeeper(): Promise<boolean> {
  try {
    const r = await fetch("/api/keeper", { method: "POST" });
    const j = (await r.json()) as { ok: boolean; paso?: { accion: string; tx: string | null } };
    return Boolean(j.ok && j.paso && j.paso.accion !== "espera" && j.paso.tx);
  } catch {
    return false;
  }
}

function hayTrabajo(v: Vista, ahora: number): boolean {
  if (v.sorteoPendiente) return true;
  return v.participantes > 0 && ahora >= Number(v.cierraAt);
}

/**
 * Segundos desde epoch, refrescados cada segundo. Va en estado y no leído en
 * render, si no el countdown y el "vencido" solo se enteran cuando algo más
 * provoca un re-render.
 */
function useAhora(): number {
  const [ahora, setAhora] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setAhora(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return ahora;
}

export default function Home() {
  const [yo, setYo] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista | null>(null);
  const [miSaldo, setMiSaldo] = useState<bigint>(0n);
  const [misChances, setMisChances] = useState<number>(0);
  const [monto, setMonto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [accion, setAccion] = useState<Accion>(null);
  const [cargando, setCargando] = useState(true);
  const ahora = useAhora();
  const ultimoEmpujon = useRef(0);

  const refrescar = useCallback(async (direccion: string | null) => {
    if (!pozoConfigurado) return;
    try {
      const [v, s, ch] = await Promise.all([
        estado(),
        direccion ? saldo(direccion) : Promise.resolve(0n),
        direccion ? chancesBps(direccion) : Promise.resolve(0),
      ]);
      setVista(v);
      setMiSaldo(s);
      setMisChances(ch);
      setError(null);

      const t = Math.floor(Date.now() / 1000);
      if (hayTrabajo(v, t) && t - ultimoEmpujon.current >= KEEPER_CADA_S) {
        ultimoEmpujon.current = t;
        if (await empujarKeeper()) {
          setVista(await estado());
        }
      }
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    let direccion: string | null = null;
    (async () => {
      direccion = await direccionActual();
      setYo(direccion);
      await refrescar(direccion);
    })();
    const t = setInterval(() => refrescar(direccion), REFRESCO_S * 1000);
    return () => clearInterval(t);
  }, [refrescar]);

  async function correr(cual: Exclude<Accion, null>, fn: () => Promise<void>) {
    setAccion(cual);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(mensaje(e));
    } finally {
      setAccion(null);
    }
  }

  function montoValido(): bigint | null {
    const m = aStroops(monto);
    if (m == null || m <= 0n) {
      setError("Poné un monto válido, con hasta 7 decimales.");
      return null;
    }
    return m;
  }

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-6 sm:py-10">
      <header className="mb-6 flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Zorrito</h1>
          <p className="text-xs text-tenue">Ahorrá. Nadie pierde. Uno gana el rendimiento.</p>
        </div>
        <div className="flex items-center gap-2">
          <Etiqueta tono={RED === "mainnet" ? "alerta" : "neutro"}>{RED}</Etiqueta>
          {yo ? (
            <Etiqueta tono="ok">{corta(yo)}</Etiqueta>
          ) : (
            <button
              onClick={() =>
                correr("conectar", async () => {
                  const direccion = await conectar();
                  setYo(direccion);
                  await refrescar(direccion);
                })
              }
              className="text-sm font-medium text-acento underline underline-offset-4"
            >
              {accion === "conectar" ? "…" : "Conectar"}
            </button>
          )}
        </div>
      </header>

      {!pozoConfigurado && <SinDeploy />}

      {error && (
        <div className="mb-4">
          <Aviso>{error}</Aviso>
        </div>
      )}

      {pozoConfigurado && cargando && (
        <p className="text-sm text-tenue">Leyendo el pozo…</p>
      )}

      {vista && (
        <div className="space-y-4">
          <Premio vista={vista} ahora={ahora} />
          <Cifras vista={vista} />

          {yo && (
            <Panel titulo="Tu posición">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wider text-tenue">Tu capital</p>
                  <p className="cifra mt-1 text-2xl font-semibold">{aTexto(miSaldo)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-tenue">Tu probabilidad</p>
                  <p className="cifra mt-1 text-2xl font-semibold">
                    {(misChances / 100).toFixed(2)}
                    <span className="text-base text-tenue"> %</span>
                  </p>
                </div>
              </div>
              <p className="mt-2 text-xs text-tenue">
                Pesa lo que pusiste y por cuánto tiempo. Entrar recién sobre el cierre
                casi no suma.
              </p>

              <div className="mt-4 flex gap-2">
                <input
                  inputMode="decimal"
                  placeholder="Monto"
                  value={monto}
                  onChange={(e) => setMonto(e.target.value)}
                  className="cifra min-w-0 flex-1 rounded-xl border border-borde bg-background px-4 py-3 text-base outline-none focus:border-acento"
                />
                {miSaldo > 0n && (
                  <button
                    onClick={() => setMonto(aTexto(miSaldo, 7))}
                    className="shrink-0 rounded-xl border border-borde px-3 text-sm text-tenue"
                  >
                    todo
                  </button>
                )}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Boton
                  onClick={() =>
                    correr("depositar", async () => {
                      const m = montoValido();
                      if (m == null) return;
                      await depositar(yo, m, firmar);
                      setMonto("");
                      await refrescar(yo);
                    })
                  }
                  cargando={accion === "depositar"}
                  disabled={accion !== null}
                >
                  Depositar
                </Boton>
                <Boton
                  variante="secundario"
                  onClick={() =>
                    correr("retirar", async () => {
                      const m = montoValido();
                      if (m == null) return;
                      if (m > miSaldo) {
                        setError(`Tenés ${aTexto(miSaldo)} en el pozo, no más.`);
                        return;
                      }
                      await retirar(yo, m, firmar);
                      setMonto("");
                      await refrescar(yo);
                    })
                  }
                  cargando={accion === "retirar"}
                  disabled={accion !== null || miSaldo === 0n}
                >
                  Retirar
                </Boton>
              </div>
              <p className="mt-3 text-xs text-tenue">
                Retirás cuando quieras, sin penalidad, aunque haya un sorteo en
                curso. Tu capital nunca está en juego.
              </p>
            </Panel>
          )}

          {!yo && (
            <Panel>
              <p className="text-sm text-tenue">
                Conectá una wallet para depositar y ver tu probabilidad.
              </p>
            </Panel>
          )}

          <ComoFunciona />
        </div>
      )}
    </main>
  );
}

function Premio({ vista, ahora }: { vista: Vista; ahora: number }) {
  const faltan = Number(vista.cierraAt) - ahora;

  let estadoTexto: string;
  let tono: "neutro" | "ok" | "alerta" = "neutro";
  if (vista.sorteoPendiente) {
    estadoTexto = `cerrada · esperando drand #${vista.rondaDrand ?? "?"}`;
    tono = "ok";
  } else if (faltan <= 0) {
    estadoTexto = "vencida · esperando cierre";
    tono = "alerta";
  } else {
    estadoTexto = `se sortea en ${duracion(faltan)}`;
  }

  return (
    <Panel>
      <p className="text-xs uppercase tracking-wider text-tenue">
        {vista.sorteoPendiente ? "Premio de la ronda" : "Premio en juego"}
        <span className="cifra"> · ronda {vista.ronda}</span>
      </p>
      <p className="cifra mt-1 text-4xl font-semibold tracking-tight">{aTexto(vista.premio)}</p>
      <div className="mt-3">
        <Etiqueta tono={tono}>{estadoTexto}</Etiqueta>
      </div>
      <p className="mt-3 text-sm text-tenue">
        Es el rendimiento que generó el pozo entero. Uno se lo lleva; los demás
        siguen con exactamente lo que pusieron.
      </p>
    </Panel>
  );
}

function Cifras({ vista }: { vista: Vista }) {
  const apy = apyTexto(vista.apyBps);
  return (
    <div className="grid grid-cols-3 gap-2">
      <Cifra etiqueta="Participan" valor={String(vista.participantes)} />
      <Cifra etiqueta="Depositado" valor={aTexto(vista.principal, 0)} />
      <Cifra etiqueta="APY" valor={apy ?? "—"} pie={apy ? "Blend" : "sin datos aún"} />
    </div>
  );
}

function Cifra({ etiqueta, valor, pie }: { etiqueta: string; valor: string; pie?: string }) {
  return (
    <div className="rounded-2xl border border-borde bg-panel px-3 py-3">
      <p className="text-[11px] uppercase tracking-wider text-tenue">{etiqueta}</p>
      <p className="cifra mt-1 truncate text-lg font-semibold">{valor}</p>
      {pie && <p className="text-[11px] text-tenue">{pie}</p>}
    </div>
  );
}

function ComoFunciona() {
  return (
    <Panel titulo="Cómo funciona">
      <ol className="space-y-2 text-sm text-tenue">
        <li>
          <span className="font-medium text-foreground">Depositás.</span> Tu plata va a
          generar rendimiento junto con la de todos.
        </li>
        <li>
          <span className="font-medium text-foreground">Cada ronda se sortea el rendimiento.</span>{" "}
          Uno se lo lleva entero. Los demás no pierden nada: su capital sigue ahí.
        </li>
        <li>
          <span className="font-medium text-foreground">El azar viene de afuera.</span> Lo
          decide drand, un beacon público de ~20 organizaciones, y el contrato verifica la
          firma. Ni nosotros ni la red podemos elegir al ganador.
        </li>
      </ol>
    </Panel>
  );
}

function SinDeploy() {
  return (
    <Panel titulo="Falta el contrato">
      <p className="text-sm text-tenue">
        No hay ningún pozo configurado todavía. Desplegalo y apuntá la app ahí:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-xl border border-borde bg-background p-3 text-xs leading-relaxed">
        {`scripts/ensayo-pozo-testnet.sh

# después, en web/.env.local
NEXT_PUBLIC_POZO=C...
NEXT_PUBLIC_RED=testnet`}
      </pre>
      <p className="mt-3 text-xs text-tenue">
        Valor actual: <code className="cifra">{POZO || "(vacío)"}</code>
      </p>
    </Panel>
  );
}

function duracion(segundos: number): string {
  const d = Math.floor(segundos / 86400);
  const h = Math.floor((segundos % 86400) / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function mensaje(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
