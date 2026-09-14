"use client";

import { TEST } from "@/lib/config";
import { PozoApp } from "@/components/PozoApp";

/**
 * El pozo de prueba: testnet, rondas de 10 minutos. Para que cualquiera (el
 * jurado, por ejemplo) vea el ciclo entero sin esperar una semana ni poner
 * plata real. No se enlaza desde la home; solo desde Docs.
 */
export default function Test() {
  return <PozoApp pozo={TEST} activo="test" />;
}
