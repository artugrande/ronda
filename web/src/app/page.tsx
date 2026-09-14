"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { POZOS, RED, pozoConfigurado, type Pozo } from "@/lib/config";
import {
  apyTexto,
  chancesBps,
  depositar,
  estado,
  ganadorSeConoceEn,
  ganadores,
  retirar,
  saldo,
  type Ganador,
  type Vista,
} from "@/lib/pozo";
import { aStroops, aTexto } from "@/lib/montos";
import { conectar, direccionActual, firmar } from "@/lib/wallet";
import { Marco } from "@/components/Marco";
import { BotonWallet } from "@/components/Wallet";
import { Boton, Error as Aviso, Etiqueta, Panel, corta, explorer } from "@/components/ui";

type Accion = null | "depositar" | "retirar" | "conectar";

/** Cada cuántos segundos se relee el contrato. El premio crece solo. */
const REFRESCO_S = 20;

/**
 * Cada cuánto, como mucho, una pestaña abierta le pide al keeper serverless
 * que haga un paso. El keeper decide solo si hay algo que hacer; esto es para
 * no martillarlo mientras una ronda vencida espera a drand.
 */
const KEEPER_CADA_S = 60;

const PRESETS = ["1", "5", "10", "50"];

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

/**
 * Le avisa al keeper (`/api/keeper`) que hay trabajo: una ronda vencida con
 * gente adentro o un sorteo esperando la firma de drand. Cualquier visita
 * sirve de keeper; el que paga las fees es el server. Devuelve `true` si el
 * keeper hizo algo, para releer el contrato enseguida.
 */
async function empujarKeeper(): Promise<boolean> {
  try {
    const r = await fetch("/api/keeper", { method: "POST" });
    const j = (await r.json()) as {
      ok: boolean;
      pozos?: { ok: boolean; paso?: { accion: string; tx: string | null } }[];
    };
    return Boolean(
      j.ok && j.pozos?.some((p) => p.ok && p.paso && p.paso.accion !== "espera" && p.paso.tx),
    );
  } catch {
    return false;
  }
}

function hayTrabajo(v: Vista, ahora: number): boolean {
  if (v.sorteoPendiente) return true;
  return v.participantes > 0 && ahora >= Number(v.cierraAt);
}

export default function Home() {
  const [pozo, setPozo] = useState<Pozo | undefined>(POZOS[0]);
  const [yo, setYo] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista | null>(null);
  const [revela, setRevela] = useState<number | null>(null);
  const [lista, setLista] = useState<Ganador[] | null>(null);
  const [miSaldo, setMiSaldo] = useState<bigint>(0n);
  const [misChances, setMisChances] = useState<number>(0);
  const [monto, setMonto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [accion, setAccion] = useState<Accion>(null);
  const [cargando, setCargando] = useState(true);
  const ahora = useAhora();
  const ultimoEmpujon = useRef(0);

  const refrescar = useCallback(
    async (direccion: string | null, p: Pozo | undefined = pozo) => {
      if (!p) return;
      try {
        const [v, s, ch] = await Promise.all([
          estado(p.id),
          direccion ? saldo(p.id, direccion) : Promise.resolve(0n),
          direccion ? chancesBps(p.id, direccion) : Promise.resolve(0),
        ]);
        setVista(v);
        setMiSaldo(s);
        setMisChances(ch);
        setRevela(await ganadorSeConoceEn(p.id, v));
        setError(null);

        const t = Math.floor(Date.now() / 1000);
        if (hayTrabajo(v, t) && t - ultimoEmpujon.current >= KEEPER_CADA_S) {
          ultimoEmpujon.current = t;
          if (await empujarKeeper()) {
            const v2 = await estado(p.id);
            setVista(v2);
            setRevela(await ganadorSeConoceEn(p.id, v2));
            ganadores(p.id).then(setLista).catch(() => {});
          }
        }
      } catch (e) {
        setError(mensaje(e));
      } finally {
        setCargando(false);
      }
    },
    [pozo],
  );

  function elegirPozo(p: Pozo) {
    setPozo(p);
    setVista(null);
    setLista(null);
    setCargando(true);
  }

  useEffect(() => {
    let direccion: string | null = null;
    (async () => {
      direccion = await direccionActual();
      setYo(direccion);
      await refrescar(direccion);
    })();
    if (pozo) ganadores(pozo.id).then(setLista).catch(() => setLista([]));
    const t = setInterval(() => refrescar(direccion), REFRESCO_S * 1000);
    return () => clearInterval(t);
  }, [refrescar, pozo]);

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

  const conectarWallet = () =>
    correr("conectar", async () => {
      const direccion = await conectar();
      setYo(direccion);
      await refrescar(direccion);
    });

  return (
    <Marco
      activo="app"
      wallet={<BotonWallet yo={yo} cargando={accion === "conectar"} onConectar={conectarWallet} />}
    >
      {!pozoConfigurado && <SinDeploy />}

      {POZOS.length > 1 && pozo && (
        <div>
          <div className="tabs">
            {POZOS.map((p) => (
              <button
                key={p.clave}
                className={`tab ${p.clave === pozo.clave ? "activa" : ""}`}
                onClick={() => elegirPozo(p)}
              >
                {p.nombre}
              </button>
            ))}
          </div>
          <p className="header-tagline mt-2 text-center">{pozo.ritmo}</p>
        </div>
      )}

      {error && <Aviso>{error}</Aviso>}

      {pozoConfigurado && cargando && !vista && (
        <p className="header-tagline text-center">Leyendo el pozo…</p>
      )}

      {vista && pozo && (
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <div className="flex flex-col gap-4">
            <Premio vista={vista} ahora={ahora} revela={revela} />
            <Cifras vista={vista} />
            <Ganadores lista={lista} />
          </div>

          <div className="flex flex-col gap-4">
            <Panel titulo="🦊 Tu posición">
              {yo ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="stat">
                      <div className="stat-label">Tu capital</div>
                      <div className="stat-value verde cifra">
                        {aTexto(miSaldo)} <span className="stat-unit">XLM</span>
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">🎯 Tu probabilidad</div>
                      <div className="stat-value naranja cifra">
                        {(misChances / 100).toFixed(2)} <span className="stat-unit">%</span>
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-tenue">
                    Pesa lo que pusiste y por cuánto tiempo. Entrar recién sobre el cierre casi
                    no suma.
                  </p>

                  <div className="mt-4 flex gap-2">
                    {PRESETS.map((p) => (
                      <button
                        key={p}
                        className={`btn btn-blanco ${monto === p ? "seleccionado" : ""}`}
                        onClick={() => setMonto(p)}
                      >
                        {p}
                      </button>
                    ))}
                    {miSaldo > 0n && (
                      <button
                        className="btn btn-blanco"
                        onClick={() => setMonto(aTexto(miSaldo, 7))}
                      >
                        todo
                      </button>
                    )}
                  </div>
                  <input
                    inputMode="decimal"
                    placeholder="Monto en XLM"
                    value={monto}
                    onChange={(e) => setMonto(e.target.value)}
                    className="input-monto mt-2"
                  />
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Boton
                      onClick={() =>
                        correr("depositar", async () => {
                          const m = montoValido();
                          if (m == null) return;
                          await depositar(pozo.id, yo, m, firmar);
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
                      variante="peligro"
                      onClick={() =>
                        correr("retirar", async () => {
                          const m = montoValido();
                          if (m == null) return;
                          if (m > miSaldo) {
                            setError(`Tenés ${aTexto(miSaldo)} XLM en el pozo, no más.`);
                            return;
                          }
                          await retirar(pozo.id, yo, m, firmar);
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
                    Retirás cuando quieras, sin penalidad, aunque haya un sorteo en curso. Tu
                    capital nunca está en juego.
                  </p>
                </>
              ) : (
                <>
                  <p className="mb-4 text-sm text-tenue">
                    Conectá una wallet de Stellar para depositar y ver tu probabilidad.
                  </p>
                  <Boton onClick={conectarWallet} cargando={accion === "conectar"}>
                    Conectar wallet
                  </Boton>
                </>
              )}
            </Panel>

            <Blend vista={vista} />
            <ComoFunciona />
          </div>
        </div>
      )}
    </Marco>
  );
}

function Premio({ vista, ahora, revela }: { vista: Vista; ahora: number; revela: number | null }) {
  const faltan = Number(vista.cierraAt) - ahora;

  let etiqueta: string;
  let reloj: string;
  let nota: string;
  let pill: { texto: string; tono: "neutro" | "ok" | "alerta" };

  if (vista.sorteoPendiente) {
    const quedan = revela == null ? null : revela - ahora;
    etiqueta = "El ganador se conoce en";
    reloj = quedan == null ? "…" : quedan > 0 ? duracion(quedan) : "instantes";
    nota =
      quedan != null && quedan <= 0
        ? "El resultado ya está decidido; lo estamos trayendo a la red."
        : `Ya nadie puede cambiar el resultado. La ronda ${vista.ronda} ya arrancó: lo que entra ahora juega la próxima.`;
    pill = { texto: "🎲 Sorteo en curso", tono: "ok" };
  } else if (faltan <= 0) {
    etiqueta = "Cerrando la ronda";
    reloj = "…";
    nota = "En segundos se congela el premio y se elige al ganador.";
    pill = { texto: "⏳ Cerrando", tono: "alerta" };
  } else {
    etiqueta = "Se sortea en";
    reloj = duracion(faltan);
    nota = "Cuando llega a cero, el rendimiento se congela y uno se lo lleva.";
    pill = { texto: `Ronda ${vista.ronda} en curso`, tono: "neutro" };
  }

  return (
    <Panel titulo={<>🏆 {vista.sorteoPendiente ? "Premio de la ronda" : "Premio en juego"}</>}>
      <div className="flex items-baseline gap-2">
        <span className="premio-grande cifra">{aTexto(vista.premio, 4)}</span>
        <span className="text-sm font-bold text-tenue">XLM</span>
      </div>
      <div className="mb-3 mt-2">
        <Etiqueta tono={pill.tono}>{pill.texto}</Etiqueta>
      </div>
      <div className="countdown-wrap">
        <div className="countdown-label">{etiqueta}</div>
        <div className="countdown-timer">{reloj}</div>
      </div>
      <p className="mt-3 text-xs text-tenue">{nota}</p>
      <p className="mt-2 text-sm text-tenue">
        Es el rendimiento que generó el pozo entero en{" "}
        <span className="font-bold text-foreground">Blend</span>. Uno se lo lleva; los demás
        siguen con exactamente lo que pusieron.
      </p>
    </Panel>
  );
}

function Cifras({ vista }: { vista: Vista }) {
  const apy = apyTexto(vista.apyBps);
  return (
    <Panel titulo="📊 El pozo">
      <div className="grid grid-cols-3 gap-2">
        <div className="stat">
          <div className="stat-label">🦊 Participan</div>
          <div className="stat-value cifra">{vista.participantes}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Depositado</div>
          <div className="stat-value verde cifra">
            {aTexto(vista.principal, 0)} <span className="stat-unit">XLM</span>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">APY en Blend</div>
          <div className="stat-value verde cifra">
            {apy ?? "—"}
            {apy && <span className="pulso ml-1 inline-block align-middle" />}
          </div>
          {!apy && <span className="stat-secondary">midiendo…</span>}
        </div>
      </div>
    </Panel>
  );
}

function Blend({ vista }: { vista: Vista }) {
  const apy = apyTexto(vista.apyBps);
  return (
    <Panel titulo="🌊 De dónde sale el premio">
      <div className="aviso aviso-verde flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold">Blend, el mercado de crédito de Stellar</div>
          <div className="text-xs text-tenue">
            El capital del pozo se presta ahí. El interés que pagan los que piden prestado es el
            premio.
          </div>
        </div>
        <div className="cifra shrink-0 text-lg font-extrabold text-verde">{apy ?? "—"}</div>
      </div>
      <ul className="mt-3 space-y-1 text-xs text-tenue">
        <li>
          <span className="font-bold text-foreground">Sin colateral ni deuda.</span> La posición
          no puede ser liquidada.
        </li>
        <li>
          <span className="font-bold text-foreground">El capital no se toca.</span> Solo el
          interés generado entra al sorteo.
        </li>
        <li>
          <span className="font-bold text-foreground">Sin intermediarios.</span> El contrato
          deposita y retira de Blend por su cuenta.
        </li>
      </ul>
      <Link href="/docs#blend" className="mt-3 inline-block text-xs font-bold text-naranja underline underline-offset-4">
        Cómo se conecta con Blend →
      </Link>
    </Panel>
  );
}

function Ganadores({ lista }: { lista: Ganador[] | null }) {
  return (
    <Panel titulo="🎉 Últimos ganadores">
      {lista == null && <p className="text-xs text-tenue">Buscando sorteos…</p>}
      {lista && lista.length === 0 && (
        <p className="py-3 text-center text-sm text-tenue">Todavía no hubo sorteos en este pozo.</p>
      )}
      {lista && lista.length > 0 && (
        <div className="flex flex-col gap-2">
          {lista.map((g) => (
            <a
              key={g.tx}
              href={explorer(RED, "tx", g.tx)}
              target="_blank"
              rel="noopener"
              className="fila"
              title="Ver la transacción del sorteo"
            >
              <span className="text-tenue">
                <span className="font-bold text-foreground">Ronda {g.ronda}</span>
                <span className="mono ml-2">{corta(g.ganador)}</span>
              </span>
              <span className="cifra font-extrabold text-naranja">+{aTexto(g.premio, 4)} XLM</span>
            </a>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-tenue">
        Cada sorteo es una transacción pública. Tocá uno para verla.
      </p>
    </Panel>
  );
}

function ComoFunciona() {
  return (
    <Panel titulo="💡 Cómo funciona">
      <ol className="space-y-2 text-sm text-tenue">
        <li>
          <span className="font-bold text-foreground">Depositás.</span> Tu plata va a generar
          rendimiento en Blend junto con la de todos.
        </li>
        <li>
          <span className="font-bold text-foreground">Cada ronda se sortea el rendimiento.</span>{" "}
          Uno se lo lleva entero. Los demás no pierden nada: su capital sigue ahí.
        </li>
        <li>
          <span className="font-bold text-foreground">El azar viene de afuera.</span> Lo decide
          drand, un beacon público de ~20 organizaciones, y el contrato verifica la firma. Ni
          nosotros ni la red podemos elegir al ganador.
        </li>
      </ol>
      <Link href="/docs" className="mt-3 inline-block text-xs font-bold text-naranja underline underline-offset-4">
        Leer cómo está hecho →
      </Link>
    </Panel>
  );
}

function SinDeploy() {
  return (
    <Panel titulo="Falta el contrato">
      <p className="text-sm text-tenue">
        No hay ningún pozo configurado para esta red. Desplegalo y apuntá la app ahí:
      </p>
      <pre className="code-box mt-3">{`scripts/enchufar-blend-testnet.sh

# después, en web/.env.local
NEXT_PUBLIC_POZO=C...
NEXT_PUBLIC_RED=testnet`}</pre>
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
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function mensaje(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
