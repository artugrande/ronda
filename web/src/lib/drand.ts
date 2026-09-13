/**
 * drand quicknet: traer beacons y dejarlos en el formato que espera el pozo.
 *
 * El contrato verifica firmas BLS12-381 on-chain, pero el host de Soroban no
 * descomprime puntos: recibe G1 en 96 bytes y G2 en 192, sin comprimir. drand
 * sirve todo comprimido (48 y 96), así que la descompresión pasa por acá.
 *
 * El layout sin comprimir es el de zkcrypto/arkworks, que es el del host:
 *
 *   G1:  be(x) || be(y)
 *   G2:  be(x_c1) || be(x_c0) || be(y_c1) || be(y_c0)
 *
 * Hay un test que cruza el generador G2 de noble contra el que está tipeado a
 * mano en `contracts/pozo/src/drand.rs`: si el layout o la transcripción
 * estuvieran mal, no coincidirían.
 */

import { bls12_381 } from "@noble/curves/bls12-381";

/** Red de drand. Es la única que usamos: unchained, firma en G1, 3s. */
export const QUICKNET = {
  url: "https://api.drand.sh/v2/beacons/quicknet",
  hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  esquema: "bls-unchained-g1-rfc9380",
} as const;

export type Info = {
  public_key: string;
  period: number;
  genesis_time: number;
  hash: string;
  schemeID: string;
};

export type Beacon = {
  round: number;
  signature: string;
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Clave pública G2, de comprimida (96 bytes) a sin comprimir (192). */
export function descomprimirG2(comprimidaHex: string): string {
  return hex(bls12_381.G2.ProjectivePoint.fromHex(comprimidaHex).toRawBytes(false));
}

/** Firma G1, de comprimida (48 bytes) a sin comprimir (96). */
export function descomprimirG1(comprimidaHex: string): string {
  return hex(bls12_381.G1.ProjectivePoint.fromHex(comprimidaHex).toRawBytes(false));
}

/** Generador estándar de G2, sin comprimir. Para el test cruzado. */
export function generadorG2(): string {
  return hex(bls12_381.G2.ProjectivePoint.BASE.toRawBytes(false));
}

/** Ronda vigente en `t` (Unix, segundos). Espejo de `drand::ronda_en`. */
export function rondaEn(genesis: number, periodo: number, t: number): number {
  if (t < genesis || periodo <= 0) return 0;
  return Math.floor((t - genesis) / periodo) + 1;
}

/** Cuándo se publica una ronda. */
export function momentoDe(genesis: number, periodo: number, ronda: number): number {
  return genesis + (ronda - 1) * periodo;
}

export async function info(fetchImpl: typeof fetch = fetch): Promise<Info> {
  const r = await fetchImpl(`${QUICKNET.url}/info`);
  if (!r.ok) throw new Error(`drand info: HTTP ${r.status}`);
  const j = (await r.json()) as Info;
  if (j.hash !== QUICKNET.hash) {
    throw new Error(`drand: el hash de la red no es el de quicknet: ${j.hash}`);
  }
  if (j.schemeID !== QUICKNET.esquema) {
    throw new Error(`drand: esquema inesperado ${j.schemeID}`);
  }
  return j;
}

/**
 * Trae la firma de una ronda. Si todavía no salió, drand devuelve 404: se
 * traduce a `null` para que el que llama espere en vez de fallar.
 */
export async function beacon(
  ronda: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Beacon | null> {
  const r = await fetchImpl(`${QUICKNET.url}/rounds/${ronda}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`drand ronda ${ronda}: HTTP ${r.status}`);
  return (await r.json()) as Beacon;
}
