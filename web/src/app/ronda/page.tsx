"use client";

import { useCallback, useEffect, useState } from "react";
import { CONTRATO, RONDA_ID, configurado } from "@/lib/config";
import {
  acreditar,
  ejecutarTurno,
  estado,
  intencionDe,
  registrarIntencion,
  type Miembro,
  type Vista,
} from "@/lib/contrato";
import { aTexto } from "@/lib/montos";
import { conectar, direccionActual, firmar } from "@/lib/wallet";
import { CrossChain } from "@/components/CrossChain";
import { Boton, Error as Aviso, Etiqueta, Panel, corta } from "@/components/ui";
import { Marco } from "@/components/Marco";
import { BotonWallet } from "@/components/Wallet";
import Link from "next/link";

type Accion = null | "aportar" | "intencion" | "turno" | "conectar";

/**
 * Segundos desde epoch, refrescados cada segundo.
 *
 * Va en estado y no leído en render: si se lee `Date.now()` al renderizar, el
 * "turno vencido" solo se entera de que venció cuando algo más provoca un
 * re-render, y el botón para cerrarlo no aparece hasta que la persona recarga.
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
  const [etiquetado, setEtiquetado] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accion, setAccion] = useState<Accion>(null);
  const [cargandoVista, setCargandoVista] = useState(true);
  const ahora = useAhora();

  const refrescar = useCallback(
    async (direccion: string | null) => {
      if (!configurado) return;
      try {
        const v = await estado(RONDA_ID);
        setVista(v);
        setEtiquetado(direccion ? await intencionDe(RONDA_ID, direccion) : null);
        setError(null);
      } catch (e) {
        setError(mensaje(e));
      } finally {
        setCargandoVista(false);
      }
    },
    [],
  );

  useEffect(() => {
    (async () => {
      const direccion = await direccionActual();
      setYo(direccion);
      await refrescar(direccion);
    })();
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

  const miembro = vista?.miembros.find((m) => m.addr === yo) ?? null;
  const debeAportar = Boolean(yo && vista?.pendientes.includes(yo));
  const turnoVencido =
    vista != null &&
    vista.estado === "EnCurso" &&
    BigInt(ahora) >= vista.proximoTurnoAt;

  return (
    <Marco
      activo="ronda"
      ancho="max-w-lg"
      wallet={
        <BotonWallet
          yo={yo}
          cargando={accion === "conectar"}
          onConectar={() =>
            correr("conectar", async () => {
              const direccion = await conectar();
              setYo(direccion);
              await refrescar(direccion);
            })
          }
        />
      }
    >
      <div>
        <h1 className="logo-texto">Ronda</h1>
        <p className="header-tagline">
          La vaquita de siempre, pero el contrato guarda la plata. El primer producto; el pozo
          está en la <Link href="/">app</Link>.
        </p>
      </div>

      {!configurado && <SinDeploy />}

      {error && (
        <div className="mb-4">
          <Aviso>{error}</Aviso>
        </div>
      )}

      {configurado && cargandoVista && (
        <p className="text-sm text-tenue">Leyendo el contrato…</p>
      )}

      {vista && (
        <div className="space-y-4">
          <Resumen vista={vista} ahora={ahora} />

          {vista.estado === "EnCurso" && yo && miembro && (
            <>
              {debeAportar && miembro.estado !== "Moroso" && (
                <Panel
                  titulo="Tu aporte de este turno"
                  pie={`Se transfieren ${aTexto(vista.montoTurno)} desde tu cuenta en Stellar.`}
                >
                  <Boton
                    onClick={() =>
                      correr("aportar", async () => {
                        await acreditar(RONDA_ID, yo, firmar);
                        await refrescar(yo);
                      })
                    }
                    cargando={accion === "aportar"}
                  >
                    Aportar {aTexto(vista.montoTurno)}
                  </Boton>
                </Panel>
              )}

              {debeAportar && miembro.estado !== "Moroso" && (
                <CrossChain
                  etiquetado={etiquetado}
                  montoTurno={vista.montoTurno}
                  cargando={accion === "intencion"}
                  onPedir={() =>
                    correr("intencion", async () => {
                      await registrarIntencion(RONDA_ID, yo, firmar);
                      await refrescar(yo);
                    })
                  }
                />
              )}

              {!debeAportar && miembro.estado !== "Moroso" && (
                <Panel>
                  <p className="text-sm text-tenue">
                    Ya aportaste este turno. Falta que aporten{" "}
                    {vista.pendientes.length}.
                  </p>
                </Panel>
              )}

              {miembro.estado === "Moroso" && (
                <Panel titulo="Quedaste afuera">
                  <p className="text-sm text-tenue">
                    No aportaste a tiempo, así que perdiste tu turno de cobro y
                    no podés seguir aportando. Tenés{" "}
                    {miembro.incumplimientos}{" "}
                    {miembro.incumplimientos === 1
                      ? "incumplimiento"
                      : "incumplimientos"}{" "}
                    registrados on-chain.
                  </p>
                </Panel>
              )}
            </>
          )}

          {vista.estado === "EnCurso" && yo && turnoVencido && (
            <Panel
              titulo="El turno está vencido"
              pie="Lo puede cerrar cualquiera. Paga lo que se haya juntado y marca a los que no aportaron."
            >
              <Boton
                variante="secundario"
                onClick={() =>
                  correr("turno", async () => {
                    await ejecutarTurno(RONDA_ID, yo, firmar);
                    await refrescar(yo);
                  })
                }
                cargando={accion === "turno"}
              >
                Cerrar el turno
              </Boton>
            </Panel>
          )}

          <Miembros vista={vista} yo={yo} />
        </div>
      )}
    </Marco>
  );
}

function Resumen({ vista, ahora }: { vista: Vista; ahora: number }) {
  const finalizada = vista.estado === "Finalizada";
  return (
    <Panel>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-tenue">
            {finalizada ? "Ronda terminada" : `Turno ${vista.turno + 1}`}
          </p>
          <p className="cifra mt-1 text-3xl font-semibold tracking-tight">
            {aTexto(vista.pozo)}
          </p>
          <p className="mt-1 text-sm text-tenue">
            juntado de{" "}
            <span className="cifra">
              {aTexto(vista.montoTurno * BigInt(vista.miembros.length))}
            </span>
          </p>
        </div>
        {!finalizada && <Cuenta hasta={vista.proximoTurnoAt} ahora={ahora} />}
      </div>

      {!finalizada && vista.beneficiario && (
        <p className="mt-4 border-t border-borde pt-3 text-sm">
          <span className="text-tenue">Cobra </span>
          <span className="font-medium">{corta(vista.beneficiario, 6)}</span>
        </p>
      )}
    </Panel>
  );
}

function Cuenta({ hasta, ahora }: { hasta: bigint; ahora: number }) {
  const faltan = Number(hasta) - ahora;
  if (faltan <= 0) {
    return <Etiqueta tono="alerta">vencido</Etiqueta>;
  }

  const dias = Math.floor(faltan / 86400);
  const horas = Math.floor((faltan % 86400) / 3600);
  const minutos = Math.floor((faltan % 3600) / 60);

  return (
    <div className="text-right">
      <p className="text-xs uppercase tracking-wider text-tenue">cierra en</p>
      <p className="cifra mt-1 text-lg font-medium">
        {dias > 0 ? `${dias}d ${horas}h` : `${horas}h ${minutos}m`}
      </p>
    </div>
  );
}

function Miembros({ vista, yo }: { vista: Vista; yo: string | null }) {
  return (
    <Panel titulo={`Miembros (${vista.miembros.length})`}>
      <ul className="divide-y divide-borde">
        {vista.miembros.map((m, i) => (
          <Fila
            key={m.addr}
            m={m}
            posicion={i}
            esTurno={i === vista.turno && vista.estado === "EnCurso"}
            soyYo={m.addr === yo}
            pendiente={vista.pendientes.includes(m.addr)}
          />
        ))}
      </ul>
    </Panel>
  );
}

function Fila({
  m,
  posicion,
  esTurno,
  soyYo,
  pendiente,
}: {
  m: Miembro;
  posicion: number;
  esTurno: boolean;
  soyYo: boolean;
  pendiente: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          <span className="cifra mr-2 text-tenue">{posicion + 1}</span>
          {corta(m.addr, 6)}
          {soyYo && <span className="ml-2 text-xs text-acento">vos</span>}
        </p>
        <p className="mt-0.5 text-xs text-tenue">
          aportó <span className="cifra">{aTexto(m.aportado)}</span>
          {m.cobrado > 0n && (
            <>
              {" · cobró "}
              <span className="cifra">{aTexto(m.cobrado)}</span>
            </>
          )}
        </p>
      </div>
      <div className="shrink-0">
        {m.estado === "Moroso" ? (
          <Etiqueta tono="alerta">
            {m.incumplimientos > 1 ? `${m.incumplimientos} faltas` : "moroso"}
          </Etiqueta>
        ) : m.estado === "Cobro" ? (
          <Etiqueta tono="ok">cobró</Etiqueta>
        ) : pendiente ? (
          <Etiqueta tono={esTurno ? "alerta" : "neutro"}>debe</Etiqueta>
        ) : (
          <Etiqueta tono="ok">al día</Etiqueta>
        )}
      </div>
    </li>
  );
}

function SinDeploy() {
  return (
    <Panel titulo="Falta el contrato">
      <p className="text-sm text-tenue">
        No hay ningún contrato configurado todavía. Desplegalo y apuntá la app
        ahí:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-xl border border-borde bg-background p-3 text-xs leading-relaxed">
        {`scripts/deploy.sh testnet <identidad>

# después, en web/.env.local
NEXT_PUBLIC_CONTRATO=C...
NEXT_PUBLIC_RED=testnet`}
      </pre>
      <p className="mt-3 text-xs text-tenue">
        Valor actual: <code className="cifra">{CONTRATO || "(vacío)"}</code>
      </p>
    </Panel>
  );
}

function mensaje(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
