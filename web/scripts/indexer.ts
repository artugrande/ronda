/**
 * Indexer de entregas cross-chain.
 *
 * Mira los eventos del token que llegan al contrato de la ronda, los machea
 * contra las intenciones pendientes por monto exacto y llama a `confirmar_oft`
 * con la key del oráculo.
 *
 * NUNCA SE CORRIÓ CONTRA UNA RED. Se escribió con el egress a *.stellar.org
 * bloqueado (ver README §Nota sobre el entorno). Arrancalo en testnet con
 * SOLO_MIRAR=1 y comparalo a mano contra el explorer antes de darle la key.
 *
 *   SOLO_MIRAR=1 npx tsx scripts/indexer.ts
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { emparejar, Vistos, type Intencion } from "../src/lib/atribucion";
import { aTexto } from "../src/lib/montos";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const env = (clave: string, porDefecto?: string): string => {
  const v = process.env[clave] ?? porDefecto;
  if (v === undefined) {
    console.error(`falta la variable de entorno ${clave}`);
    process.exit(2);
  }
  return v;
};

const RPC_URL = env("RPC_URL", "https://soroban-testnet.stellar.org");
const PASSPHRASE = env("PASSPHRASE", "Test SDF Network ; September 2015");
const CONTRATO = env("CONTRATO"); // el contrato `ronda`
const TOKEN = env("TOKEN"); // la SAC que recibe (USDT0 en mainnet)
const RONDA_ID = Number(env("RONDA_ID", "0"));
const INTERVALO_MS = Number(env("INTERVALO_MS", "5000"));
const SOLO_MIRAR = process.env.SOLO_MIRAR === "1";

const servidor = new rpc.Server(RPC_URL);
const vistos = new Vistos();

// ---------------------------------------------------------------------------
// Lectura de estado
// ---------------------------------------------------------------------------

type MiembroCrudo = { addr: unknown };

/**
 * Las intenciones pendientes de la ronda. Se releen en cada vuelta: el contrato
 * es la fuente de verdad, el indexer no guarda estado propio más allá de los
 * `guid` ya procesados.
 */
async function intencionesPendientes(): Promise<Intencion[]> {
  const { result } = await servidor.queryContract<{
    miembros: MiembroCrudo[];
  }>(CONTRATO, "estado", { ronda_id: RONDA_ID }, PASSPHRASE);

  const intenciones: Intencion[] = [];
  for (const m of result.miembros) {
    const miembro = String(m.addr);
    const { result: monto } = await servidor.queryContract<bigint | null>(
      CONTRATO,
      "intencion_de",
      { ronda_id: RONDA_ID, miembro },
      PASSPHRASE,
    );
    if (monto != null) {
      intenciones.push({ miembro, montoEtiquetado: BigInt(monto) });
    }
  }
  return intenciones;
}

// ---------------------------------------------------------------------------
// Lectura de eventos
// ---------------------------------------------------------------------------

type Llegada = { monto: bigint; guid: string; ledger: number };

/**
 * Traduce un evento del token a una llegada.
 *
 * Soporta las dos formas que nos importan:
 *
 * - `oft_received` del deployment de USDT0: topics
 *   `["oft_received", guid, src_eid, to]`, data `amount_received_ld`. Es el
 *   camino de mainnet.
 * - `transfer` de una SAC hacia el contrato. Es lo único que existe en testnet,
 *   donde no hay USDT0, y sirve para ensayar el flujo completo con USDC.
 *
 * Devuelve `null` para cualquier otro evento en vez de adivinar.
 */
function leerEvento(e: rpc.Api.EventResponse): Llegada | null {
  const topics = e.topic.map((t) => {
    try {
      return scValToNative(t);
    } catch {
      return null;
    }
  });
  const nombre = String(topics[0] ?? "");

  if (nombre === "oft_received") {
    const guid = String(topics[1] ?? e.id);
    const datos = scValToNative(e.value) as unknown;
    const monto = extraerMonto(datos);
    return monto == null ? null : { monto, guid, ledger: e.ledger };
  }

  if (nombre === "transfer") {
    const destino = String(topics[2] ?? "");
    if (destino !== CONTRATO) return null; // transferencia entre terceros
    const monto = extraerMonto(scValToNative(e.value) as unknown);
    // Sin `guid` propio, el id del evento es único por (ledger, posición) y
    // cumple la misma función: no acreditar dos veces la misma llegada.
    return monto == null ? null : { monto, guid: e.id, ledger: e.ledger };
  }

  return null;
}

function extraerMonto(datos: unknown): bigint | null {
  if (typeof datos === "bigint") return datos;
  if (typeof datos === "number") return BigInt(datos);
  if (datos && typeof datos === "object") {
    const registro = datos as Record<string, unknown>;
    for (const clave of ["amount_received_ld", "amount", "monto"]) {
      const v = registro[clave];
      if (typeof v === "bigint") return v;
      if (typeof v === "number") return BigInt(v);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

async function confirmar(llegada: Llegada, oraculo: Keypair): Promise<void> {
  const cuenta = await servidor.getAccount(oraculo.publicKey());
  const contrato = new Contract(CONTRATO);

  // El `guid` del contrato es BytesN<32>. El id de evento del RPC no lo es, así
  // que lo llevamos a 32 bytes de forma determinística para que el registro
  // on-chain siga siendo trazable hasta el evento que lo originó.
  const guid = Buffer.alloc(32);
  Buffer.from(llegada.guid.replace(/^0x/, ""), "utf8").copy(guid, 0, 0, 32);

  const tx = new TransactionBuilder(
    new Account(cuenta.accountId(), cuenta.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase: PASSPHRASE },
  )
    .addOperation(
      contrato.call(
        "confirmar_oft",
        nativeToScVal(RONDA_ID, { type: "u32" }),
        nativeToScVal(llegada.monto, { type: "i128" }),
        nativeToScVal(guid, { type: "bytes" }) as xdr.ScVal,
      ),
    )
    .setTimeout(60)
    .build();

  const simulacion = await servidor.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulacion)) {
    throw new Error(`simulación: ${simulacion.error}`);
  }

  const ensamblada = rpc.assembleTransaction(tx, simulacion).build();
  ensamblada.sign(oraculo);

  const enviada = await servidor.sendTransaction(ensamblada);
  if (enviada.status === "ERROR") {
    throw new Error(`envío: ${JSON.stringify(enviada.errorResult)}`);
  }

  // sendTransaction devuelve PENDING, no éxito.
  const resultado = await servidor.pollTransaction(enviada.hash, {
    attempts: 60,
  });
  if (resultado.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`no entró: ${resultado.status}`);
  }
  console.log(`  ✓ acreditado · tx ${enviada.hash}`);
}

// ---------------------------------------------------------------------------
// Bucle
// ---------------------------------------------------------------------------

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const oraculo = SOLO_MIRAR
    ? null
    : Keypair.fromSecret(env("ORACULO_SECRET"));

  console.log(`ronda   ${CONTRATO} #${RONDA_ID}`);
  console.log(`token   ${TOKEN}`);
  console.log(`rpc     ${RPC_URL}`);
  console.log(
    SOLO_MIRAR
      ? "modo    SOLO MIRAR — no firma nada"
      : `oráculo ${oraculo!.publicKey()}`,
  );
  console.log();

  const { sequence } = await servidor.getLatestLedger();
  let desde = sequence;

  for (;;) {
    try {
      const respuesta = await servidor.getEvents({
        startLedger: desde,
        filters: [{ type: "contract", contractIds: [TOKEN] }],
        limit: 200,
      });

      const pendientes = await intencionesPendientes();

      for (const evento of respuesta.events) {
        const llegada = leerEvento(evento);
        if (!llegada) continue;
        if (!vistos.marcar(llegada.guid)) continue;

        const resultado = emparejar(llegada, pendientes);
        const monto = aTexto(llegada.monto, 7);

        if (resultado.tipo === "ignorar") {
          console.log(
            `· ledger ${llegada.ledger} · ${monto} · ignorado (${resultado.motivo}): ${resultado.detalle}`,
          );
          continue;
        }

        console.log(
          `· ledger ${llegada.ledger} · ${monto} → ${resultado.intencion.miembro}`,
        );
        if (!oraculo) {
          console.log("  (solo mirar: no se firma)");
          continue;
        }
        try {
          await confirmar(llegada, oraculo);
        } catch (e) {
          // No marcamos el guid como fallido: si la próxima vuelta lo vuelve a
          // ver, lo reintenta. `confirmar_oft` es idempotente del lado del
          // contrato — la segunda vez falla con YaAporto y no duplica el aporte.
          console.error(`  ✗ ${e instanceof Error ? e.message : e}`);
        }
      }

      desde = (respuesta.latestLedger ?? desde) + 1;
    } catch (e) {
      console.error(`bucle: ${e instanceof Error ? e.message : e}`);
    }

    await dormir(INTERVALO_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
