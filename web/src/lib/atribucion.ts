/**
 * El corazón del indexer: decidir a quién corresponde una entrega cross-chain.
 *
 * El evento `oft_received` trae `["oft_received", guid, src_eid, to]` y
 * `amount_received_ld`. No trae de forma confiable quién de los miembros pagó
 * (ver PRODUCTO.md §Atribución), así que la única señal es el monto exacto.
 *
 * Estas funciones son puras a propósito: es la parte del sistema que, si se
 * equivoca, acredita la plata de uno a otro.
 */

import { PASO_ETIQUETA } from "./montos";

export type Intencion = {
  miembro: string;
  /** El monto exacto que el contrato le dijo que mandara. */
  montoEtiquetado: bigint;
};

export type Entrega = {
  /** `amount_received_ld`, en decimales locales (7). */
  monto: bigint;
  guid: string;
};

export type Resultado =
  | { tipo: "acreditar"; intencion: Intencion }
  | { tipo: "ignorar"; motivo: MotivoIgnorar; detalle: string };

export type MotivoIgnorar =
  | "sin-intencion"
  | "ambiguo"
  | "septimo-decimal"
  | "monto-invalido";

/**
 * Empareja una entrega contra las intenciones pendientes.
 *
 * Nunca adivina: si no hay match exacto, o si hay más de uno, devuelve
 * `ignorar` para que lo resuelva una persona. Acreditar de más es peor que
 * acreditar de menos — lo segundo se arregla, lo primero paga a quien no puso.
 */
export function emparejar(
  entrega: Entrega,
  pendientes: readonly Intencion[],
): Resultado {
  if (entrega.monto <= 0n) {
    return {
      tipo: "ignorar",
      motivo: "monto-invalido",
      detalle: `monto ${entrega.monto} no es positivo`,
    };
  }

  // El OFT recorta el 7º decimal antes de armar el mensaje: una entrega con el
  // 7º en algo distinto de cero no salió del camino que esperamos. Puede ser un
  // depósito nativo directo, o un OFT con otros decimales compartidos. En
  // cualquier caso no es nuestra etiqueta.
  if (entrega.monto % PASO_ETIQUETA !== 0n) {
    return {
      tipo: "ignorar",
      motivo: "septimo-decimal",
      detalle: `monto ${entrega.monto} tiene el 7º decimal en uso; la etiqueta vive en el 6º`,
    };
  }

  const coincidencias = pendientes.filter(
    (i) => i.montoEtiquetado === entrega.monto,
  );

  if (coincidencias.length === 0) {
    return {
      tipo: "ignorar",
      motivo: "sin-intencion",
      detalle: `ninguna intención pendiente por ${entrega.monto}`,
    };
  }

  // El contrato garantiza etiquetas únicas por ronda, así que esto solo puede
  // pasar si el indexer mezcló rondas. Es un bug nuestro, no del usuario: parar.
  if (coincidencias.length > 1) {
    return {
      tipo: "ignorar",
      motivo: "ambiguo",
      detalle: `${coincidencias.length} intenciones comparten el monto ${entrega.monto}: ${coincidencias
        .map((c) => c.miembro)
        .join(", ")}`,
    };
  }

  return { tipo: "acreditar", intencion: coincidencias[0] };
}

/**
 * Entregas ya procesadas, por `guid`. El RPC puede devolver el mismo evento más
 * de una vez (reorgs, solapamiento de ventanas de paginado), y acreditar dos
 * veces el mismo `guid` sería contar un aporte que entró una sola vez.
 */
export class Vistos {
  private readonly guids = new Set<string>();

  /** `true` si es la primera vez que se ve este `guid`. */
  marcar(guid: string): boolean {
    if (this.guids.has(guid)) return false;
    this.guids.add(guid);
    return true;
  }

  get tamaño(): number {
    return this.guids.size;
  }
}
