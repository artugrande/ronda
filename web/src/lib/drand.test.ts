import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  descomprimirG1,
  descomprimirG2,
  generadorG2,
  momentoDe,
  rondaEn,
} from "./drand";

/**
 * Los 192 bytes del generador G2 están tipeados a mano en el contrato. Un
 * test de Rust ya verifica que caen en la curva y en el subgrupo; este cruza
 * los bytes exactos contra una implementación independiente. Si el layout
 * (c1 || c0) o cualquier dígito estuviera mal, no coincidirían.
 */
function generadorDelContrato(): string {
  const rs = readFileSync(
    join(__dirname, "../../../contracts/pozo/src/drand.rs"),
    "utf8",
  );
  const m = rs.match(/0x([0-9a-f]{384})/);
  if (!m) throw new Error("no encontré el generador en drand.rs");
  return m[1];
}

describe("drand", () => {
  it("el generador G2 del contrato coincide con el de noble", () => {
    expect(generadorDelContrato()).toBe(generadorG2());
  });

  it("descomprime al tamaño que espera el host", () => {
    const g2 = bls12_381Base("G2");
    expect(descomprimirG2(g2).length).toBe(192 * 2);
    const g1 = bls12_381Base("G1");
    expect(descomprimirG1(g1).length).toBe(96 * 2);
  });

  it("descomprimir el generador comprimido da el generador", () => {
    expect(descomprimirG2(bls12_381Base("G2"))).toBe(generadorG2());
  });

  it("rondaEn sigue el reloj de drand, igual que el contrato", () => {
    expect(rondaEn(100, 3, 99)).toBe(0);
    expect(rondaEn(100, 3, 100)).toBe(1);
    expect(rondaEn(100, 3, 102)).toBe(1);
    expect(rondaEn(100, 3, 103)).toBe(2);
    expect(rondaEn(100, 3, 100 + 3 * 200)).toBe(201);
  });

  it("momentoDe invierte a rondaEn", () => {
    for (const r of [1, 2, 200, 12_345]) {
      expect(rondaEn(100, 3, momentoDe(100, 3, r))).toBe(r);
    }
  });
});

function bls12_381Base(grupo: "G1" | "G2"): string {
  // Import perezoso para que el resto del archivo no dependa de noble.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { bls12_381 } = require("@noble/curves/bls12-381");
  return Buffer.from(
    bls12_381[grupo].ProjectivePoint.BASE.toRawBytes(true),
  ).toString("hex");
}
