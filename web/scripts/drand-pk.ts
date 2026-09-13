/**
 * Imprime lo que el constructor del pozo necesita de drand quicknet:
 *
 *   <clave pública G2 sin comprimir, 192 bytes hex>
 *   <genesis_time>
 *   <period>
 *
 * Lo consume scripts/ensayo-pozo-testnet.sh. Verifica el hash de la red y el
 * esquema antes de imprimir nada: una clave de otra red que se cuele acá
 * dejaría un pozo que nunca puede sortear.
 *
 *   npx tsx scripts/drand-pk.ts
 */

import { descomprimirG2, info } from "../src/lib/drand";

// Sin top-level await: tsx compila esto como CommonJS y ahí no existe.
async function main() {
  const i = await info();
  console.log(descomprimirG2(i.public_key));
  console.log(i.genesis_time);
  console.log(i.period);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
