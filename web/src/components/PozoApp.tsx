"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Pozo } from "@/lib/config";
import {
  RACHA_MAX,
  SEGUNDOS_DIA,
  ahorrarHoy,
  apyTexto,
  chancesBps,
  cuentaDe,
  depositar,
  depositarConReferente,
  estado,
  ganadorSeConoceEn,
  ganadores,
  retirar,
  saldo,
  type Cuenta,
  type Ganador,
  type Vista,
} from "@/lib/pozo";
import { aStroops, aTexto } from "@/lib/montos";
import { conectar, desconectar, direccionActual, firmar } from "@/lib/wallet";
import { porcentaje, tasaBlend, type TasaBlend } from "@/lib/blend";
import { agregarTrustline, estadoBilletera, type EstadoBilletera } from "@/lib/billetera";
import { cambiar, cotizar, dondeCambia, type Cotizacion } from "@/lib/cambio";
import { Marco } from "@/components/Marco";
import { BotonWallet } from "@/components/Wallet";
import { Boton, Etiqueta, Panel, corta, explorer } from "@/components/ui";
import { IconoMoneda } from "@/components/Logos";

type Accion = null | "depositar" | "cambiar" | "retirar" | "conectar" | "racha" | "trustline";

/**
 * Con qué paga el usuario: `null` es el token del pozo; si no, el símbolo de
 * una moneda de entrada (XLM, USDT0) que se cambia en Soroswap o en el DEX.
 */
type Moneda = string | null;

/** Un cartel de estado: qué pasó, en lenguaje normal, y opcionalmente la transacción o el detalle técnico. */
type Mensaje = { texto: string; tx?: string; detalle?: string };

/** XLM que hay que dejar en la wallet: la reserva de Stellar más fees. */
const RESERVA_XLM = 15_000_000n;

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
 * keeper hizo algo en este pozo, para releer el contrato enseguida.
 */
async function empujarKeeper(pozoId: string): Promise<boolean> {
  try {
    const r = await fetch("/api/keeper", { method: "POST" });
    const j = (await r.json()) as {
      ok: boolean;
      pozos?: { pozo: string; ok: boolean; paso?: { accion: string; tx: string | null } }[];
    };
    return Boolean(
      j.ok &&
        j.pozos?.some(
          (p) => p.pozo === pozoId && p.ok && p.paso && p.paso.accion !== "espera" && p.paso.tx,
        ),
    );
  } catch {
    return false;
  }
}

function hayTrabajo(v: Vista, ahora: number): boolean {
  if (v.sorteoPendiente) return true;
  return v.participantes > 0 && ahora >= Number(v.cierraAt);
}

/** `?ref=G...` en la URL: quién invitó. Solo cuenta en el primer depósito. */
function leerReferente(): string | null {
  if (typeof window === "undefined") return null;
  const ref = new URLSearchParams(window.location.search).get("ref");
  return ref && /^G[A-Z2-7]{55}$/.test(ref) ? ref : null;
}

export function PozoApp({ pozo, activo }: { pozo: Pozo | null; activo: "app" | "test" }) {
  const [yo, setYo] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista | null>(null);
  /** Cuándo se leyó `vista`, en ms: el premio en pantalla crece desde ahí. */
  const [leidoEn, setLeidoEn] = useState(0);
  const [revela, setRevela] = useState<number | null>(null);
  const [lista, setLista] = useState<Ganador[] | null>(null);
  const [tasa, setTasa] = useState<TasaBlend | null>(null);
  const [cuenta, setCuenta] = useState<Cuenta | null>(null);
  const [billetera, setBilletera] = useState<EstadoBilletera | null>(null);
  const [miSaldo, setMiSaldo] = useState<bigint>(0n);
  const [misChances, setMisChances] = useState<number>(0);
  const [monto, setMonto] = useState("");
  const [error, setErrorCrudo] = useState<Mensaje | null>(null);
  const [aviso, setAvisoCrudo] = useState<Mensaje | null>(null);
  const setError = (m: string | Mensaje | null) =>
    setErrorCrudo(typeof m === "string" ? { texto: m } : m);
  const setAviso = (m: string | Mensaje | null) =>
    setAvisoCrudo(typeof m === "string" ? { texto: m } : m);
  const [accion, setAccion] = useState<Accion>(null);
  const [cargando, setCargando] = useState(true);
  const [referente, setReferente] = useState<string | null>(null);
  const [moneda, setMoneda] = useState<Moneda>(null);
  const [cotizacion, setCotizacion] = useState<Cotizacion | null>(null);
  /** El monto que nadie pudo cotizar, para no insistir. */
  const [sinCotizacion, setSinCotizacion] = useState<bigint | null>(null);
  const ahora = useAhora();
  const ultimoEmpujon = useRef(0);

  const refrescar = useCallback(
    async (direccion: string | null) => {
      if (!pozo) return;
      try {
        const [v, s, ch, c, b] = await Promise.all([
          estado(pozo),
          direccion ? saldo(pozo, direccion) : Promise.resolve(0n),
          direccion ? chancesBps(pozo, direccion) : Promise.resolve(0),
          direccion ? cuentaDe(pozo, direccion) : Promise.resolve(null),
          direccion ? estadoBilletera(pozo, direccion).catch(() => null) : Promise.resolve(null),
        ]);
        setVista(v);
        setLeidoEn(Date.now());
        setMiSaldo(s);
        setMisChances(ch);
        setCuenta(c);
        setBilletera(b);
        setRevela(await ganadorSeConoceEn(pozo, v));
        setError(null);

        const t = Math.floor(Date.now() / 1000);
        if (hayTrabajo(v, t) && t - ultimoEmpujon.current >= KEEPER_CADA_S) {
          ultimoEmpujon.current = t;
          if (await empujarKeeper(pozo.id)) {
            const v2 = await estado(pozo);
            setVista(v2);
            setLeidoEn(Date.now());
            setRevela(await ganadorSeConoceEn(pozo, v2));
            ganadores(pozo).then(setLista).catch(() => {});
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

  useEffect(() => {
    if (!pozo) return;
    let direccion: string | null = null;
    (async () => {
      direccion = await direccionActual(pozo.red);
      setYo(direccion);
      setReferente(leerReferente());
      await refrescar(direccion);
    })();
    ganadores(pozo).then(setLista).catch(() => setLista([]));
    tasaBlend(pozo).then(setTasa).catch(() => setTasa(null));
    const t = setInterval(() => refrescar(direccion), REFRESCO_S * 1000);
    return () => clearInterval(t);
  }, [refrescar, pozo]);

  // Cotización en vivo mientras se escribe un monto en XLM. Con espera, para
  // no pedirle una simulación al RPC por cada tecla. La cotización guardada
  // vale solo si es del monto que está escrito ahora; si no, se está pidiendo.
  const entrada = moneda ? (pozo?.entradas?.monedas.find((m) => m.simbolo === moneda) ?? null) : null;
  const entraOtra = entrada ? aStroops(monto) : null;
  const cotizacionVigente =
    entrada && entraOtra != null && entraOtra > 0n && cotizacion?.entra === entraOtra &&
    cotizacion.moneda.simbolo === entrada.simbolo
      ? cotizacion
      : null;
  const cotizando =
    entraOtra != null && entraOtra > 0n && !cotizacionVigente && sinCotizacion !== entraOtra;
  useEffect(() => {
    if (!pozo || !yo || !entrada || entraOtra == null || entraOtra <= 0n) return;
    let vigente = true;
    const t = setTimeout(async () => {
      try {
        const c = await cotizar(pozo, yo, entrada, entraOtra);
        if (vigente) setCotizacion(c);
      } catch {
        if (vigente) setSinCotizacion(entraOtra);
      }
    }, 400);
    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [pozo, entrada, entraOtra, yo]);

  /** Lo que la wallet tiene de la moneda de entrada elegida. */
  const saldoEntrada = entrada && billetera ? billetera.entradas[entrada.simbolo] : null;

  async function correr(cual: Exclude<Accion, null>, fn: () => Promise<void>) {
    setAccion(cual);
    setError(null);
    setAviso(null);
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
      if (!pozo) return;
      const direccion = await conectar(pozo.red);
      setYo(direccion);
      await refrescar(direccion);
    });

  const firmante = (xdr: string) => firmar(xdr, pozo?.passphrase);

  // El referente aplica solo si todavía no hay cuenta y no es uno mismo.
  const referenteAplica = Boolean(referente && !cuenta && yo && referente !== yo);

  const sinTrustline = Boolean(yo && billetera && billetera.existe && !billetera.trustline);

  const hoy = Math.floor(ahora / SEGUNDOS_DIA);
  const marcoHoy = cuenta != null && cuenta.ultimoDia === hoy;
  const rachaViva =
    cuenta != null && (cuenta.ultimoDia === hoy || cuenta.ultimoDia + 1 === hoy) ? cuenta.racha : 0;

  return (
    <Marco
      activo={activo === "test" ? "app" : "app"}
      red={pozo?.red}
      wallet={
        <BotonWallet
          yo={yo}
          cargando={accion === "conectar"}
          onConectar={conectarWallet}
          onDesconectar={() =>
            correr("conectar", async () => {
              await desconectar();
              setYo(null);
              setCuenta(null);
              setBilletera(null);
              setMiSaldo(0n);
              setMisChances(0);
            })
          }
        />
      }
    >
      {!pozo && <SinDeploy />}

      {pozo && activo === "test" && (
        <div className="aviso text-center">
          🧪 <strong>Pozo de prueba en testnet.</strong> Rondas de 10 minutos con XLM de
          mentira, para ver el ciclo entero. El de verdad está en la{" "}
          <Link href="/" className="font-bold text-naranja underline underline-offset-4">
            home
          </Link>
          .
        </div>
      )}

      {pozo && activo === "app" && pozo.red === "testnet" && (
        <div className="aviso text-center">
          🧪 Este pozo corre en <strong>testnet</strong> con XLM de prueba. El de mainnet, en
          USDC, está en camino.
        </div>
      )}

      {error && <Cartel m={error} tono="rojo" red={pozo?.red} />}
      {aviso && <Cartel m={aviso} tono="verde" red={pozo?.red} />}

      {pozo && cargando && !vista && <p className="header-tagline text-center">Leyendo el pozo…</p>}

      {vista && pozo && (
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <div className="flex flex-col gap-4">
            <Premio
              vista={vista}
              ahora={ahora}
              revela={revela}
              simbolo={pozo.simbolo}
              tasa={tasa}
              leidoEn={leidoEn}
            />
            <Cifras vista={vista} tasa={tasa} simbolo={pozo.simbolo} />
            {yo && (
              <Racha
                cuenta={cuenta}
                miSaldo={miSaldo}
                marcoHoy={marcoHoy}
                rachaViva={rachaViva}
                cargando={accion === "racha"}
                deshabilitado={accion !== null}
                onMarcar={() =>
                  correr("racha", async () => {
                    const tx = await ahorrarHoy(pozo, yo, firmante);
                    await refrescar(yo);
                    setAviso({ texto: "🔥 Racha marcada. Mañana suma más.", tx });
                  })
                }
              />
            )}
            <Ganadores lista={lista} red={pozo.red} simbolo={pozo.simbolo} />
          </div>

          <div className="flex flex-col gap-4">
            <Panel titulo="🦊 Tu posición">
              {yo ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="stat">
                      <div className="stat-label">Tu capital</div>
                      <div className="stat-value verde cifra">
                        {aTexto(miSaldo)} <span className="stat-unit">{pozo.simbolo}</span>
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
                    Pesa lo que pusiste, por cuánto tiempo, más tu racha y tus referidos.
                  </p>

                  {billetera && billetera.existe && (
                    <p className="mt-2 text-xs text-tenue">
                      En tu wallet: <span className="cifra font-bold text-foreground">{aTexto(billetera.saldo)} {pozo.simbolo}</span>
                    </p>
                  )}
                  {billetera && !billetera.existe && (
                    <p className="aviso mt-3 text-xs">
                      Esta wallet todavía no existe en {pozo.red}: mandale XLM primero.
                    </p>
                  )}
                  {sinTrustline && (
                    <div className="aviso mt-3">
                      <p className="text-xs">
                        Tu wallet todavía no acepta {pozo.simbolo}. Es un paso de Stellar, una sola
                        vez, y no cuesta nada más que la fee.
                      </p>
                      <div className="mt-2">
                        <Boton
                          onClick={() =>
                            correr("trustline", async () => {
                              const tx = await agregarTrustline(pozo, yo, firmante);
                              await refrescar(yo);
                              setAviso({ texto: `✓ Tu wallet ya acepta ${pozo.simbolo}.`, tx });
                            })
                          }
                          cargando={accion === "trustline"}
                          disabled={accion !== null}
                        >
                          Agregar {pozo.simbolo} a mi wallet
                        </Boton>
                      </div>
                    </div>
                  )}

                  {referenteAplica && (
                    <p className="aviso aviso-verde mt-3 text-xs">
                      🤝 Te invitó <span className="mono">{corta(referente!)}</span>. Con tu
                      primer depósito, los dos suman chances.
                    </p>
                  )}

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
                      <button className="btn btn-blanco" onClick={() => setMonto(aTexto(miSaldo, 7))}>
                        todo
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input
                      inputMode="decimal"
                      placeholder={`Monto en ${entrada ? entrada.simbolo : pozo.simbolo}`}
                      value={monto}
                      onChange={(e) => setMonto(e.target.value)}
                      className="input-monto flex-1"
                    />
                    {pozo.entradas && (
                      <div className="flex gap-1" role="radiogroup" aria-label="Pagar con">
                        {[null, ...pozo.entradas.monedas.map((m) => m.simbolo)].map((m) => (
                          <button
                            key={m ?? pozo.simbolo}
                            role="radio"
                            aria-checked={moneda === m}
                            className={`btn btn-blanco btn-moneda ${moneda === m ? "seleccionado" : ""}`}
                            onClick={() => setMoneda(m)}
                            disabled={accion !== null}
                          >
                            <IconoMoneda simbolo={m ?? pozo.simbolo} alto={16} />
                            {m ?? pozo.simbolo}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {entrada && (
                    <p className="mt-2 text-xs text-tenue">
                      {saldoEntrada && !saldoEntrada.trustline ? (
                        `Tu wallet no tiene ${entrada.simbolo}. Conseguí un poco en Freighter o Lobstr y volvé.`
                      ) : cotizacionVigente ? (
                        <>
                          Tus {aTexto(cotizacionVigente.entra)} {entrada.simbolo} son{" "}
                          <span className="cifra font-bold text-foreground">
                            ≈ {aTexto(cotizacionVigente.sale, 2)} {pozo.simbolo}
                          </span>{" "}
                          hoy en {dondeCambia(cotizacionVigente)}, el que más da ahora. Se cambian
                          en tu wallet y entra el {pozo.simbolo}: tu capital queda en dólares desde
                          el primer segundo.
                          {saldoEntrada && ` Tenés ${aTexto(saldoEntrada.saldo)} ${entrada.simbolo}.`}
                        </>
                      ) : cotizando ? (
                        "Cotizando en Soroswap y en el DEX de Stellar…"
                      ) : sinCotizacion != null && sinCotizacion === entraOtra ? (
                        "No hay cotización para ese monto ahora. Probá con otro."
                      ) : (
                        `Poné un monto en ${entrada.simbolo} y te digo cuánto ${pozo.simbolo} es hoy.` +
                        (saldoEntrada ? ` Tenés ${aTexto(saldoEntrada.saldo)}.` : "")
                      )}
                    </p>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {entrada ? (
                      <Boton
                        onClick={() =>
                          correr("cambiar", async () => {
                            const entra = montoValido();
                            if (entra == null) return;
                            if (!entrada.activo && billetera && entra > billetera.xlm - RESERVA_XLM) {
                              setError(
                                `Tenés ${aTexto(billetera.xlm)} XLM. Dejá al menos 1,5 XLM para la reserva de Stellar y las fees.`,
                              );
                              return;
                            }
                            if (entrada.activo && saldoEntrada && entra > saldoEntrada.saldo) {
                              setError(`Tenés ${aTexto(saldoEntrada.saldo)} ${entrada.simbolo} en la wallet, no más.`);
                              return;
                            }
                            // Cotización fresca al momento de firmar, no la de la pantalla.
                            const c = await cotizar(pozo, yo, entrada, entra);
                            setCotizacion(c);
                            if (vista.tope > 0n && vista.principal + c.sale > vista.tope) {
                              setError(
                                `El pozo tiene un tope de ${aTexto(vista.tope, 0)} ${pozo.simbolo} y ya hay ${aTexto(vista.principal, 0)}.`,
                              );
                              return;
                            }
                            const recibido = await cambiar(pozo, yo, c, firmante);
                            setAviso(
                              `✓ Cambiaste ${aTexto(entra)} ${entrada.simbolo} por ${aTexto(recibido)} ${pozo.simbolo}. Ahora firmá el depósito.`,
                            );
                            let tx: string;
                            try {
                              tx = referenteAplica
                                ? await depositarConReferente(pozo, yo, recibido, referente!, firmante)
                                : await depositar(pozo, yo, recibido, firmante);
                            } catch (e) {
                              // El cambio ya está hecho: que el error no diga que no pasó nada.
                              const m = mensaje(e);
                              setAviso(null);
                              setError({
                                ...m,
                                texto: `El cambio salió bien: tenés ${aTexto(recibido)} ${pozo.simbolo} en tu wallet. Lo que no se completó es el depósito. ${m.texto} Cuando lo resuelvas, elegí ${pozo.simbolo} y tocá Depositar.`,
                              });
                              return;
                            }
                            setMonto("");
                            setAviso({
                              texto: `✓ Cambiaste ${aTexto(entra)} ${entrada.simbolo} y depositaste ${aTexto(recibido)} ${pozo.simbolo}. Ya estás en el sorteo.`,
                              tx,
                            });
                            await refrescar(yo);
                          })
                        }
                        cargando={accion === "cambiar"}
                        disabled={
                          accion !== null ||
                          sinTrustline ||
                          !cotizacionVigente ||
                          (saldoEntrada != null && !saldoEntrada.trustline)
                        }
                      >
                        Cambiar y depositar
                      </Boton>
                    ) : (
                      <Boton
                        onClick={() =>
                          correr("depositar", async () => {
                            const m = montoValido();
                            if (m == null) return;
                            if (vista.tope > 0n && vista.principal + m > vista.tope) {
                              setError(
                                `El pozo tiene un tope de ${aTexto(vista.tope, 0)} ${pozo.simbolo} y ya hay ${aTexto(vista.principal, 0)}.`,
                              );
                              return;
                            }
                            const tx = referenteAplica
                              ? await depositarConReferente(pozo, yo, m, referente!, firmante)
                              : await depositar(pozo, yo, m, firmante);
                            setMonto("");
                            setAviso({
                              texto: `✓ Depositaste ${aTexto(m)} ${pozo.simbolo}. Ya estás en el sorteo, y tu capital sale cuando quieras.`,
                              tx,
                            });
                            await refrescar(yo);
                          })
                        }
                        cargando={accion === "depositar"}
                        disabled={accion !== null || sinTrustline}
                      >
                        Depositar
                      </Boton>
                    )}
                    <Boton
                      variante="peligro"
                      onClick={() =>
                        correr("retirar", async () => {
                          const m = montoValido();
                          if (m == null) return;
                          if (m > miSaldo) {
                            setError(`Tenés ${aTexto(miSaldo)} ${pozo.simbolo} en el pozo, no más.`);
                            return;
                          }
                          const tx = await retirar(pozo, yo, m, firmante);
                          setMonto("");
                          setAviso({ texto: `✓ Retiraste ${aTexto(m)} ${pozo.simbolo}. Ya está en tu wallet.`, tx });
                          await refrescar(yo);
                        })
                      }
                      cargando={accion === "retirar"}
                      disabled={accion !== null || miSaldo === 0n || entrada != null}
                    >
                      Retirar
                    </Boton>
                  </div>
                  <p className="mt-3 text-xs text-tenue">
                    Retirás cuando quieras, sin penalidad, aunque haya un sorteo en curso. Tu
                    capital nunca está en juego.
                    {entrada && ` Los retiros son siempre en ${pozo.simbolo}.`}
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

            {yo && cuenta && <Referidos yo={yo} cuenta={cuenta} ruta={pozo.ruta} simbolo={pozo.simbolo} />}
            <Blend tasa={tasa} simbolo={pozo.simbolo} />
            <ComoFunciona />
          </div>
        </div>
      )}
    </Marco>
  );
}

/** Milisegundos desde epoch, refrescados varias veces por segundo. Para lo que se ve crecer. */
function useAhoraMs(cadaMs: number): number {
  const [ms, setMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setMs(Date.now()), cadaMs);
    return () => clearInterval(t);
  }, [cadaMs]);
  return ms;
}

const SEGUNDOS_ANIO = 365.25 * 86400;

/**
 * El premio como se ve crecer: lo que dijo el contrato al leerlo, más lo que
 * el capital genera desde entonces a la tasa de Blend. Es una estimación
 * entre lecturas (cada 20 s se vuelve a leer y se corrige); el contrato es
 * la verdad. Congelado si el sorteo está pendiente: ese premio ya no cambia.
 */
function premioEnVivo(vista: Vista, tasa: TasaBlend | null, leidoEn: number, ahoraMs: number): bigint {
  if (vista.sorteoPendiente || !tasa || vista.principal <= 0n || leidoEn <= 0) return vista.premio;
  const segundos = Math.max(0, (ahoraMs - leidoEn) / 1000);
  const crecio = Number(vista.principal) * tasa.apy * (segundos / SEGUNDOS_ANIO);
  return vista.premio + BigInt(Math.floor(crecio));
}

function Premio({
  vista,
  ahora,
  revela,
  simbolo,
  tasa,
  leidoEn,
}: {
  vista: Vista;
  ahora: number;
  revela: number | null;
  simbolo: string;
  tasa: TasaBlend | null;
  leidoEn: number;
}) {
  const faltan = Number(vista.cierraAt) - ahora;
  const ahoraMs = useAhoraMs(200);
  const premio = premioEnVivo(vista, tasa, leidoEn, ahoraMs);
  const enVivo = !vista.sorteoPendiente && tasa != null && vista.principal > 0n;

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
    nota = enVivo
      ? "El premio crece segundo a segundo con el interés de Blend. Cuando el reloj llega a cero, se congela y uno se lo lleva."
      : "Cuando llega a cero, el rendimiento se congela y uno se lo lleva.";
    pill = { texto: `Ronda ${vista.ronda} en curso`, tono: "neutro" };
  }

  return (
    <Panel titulo={<>🏆 {vista.sorteoPendiente ? "Premio de la ronda" : "Premio en juego"}</>}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="premio-grande cifra">{aTexto(premio, enVivo ? 7 : 2)}</span>
        <span className="text-sm font-bold text-tenue">{simbolo}</span>
        {enVivo && (
          <span className="en-vivo" title="Crece con el interés de Blend, segundo a segundo">
            <span className="en-vivo-punto" /> en vivo
          </span>
        )}
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
        <span className="font-bold text-foreground">Blend</span>, no el capital. Uno se lo
        lleva; los demás siguen con exactamente lo que pusieron.
        {vista.premio === 0n && vista.principal > 0n && " Recién arranca: crece con las horas."}
      </p>
    </Panel>
  );
}

/**
 * El APY que se muestra: el que Blend paga ahora por el token, leído del
 * pool. Si no se pudo leer, el que midió el pozo con su propio rendimiento.
 */
function apyMostrado(vista: Vista, tasa: TasaBlend | null): string | null {
  if (tasa) return porcentaje(tasa.apy);
  return apyTexto(vista.apyBps);
}

function Cifras({ vista, tasa, simbolo }: { vista: Vista; tasa: TasaBlend | null; simbolo: string }) {
  const apy = apyMostrado(vista, tasa);
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
            {aTexto(vista.principal, 0)} <span className="stat-unit">{simbolo}</span>
          </div>
          {vista.tope > 0n && (
            <span className="stat-secondary">tope {aTexto(vista.tope, 0)} {simbolo}</span>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">APY en Blend</div>
          <div className="stat-value verde cifra">
            {apy ?? "—"}
            {apy && <span className="pulso ml-1 inline-block align-middle" />}
          </div>
          {apy && tasa && (
            <span className="stat-secondary">
              pool al {(tasa.utilizacion * 100).toFixed(0)} % de uso
            </span>
          )}
          {!apy && <span className="stat-secondary">leyendo el pool…</span>}
        </div>
      </div>
    </Panel>
  );
}

function Racha({
  cuenta,
  miSaldo,
  marcoHoy,
  rachaViva,
  cargando,
  deshabilitado,
  onMarcar,
}: {
  cuenta: Cuenta | null;
  miSaldo: bigint;
  marcoHoy: boolean;
  rachaViva: number;
  cargando: boolean;
  deshabilitado: boolean;
  onMarcar: () => void;
}) {
  const dias = Array.from({ length: RACHA_MAX }, (_, i) => i + 1);
  const siguiente = Math.min(rachaViva + 1, RACHA_MAX);
  return (
    <Panel titulo="🔥 Tu racha">
      <div className="mb-3 flex items-center justify-between gap-2">
        {dias.map((d) => {
          const hecho = d <= rachaViva;
          const actual = !marcoHoy && d === siguiente && miSaldo > 0n;
          return (
            <div
              key={d}
              className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-extrabold ${
                hecho
                  ? "bg-[#fff3e0] text-naranja ring-2 ring-[rgba(253,132,14,0.3)]"
                  : actual
                    ? "bg-white text-naranja ring-2 ring-naranja"
                    : "bg-[#f0f0f0] text-[#a0a0a0]"
              } ${d === RACHA_MAX && hecho ? "bg-gradient-to-br from-[#ffd580] to-[#e06800] text-white" : ""}`}
            >
              {d}
            </div>
          );
        })}
      </div>
      <button
        className="btn btn-naranja"
        onClick={onMarcar}
        disabled={deshabilitado || marcoHoy || miSaldo === 0n}
      >
        {cargando
          ? "…"
          : marcoHoy
            ? "✓ Hoy ya marcaste"
            : miSaldo === 0n
              ? "Depositá para arrancar la racha"
              : rachaViva === 0
                ? "🔥 Ahorré hoy"
                : `🔥 Ahorré hoy · día ${siguiente}`}
      </button>
      <p className="mt-3 text-xs text-tenue">
        Una vez por día. Cada día seguido suma más chances a la ronda; siete días seguidos las{" "}
        <span className="font-bold text-foreground">duplican</span>. Saltear un día vuelve al
        día 1.
        {cuenta && cuenta.racha > 0 && rachaViva === 0 && " Tu racha anterior se cortó."}
      </p>
    </Panel>
  );
}

function Referidos({ yo, cuenta, ruta, simbolo }: { yo: string; cuenta: Cuenta; ruta: string; simbolo: string }) {
  const [copiado, setCopiado] = useState(false);
  const link =
    typeof window === "undefined" ? "" : `${window.location.origin}${ruta}?ref=${yo}`;
  return (
    <Panel titulo="🤝 Invitá amigos">
      <p className="text-sm text-tenue">
        Cada amigo que entra con tu link te suma el{" "}
        <span className="font-bold text-foreground">10 % de su capital</span> como chances,
        mientras esté adentro. Hasta la mitad de tu propio capital.
      </p>
      <div className="mt-3 flex gap-2">
        <input readOnly value={link} className="input-monto flex-1 !text-left !text-xs !font-semibold !text-tenue" />
        <button
          className="btn btn-naranja !w-auto"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopiado(true);
              setTimeout(() => setCopiado(false), 2000);
            } catch {}
          }}
        >
          {copiado ? "✓" : "Copiar"}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="stat">
          <div className="stat-label">Referidos</div>
          <div className="stat-value cifra">{cuenta.referidos}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Te suman</div>
          <div className="stat-value naranja cifra">
            {aTexto(cuenta.bonoRef, 0)} <span className="stat-unit">{simbolo} de peso</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Blend({ tasa, simbolo }: { tasa: TasaBlend | null; simbolo: string }) {
  const apy = tasa ? porcentaje(tasa.apy) : null;
  return (
    <Panel titulo="🌊 De dónde sale el premio">
      <div className="aviso aviso-verde flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold">Blend, el mercado de crédito de Stellar</div>
          <div className="text-xs text-tenue">
            El {simbolo} del pozo se presta ahí. El interés que pagan los que piden prestado es el
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

function Ganadores({ lista, red, simbolo }: { lista: Ganador[] | null; red: string; simbolo: string }) {
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
              href={explorer(red, "tx", g.tx)}
              target="_blank"
              rel="noopener"
              className="fila"
              title="Ver la transacción del sorteo"
            >
              <span className="text-tenue">
                <span className="font-bold text-foreground">Ronda {g.ronda}</span>
                <span className="mono ml-2">{corta(g.ganador)}</span>
              </span>
              <span className="cifra font-extrabold text-naranja">+{aTexto(g.premio, 4)} {simbolo}</span>
            </a>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-tenue">Cada sorteo es una transacción pública. Tocá uno para verla.</p>
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
          <span className="font-bold text-foreground">Cada semana se sortea el rendimiento.</span>{" "}
          Uno se lo lleva entero. Los demás no pierden nada: su capital sigue ahí.
        </li>
        <li>
          <span className="font-bold text-foreground">Sumás chances</span> con más plata, más
          tiempo, la racha diaria y tus referidos.
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
      <p className="text-sm text-tenue">No hay ningún pozo configurado. Desplegalo y apuntá la app ahí:</p>
      <pre className="code-box mt-3">{`scripts/enchufar-blend-testnet.sh      # testnet
scripts/desplegar-mainnet.sh           # mainnet

# después, las direcciones van en web/src/lib/config.ts`}</pre>
    </Panel>
  );
}

/** "6d 23:59:58", "23:59:58" o "09:58": siempre con los segundos corriendo. */
function duracion(segundos: number): string {
  const d = Math.floor(segundos / 86400);
  const h = Math.floor((segundos % 86400) / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  const dos = (n: number) => n.toString().padStart(2, "0");
  const hms = `${dos(h)}:${dos(m)}:${dos(s)}`;
  if (d > 0) return `${d}d ${hms}`;
  if (h > 0) return hms;
  return `${dos(m)}:${dos(s)}`;
}

/**
 * Los errores del host son para quien programa. Los que un usuario puede
 * provocar se traducen; el resto se muestra tal cual, que es lo que sirve
 * para reportarlo.
 */
function Cartel({ m, tono, red }: { m: Mensaje; tono: "verde" | "rojo"; red?: string }) {
  return (
    <div className={`aviso aviso-${tono}`} role={tono === "rojo" ? "alert" : "status"}>
      {m.texto}
      {m.tx && red && (
        <>
          {" "}
          <a href={explorer(red, "tx", m.tx)} target="_blank" rel="noreferrer">
            Ver transacción
          </a>
        </>
      )}
      {m.detalle && (
        <details>
          <summary>Detalle técnico</summary>
          <p>{m.detalle}</p>
        </details>
      )}
    </div>
  );
}

function mensaje(e: unknown): Mensaje {
  const crudo = e instanceof Error ? e.message : String(e);
  const con = (texto: string): Mensaje => ({ texto, detalle: crudo });

  // Wallet
  if (crudo.includes("User declined") || crudo.includes("rejected")) {
    return { texto: "Cancelaste la firma en la wallet. No pasó nada." };
  }
  if (crudo.includes("no respondió")) {
    return con("La wallet no respondió. Fijate que esté abierta y en la red correcta, y probá de nuevo.");
  }

  // Saldo y fees
  if (crudo.includes("balance is not within the allowed range")) {
    return con("No te alcanza el saldo de la wallet para ese monto. Stellar además reserva 1 XLM que no se puede gastar.");
  }
  if (crudo.includes("tx_insufficient_balance")) {
    // La red cobra el storage que crea la transacción. El primer depósito
    // del pozo arma el árbol del sorteo y paga su renta; los siguientes, no.
    const fee = /"fee_charged":"(\d+)"/.exec(crudo)?.[1];
    const cuanto = fee ? `${aTexto(BigInt(fee), 2)} XLM` : "más XLM del que tenés libre";
    return con(
      `La red pide ${cuanto} de fee para esta transacción y tu wallet no tiene tanto XLM libre (Stellar reserva 1,5 XLM). Mandale XLM y volvé a intentar. Si venías de un cambio, el USDC ya está en tu wallet: elegí USDC y tocá Depositar.`,
    );
  }
  if (crudo.includes("tx_insufficient_fee")) {
    return con("La red está cargada y la fee no alcanzó. Esperá unos segundos y probá de nuevo.");
  }

  // Errores del pozo, por código
  const pozo: Record<string, string> = {
    "#2": "El monto tiene que ser mayor a cero.",
    "#3": "Estás intentando retirar más de lo que tenés en el pozo.",
    "#4": "El pozo está lleno.",
    "#5": "Esa wallet no tiene capital en el pozo.",
    "#13": "El pozo llegó a su tope de capital. Probá con menos.",
    "#14": "Hoy ya marcaste la racha. Mañana suma más.",
    "#15": "Para marcar la racha tenés que tener capital adentro.",
    "#16": "Ese link de invitación no es válido: el que invita tiene que estar en el pozo.",
    "#17": "El link de invitación solo cuenta en tu primer depósito.",
  };
  const codigo = /Error\(Contract, (#\d+)\)/.exec(crudo)?.[1];
  if (codigo && pozo[codigo]) return con(pozo[codigo]);

  // Cambio
  if (crudo.includes("nadie cotiza")) {
    return con("No hay cotización para ese monto ahora, ni en Soroswap ni en el DEX. Probá con otro monto o en un rato.");
  }
  if (crudo.includes("op_under_dest_min") || crudo.includes("op_too_few_offers")) {
    return con("El precio se movió más de lo aceptado entre la cotización y la firma. No se cambió nada: probá de nuevo.");
  }
  if (crudo.includes("deadline") || crudo.includes("Deadline")) {
    return con("Tardaste más de diez minutos en firmar y la cotización venció. Probá de nuevo.");
  }

  // Red
  if (crudo.includes("no entró") || crudo.includes("TRY_AGAIN_LATER")) {
    return con("La transacción no llegó a entrar en la red. No se movió nada: probá de nuevo.");
  }
  if (crudo.includes("fetch") || crudo.includes("Failed to fetch") || crudo.includes("NetworkError")) {
    return con("No pude hablar con la red de Stellar. Fijate tu conexión y probá de nuevo.");
  }

  return con("Algo salió mal y no se completó. No se movió nada de tu wallet. Probá de nuevo; si sigue, el detalle técnico ayuda a entender qué pasó.");
}
