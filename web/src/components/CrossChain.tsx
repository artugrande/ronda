"use client";

import { useState } from "react";
import { aTexto, etiquetaDe } from "@/lib/montos";
import { Boton, Panel } from "./ui";

/**
 * El panel de aporte cross-chain.
 *
 * La única señal que tiene el indexer para saber quién pagó es el monto exacto
 * (ver PRODUCTO.md §Atribución), así que toda esta pantalla existe para una
 * sola cosa: que la persona mande *exactamente* el número que dice acá. Si
 * redondea, su plata llega al contrato y no se acredita a nadie.
 */
export function CrossChain({
  etiquetado,
  montoTurno,
  onPedir,
  cargando,
}: {
  etiquetado: bigint | null;
  montoTurno: bigint;
  onPedir: () => void;
  cargando: boolean;
}) {
  const [copiado, setCopiado] = useState(false);

  if (etiquetado == null) {
    return (
      <Panel
        titulo="Aportar desde otra cadena"
        pie="Si tenés los dólares en Tron, BSC o cualquier otra red, no hace falta que los muevas."
      >
        <Boton onClick={onPedir} cargando={cargando} variante="secundario">
          Pedir mi monto
        </Boton>
      </Panel>
    );
  }

  const texto = aTexto(etiquetado, 7);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sin portapapeles (http, permisos): el número está a la vista igual.
      setCopiado(false);
    }
  }

  return (
    <Panel titulo="Mandá exactamente este monto">
      <button
        onClick={copiar}
        className="w-full rounded-xl border border-acento/40 bg-acento/5 px-4 py-5 text-center"
      >
        <span className="cifra block text-3xl font-semibold tracking-tight break-all">
          {texto}
        </span>
        <span className="mt-2 block text-xs text-tenue">
          {copiado ? "copiado" : "tocá para copiar"}
        </span>
      </button>

      <div className="mt-4 space-y-2 text-sm text-tenue">
        <p>
          Son{" "}
          <span className="cifra text-foreground">{aTexto(montoTurno)}</span> de
          aporte más{" "}
          <span className="cifra text-foreground">
            {etiquetaDe(montoTurno, etiquetado).toString()}
          </span>{" "}
          de etiqueta. Esos decimales de más son lo que identifica que el aporte
          es tuyo.
        </p>
        <p className="text-alerta">
          No redondees. Si mandás un monto distinto, la plata llega al contrato
          pero no se acredita a tu nombre hasta que alguien lo resuelva a mano.
        </p>
      </div>
    </Panel>
  );
}
