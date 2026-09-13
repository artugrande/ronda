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
  Address,
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

/** Eventos por página. El RPC corta acá y devuelve un cursor para seguir. */
const LIMITE = 200;

/** Tope de páginas por vuelta, para no quedarse dando vueltas si hay atraso. */
const MAX_PAGINAS = 20;

/**
 * Escotilla: apaga el filtro por topics y trae todos los eventos del token.
 *
 * Los filtros de topics dependen de la forma exacta de los topics del evento,
 * que cambió entre protocolos. Si el indexer no ve nada que deberías estar
 * viendo, arrancalo con SIN_FILTRO_TOPICS=1: si ahí aparece, el filtro está mal
 * y hay que ajustarlo. Es lento pero no miente.
 */
const SIN_FILTRO_TOPICS = process.env.SIN_FILTRO_TOPICS === "1";

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
 * Filtros del lado del RPC.
 *
 * Sin esto, con el SAC de XLM nativo el indexer se trae todas las
 * transferencias de XLM de la red para descartarlas en el cliente. Pinchamos la
 * dirección de destino en el topic para que el RPC haga el trabajo.
 *
 * Van tres alternativas porque la forma del topic cambia:
 *
 *   transfer      ["transfer", from, to]              (3 topics)
 *   transfer      ["transfer", from, to, asset]       (4, protocolos nuevos)
 *   oft_received  ["oft_received", guid, src_eid, to] (4)
 */
function filtros(): rpc.Api.EventFilter[] {
  const base: rpc.Api.EventFilter = { type: "contract", contractIds: [TOKEN] };
  if (SIN_FILTRO_TOPICS) return [base];

  // Los topics del filtro van como ScVal en XDR base64.
  //
  // OJO: el ejemplo del docstring de `getEvents` en el SDK está viejo — usa
  // "AAAABQAAAAh0cmFuc2Zlcg==" para `transfer`, que arranca con discriminante 5
  // (SCV_U64). Un símbolo es 15 (SCV_SYMBOL) y da "AAAADwAAAAh0cmFuc2Zlcg==".
  // No lo "corrijas" copiando el ejemplo: verificado por round-trip.
  const b64 = (v: xdr.ScVal) => v.toXDR("base64");
  const sim = (s: string) => b64(nativeToScVal(s, { type: "symbol" }));
  const destino = b64(new Address(CONTRATO).toScVal());

  return [
    {
      ...base,
      topics: [
        [sim("transfer"), "*", destino],
        [sim("transfer"), "*", destino, "*"],
        [sim("oft_received"), "*", "*", destino],
      ],
    },
  ];
}

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
  let desde: number | null = sequence;
  let cursor: string | null = null;

  console.log(`mirando desde el ledger ${sequence}`);
  if (SIN_FILTRO_TOPICS) {
    console.log("⚠ filtro de topics apagado: va a traer mucho ruido");
  }
  console.log();

  for (;;) {
    try {
      let pendientes = await intencionesPendientes();

      // Drenar todas las páginas de la ventana antes de dormir. Avanzar por
      // ledger en vez de por cursor perdía en silencio todo lo que no entrara
      // en la primera página — y con el SAC de XLM nativo eso pasa seguido.
      for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
        // `cursor` y `startLedger` son mutuamente excluyentes: el RPC rechaza
        // los dos juntos.
        const respuesta: rpc.Api.GetEventsResponse = await servidor.getEvents(
          cursor === null
            ? { startLedger: desde!, filters: filtros(), limit: LIMITE }
            : { cursor, filters: filtros(), limit: LIMITE },
        );

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

          const quien = resultado.intencion.miembro;
          console.log(`· ledger ${llegada.ledger} · ${monto} → ${quien}`);

          if (!oraculo) {
            console.log("  (solo mirar: no se firma)");
            continue;
          }
          try {
            await confirmar(llegada, oraculo);
            // Esa intención ya no está pendiente: sacarla de la lista local
            // evita que una segunda llegada del mismo monto en esta misma
            // vuelta parezca que le corresponde.
            pendientes = pendientes.filter((i) => i.miembro !== quien);
          } catch (e) {
            // El guid queda marcado igual: si falla, la próxima vuelta no lo
            // reintenta a ciegas. `confirmar_oft` es idempotente del lado del
            // contrato (la segunda vez corta con YaAporto), pero un reintento
            // automático en loop solo llena el log de la misma falla.
            console.error(`  ✗ ${e instanceof Error ? e.message : e}`);
          }
        }

        // El cursor de la respuesta marca dónde seguir, incluso si esta página
        // vino vacía. Desde acá en adelante paginamos por cursor.
        if (respuesta.cursor) {
          cursor = respuesta.cursor;
          desde = null;
        }

        // Página incompleta = no queda nada más por ahora.
        if (respuesta.events.length < LIMITE) break;

        if (pagina === MAX_PAGINAS - 1) {
          console.log(
            `⚠ ${MAX_PAGINAS} páginas seguidas: hay atraso, sigo en la próxima vuelta`,
          );
        }
      }
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
