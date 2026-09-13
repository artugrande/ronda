/**
 * Conversión entre stroops y texto. Stellar maneja 7 decimales; el OFT recorta
 * el 7º antes de armar el mensaje cross-chain, así que acá vive todo lo que
 * tiene que saber de esa asimetría.
 */

export const DECIMALES = 7;
export const UNIDAD = 10_000_000n; // 1 unidad = 10^7 stroops

/** Paso mínimo que sobrevive al viaje cross-chain. Espejo de `PASO_ETIQUETA`. */
export const PASO_ETIQUETA = 10n;

/** Espejo de `MAX_ETIQUETA` en el contrato. */
export const MAX_ETIQUETA = 9_999n;

/** Formatea stroops como texto con 7 decimales, sin ceros de cola sobrantes. */
export function aTexto(stroops: bigint, decimalesMin = 2): string {
  const negativo = stroops < 0n;
  const abs = negativo ? -stroops : stroops;
  const entera = abs / UNIDAD;
  const resto = (abs % UNIDAD).toString().padStart(DECIMALES, "0");

  let decimales = resto.replace(/0+$/, "");
  while (decimales.length < decimalesMin) decimales += "0";

  const cuerpo = decimales.length > 0 ? `${entera}.${decimales}` : `${entera}`;
  return negativo ? `-${cuerpo}` : cuerpo;
}

/**
 * Parsea texto a stroops. Devuelve `null` ante cualquier cosa que no sea un
 * número con a lo sumo 7 decimales — nunca redondea por su cuenta, porque un
 * redondeo silencioso acá mueve plata.
 */
export function aStroops(texto: string): bigint | null {
  const limpio = texto.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(limpio)) return null;

  const negativo = limpio.startsWith("-");
  const sinSigno = negativo ? limpio.slice(1) : limpio;
  const [entera, decimales = ""] = sinSigno.split(".");
  if (decimales.length > DECIMALES) return null;

  const stroops =
    BigInt(entera) * UNIDAD + BigInt(decimales.padEnd(DECIMALES, "0"));
  return negativo ? -stroops : stroops;
}

/**
 * `true` si el monto puede llevar etiqueta cross-chain: el 7º decimal tiene que
 * ser cero, porque el OFT lo recorta y la etiqueta se perdería.
 *
 * Es el mismo guard que aplica `crear_ronda` on-chain.
 */
export function admiteEtiqueta(stroops: bigint): boolean {
  return stroops > 0n && stroops % PASO_ETIQUETA === 0n;
}

/** La parte etiquetada de un monto, en unidades de etiqueta. */
export function etiquetaDe(montoTurno: bigint, etiquetado: bigint): bigint {
  return (etiquetado - montoTurno) / PASO_ETIQUETA;
}
