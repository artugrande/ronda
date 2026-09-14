/**
 * Cuánto cuesta subir un WASM a una red, sin subirlo: simula la transacción y
 * muestra la fee de recursos que pide la red. Sirve para mandarle a la cuenta
 * lo justo antes de un deploy en mainnet.
 *
 *   npx tsx scripts/costo-deploy.ts G... [red]
 *
 * La cuenta tiene que existir en la red (la simulación la usa de origen; no
 * firma ni gasta nada). Red: mainnet (por defecto) o testnet.
 */

import { readFileSync } from "node:fs";
import { Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { PASSPHRASE, RPC, type Red } from "../src/lib/config";

const WASMS = ["pozo", "blend_adapter"];

async function main() {
  const [cuentaId, redArg] = process.argv.slice(2);
  if (!cuentaId) {
    console.error("uso: npx tsx scripts/costo-deploy.ts G... [mainnet|testnet]");
    process.exit(2);
  }
  const red: Red = redArg === "testnet" ? "testnet" : "mainnet";
  const servidor = new rpc.Server(RPC[red]);
  const cuenta = await servidor.getAccount(cuentaId);

  let total = 0n;
  for (const nombre of WASMS) {
    const wasm = readFileSync(`../target/wasm32v1-none/release/${nombre}.wasm`);
    const tx = new TransactionBuilder(cuenta, { fee: "100", networkPassphrase: PASSPHRASE[red] })
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setTimeout(60)
      .build();
    const sim = await servidor.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      console.log(`${nombre}: la simulación falló: ${"error" in sim ? sim.error : "?"}`);
      continue;
    }
    const fee = BigInt(sim.minResourceFee);
    total += fee;
    console.log(
      `${nombre.padEnd(14)} ${(wasm.length / 1024).toFixed(1).padStart(5)} KB → subirlo cuesta ${xlm(fee)} XLM`,
    );
  }
  console.log(`\nsubir los dos: ${xlm(total)} XLM. Deploy + renta de 30 días de cada instancia: ~3 XLM más por contrato.`);
}

const xlm = (stroops: bigint) => (Number(stroops) / 10_000_000).toFixed(2);

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
