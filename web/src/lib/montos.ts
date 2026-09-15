/** Conversión entre stroops y texto. Stellar maneja 7 decimales. */

export const DECIMALES = 7;
export const UNIDAD = 10_000_000n; // 1 unidad = 10^7 stroops

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
