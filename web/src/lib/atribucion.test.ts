import { describe, expect, it } from "vitest";
import { emparejar, Vistos, type Intencion } from "./atribucion";
import { aStroops, admiteEtiqueta, aTexto, etiquetaDe } from "./montos";

const MONTO = 100_0000000n; // 100 unidades
const etiquetado = (n: bigint) => MONTO + n * 10n;

const pendientes: Intencion[] = [
  { miembro: "GAAA", montoEtiquetado: etiquetado(1n) },
  { miembro: "GBBB", montoEtiquetado: etiquetado(2n) },
  { miembro: "GCCC", montoEtiquetado: etiquetado(47n) },
];

describe("emparejar", () => {
  it("acredita al dueño del monto exacto", () => {
    const r = emparejar({ monto: etiquetado(47n), guid: "x" }, pendientes);
    expect(r).toEqual({ tipo: "acreditar", intencion: pendientes[2] });
  });

  it("no acredita si no hay intención por ese monto", () => {
    const r = emparejar({ monto: etiquetado(99n), guid: "x" }, pendientes);
    expect(r.tipo).toBe("ignorar");
    expect(r).toMatchObject({ motivo: "sin-intencion" });
  });

  it("no acredita el monto pelado sin etiqueta", () => {
    // Alguien mandó 100.0000000 exacto: no sabemos quién es.
    const r = emparejar({ monto: MONTO, guid: "x" }, pendientes);
    expect(r).toMatchObject({ tipo: "ignorar", motivo: "sin-intencion" });
  });

  it("rechaza montos con el 7º decimal en uso", () => {
    // El OFT lo habría recortado: esto no vino por el camino que esperamos.
    const r = emparejar({ monto: etiquetado(47n) + 3n, guid: "x" }, pendientes);
    expect(r).toMatchObject({ tipo: "ignorar", motivo: "septimo-decimal" });
  });

  it("no elige cuando dos intenciones comparten monto", () => {
    const chocadas: Intencion[] = [
      { miembro: "GAAA", montoEtiquetado: etiquetado(5n) },
      { miembro: "GBBB", montoEtiquetado: etiquetado(5n) },
    ];
    const r = emparejar({ monto: etiquetado(5n), guid: "x" }, chocadas);
    expect(r).toMatchObject({ tipo: "ignorar", motivo: "ambiguo" });
    if (r.tipo === "ignorar") {
      expect(r.detalle).toContain("GAAA");
      expect(r.detalle).toContain("GBBB");
    }
  });

  it("ignora montos no positivos", () => {
    expect(emparejar({ monto: 0n, guid: "x" }, pendientes)).toMatchObject({
      motivo: "monto-invalido",
    });
  });

  it("no acredita nada contra una lista vacía", () => {
    expect(emparejar({ monto: etiquetado(1n), guid: "x" }, [])).toMatchObject({
      motivo: "sin-intencion",
    });
  });
});

describe("Vistos", () => {
  it("acredita un guid una sola vez", () => {
    const v = new Vistos();
    expect(v.marcar("guid-1")).toBe(true);
    expect(v.marcar("guid-1")).toBe(false);
    expect(v.marcar("guid-2")).toBe(true);
    expect(v.tamaño).toBe(2);
  });
});

describe("montos", () => {
  it("ida y vuelta entre texto y stroops", () => {
    expect(aStroops("100")).toBe(100_0000000n);
    expect(aStroops("20.000047")).toBe(200000470n);
    expect(aStroops("0.0000001")).toBe(1n);
    expect(aTexto(200000470n)).toBe("20.000047");
    expect(aTexto(100_0000000n)).toBe("100.00");
    expect(aTexto(0n)).toBe("0.00");
  });

  it("acepta coma decimal, que es como se escribe acá", () => {
    expect(aStroops("1,50")).toBe(15000000n);
  });

  it("rechaza lo que no puede representar en vez de redondear", () => {
    expect(aStroops("0.00000001")).toBeNull(); // 8 decimales
    expect(aStroops("abc")).toBeNull();
    expect(aStroops("")).toBeNull();
    expect(aStroops("1.2.3")).toBeNull();
  });

  it("admiteEtiqueta es el mismo guard que crear_ronda", () => {
    expect(admiteEtiqueta(100_0000000n)).toBe(true);
    expect(admiteEtiqueta(100_0000001n)).toBe(false); // 7º decimal en uso
    expect(admiteEtiqueta(0n)).toBe(false);
    expect(admiteEtiqueta(-10n)).toBe(false);
  });

  it("etiquetaDe recupera el número de etiqueta", () => {
    expect(etiquetaDe(MONTO, etiquetado(47n))).toBe(47n);
    expect(etiquetaDe(MONTO, etiquetado(1n))).toBe(1n);
  });

  // El ejemplo textual de PRODUCTO.md, para que no se desincronice.
  it("reproduce el ejemplo de la spec: 20 -> 20.000047", () => {
    const base = aStroops("20")!;
    const conEtiqueta = base + 47n * 10n;
    expect(aTexto(conEtiqueta)).toBe("20.000047");
    expect(admiteEtiqueta(conEtiqueta)).toBe(true);
  });
});
