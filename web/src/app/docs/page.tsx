import type { Metadata } from "next";
import Link from "next/link";
import { Marco } from "@/components/Marco";
import { PRINCIPAL, TEST } from "@/lib/config";
import { explorer } from "@/components/ui";

export const metadata: Metadata = {
  title: "Cómo funciona — Zorrito",
  description:
    "Cómo está hecho Zorrito: el pozo, el sorteo por peso, la aleatoriedad con drand verificada on-chain, Blend como fuente de rendimiento, y el stack sobre Stellar.",
};

const BLEND_TESTNET = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const BLEND_MAINNET = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const DRAND_PK =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";

export default function Docs() {
  const principal = PRINCIPAL;
  const test = TEST;

  return (
    <Marco activo="docs" docs ancho="max-w-2xl">
      <article className="docs w-full">
        <h1>
          Cómo funciona
          <br />
          <span>Zorrito</span>
        </h1>
        <p className="tagline">Ahorro premiado sin pérdida de capital, sobre Stellar.</p>

        <div className="aviso">
          💡 <strong>La idea es simple:</strong> ponés plata en un pozo, el pozo la presta en
          Blend y genera interés, y cada ronda ese interés se sortea entre los que están
          adentro. Uno se lleva el rendimiento de todos. Los demás no pierden nada: su capital
          sigue ahí y lo retiran cuando quieren.
        </div>

        <h2 id="como-funciona">Cómo funciona</h2>
        <div className="flex flex-col gap-3">
          <Paso n={1} titulo="Depositás USDC">
            Tu depósito va directo a Blend y empieza a generar al instante. No hay mínimo. Cada
            dólar, y cada segundo que está adentro, suma chances. (El pozo de prueba en testnet
            usa XLM.)
          </Paso>
          <Paso n={2} titulo="El pozo genera">
            El capital de todos se presta en Blend, el mercado de crédito de Stellar. El interés
            que pagan los que piden prestado se acumula como premio.
          </Paso>
          <Paso n={3} titulo="La ronda cierra">
            Al vencer el plazo (una semana; 10 minutos en el pozo de prueba), cualquiera puede
            cerrarla. El premio y las chances de cada uno quedan congelados en ese instante.
          </Paso>
          <Paso n={4} titulo="drand decide">
            El contrato fija de antemano qué número aleatorio de drand va a decidir: uno que
            todavía no existe. Cuando drand lo publica, cualquiera lo trae y el contrato verifica
            la firma antes de elegir.
          </Paso>
          <Paso n={5} titulo="Uno cobra, nadie pierde">
            El premio va entero a la wallet del ganador en la misma transacción. Todos los demás
            siguen con exactamente lo que pusieron, y una ronda nueva ya está corriendo.
          </Paso>
        </div>

        <hr />

        <h2 id="chances">🎯 Cómo se calculan las chances</h2>
        <p>
          Tu peso en el sorteo es <strong>cuánto pusiste por cuánto tiempo</strong> estuvo
          adentro durante la ronda. Es la misma proporción con la que tu plata generó el premio:
          quien más aportó al rendimiento, más chances tiene de llevárselo.
        </p>
        <div className="formula">peso = Σ (depósito × segundos que estuvo en la ronda)</div>
        <div className="formula">P(ganar) = tu peso ÷ peso total del pozo</div>
        <p>
          Ejemplo: dos personas con 100 USDC. Una entra el lunes, la otra el sábado. La primera
          tiene 6 veces más chances, porque su plata generó 6 veces más. Entrar a último momento
          con mucha plata casi no suma, y eso es a propósito: no hay forma de &quot;comprar&quot; el
          sorteo sobre la hora.
        </p>
        <p>
          Retirar no borra lo ya devengado. Si tuviste plata adentro tres días y la sacás, esos
          tres días siguen contando para el sorteo de esa ronda.
        </p>

        <h3 id="racha">🔥 La racha diaria</h3>
        <p>
          Una vez por día (UTC) podés marcar <strong>&quot;Ahorré hoy&quot;</strong>. Cada día
          seguido suma peso a la ronda en curso, y cada día suma más que el anterior:
        </p>
        <div className="formula">bono del día k = depósito × (duración de la ronda) × k / 28</div>
        <p>
          Como 1+2+…+7 = 28, los siete días seguidos suman exactamente una ronda entera de peso:
          quien marca todos los días <strong>duplica</strong> sus chances respecto de alguien con
          la misma plata que no marca ninguno. Saltear un día vuelve al día 1. El bono es de la
          ronda en que se marca; la ronda siguiente arranca de cero, como todo lo demás.
        </p>
        <table className="tabla">
          <thead>
            <tr>
              <th>Días seguidos</th>
              <th>Peso extra acumulado</th>
              <th>Chances vs. no marcar</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>1</td><td>3,6 % de una ronda</td><td>×1,04</td></tr>
            <tr><td>3</td><td>21 %</td><td>×1,21</td></tr>
            <tr><td>5</td><td>54 %</td><td>×1,54</td></tr>
            <tr><td>7 🏆</td><td>100 %</td><td className="bien">×2</td></tr>
          </tbody>
        </table>

        <h3 id="referidos">🤝 Referidos</h3>
        <p>
          Tu link de invitación es tu dirección. Quien entra con él, en su{" "}
          <strong>primer depósito</strong>, te declara como referente, y desde ese momento pesás
          como si tuvieras el <strong>10 % de su capital</strong>, mientras esté adentro. Si
          retira, el bono baja con él.
        </p>
        <div className="formula">peso base = tu capital + min(10 % del capital de tus referidos, 50 % de tu capital)</div>
        <p>
          El tope de la mitad de tu propio capital es lo que hace que no convenga inventarse
          referidos: sin plata propia adentro no hay bono, y con plata propia el bono nunca vale
          más que la mitad de ella. Traer amigos suma; traer cuentas vacías no.
        </p>

        <hr />

        <h2 id="azar">🎲 Cómo funciona el azar</h2>
        <p>
          Elegir un ganador on-chain es difícil: la cadena es determinística y pública, así que
          cualquier valor que se conozca al momento del sorteo puede ser influido por quien arma
          el bloque. Zorrito no usa nada de la cadena como fuente de azar. Usa{" "}
          <a href="https://drand.love" target="_blank" rel="noopener">
            drand
          </a>
          , un beacon de aleatoriedad público operado por unas 20 organizaciones (Cloudflare,
          Protocol Labs, EPFL, Kudelski, entre otras) que publica un número firmado cada 3
          segundos.
        </p>

        <div className="flex flex-col gap-3">
          <div className="paso-item flex-col">
            <strong className="text-verde">🔒 Fase 1 — Cierre: se fija un número que no existe</strong>
            <p>
              Al cerrar la ronda, el contrato calcula qué ronda de drand corresponde a{" "}
              <strong>10 minutos en el futuro</strong> y la guarda. En ese momento nadie, ni
              drand, sabe qué valor va a tener. También congela el premio, el peso total y una
              entropía acumulada de todos los depósitos de la ronda.
            </p>
          </div>
          <div className="paso-item flex-col">
            <strong className="text-naranja">✍️ Fase 2 — Sorteo: la firma se verifica on-chain</strong>
            <p>
              Cuando drand publica esa ronda, cualquiera trae la firma. El contrato verifica con
              BLS12-381, en el propio Soroban, que la firma es válida para esa ronda exacta y
              para la clave pública de drand que tiene guardada. Si no verifica, no sortea. Si
              verifica, la semilla es:
            </p>
            <div className="formula mt-2">
              semilla = sha256(entropía ‖ firma ‖ ronda_drand)
              <br />
              ganador = el que cae en semilla mod peso_total
            </div>
          </div>
        </div>

        <div className="aviso aviso-verde mt-3">
          🛡️ <strong>Por qué nadie puede sesgarlo.</strong> Para elegir al ganador habría que
          conocer la firma de drand antes de que exista, y eso exige corromper a la mayoría de
          las organizaciones que operan la red. Un validador de Stellar no puede: el contrato no
          usa ningún dato del ledger como azar. Nosotros tampoco: no hay ninguna clave nuestra
          en el sorteo. Y cualquiera puede recomputarlo con lo que queda on-chain.
        </div>

        <h3>Comparación de enfoques</h3>
        <table className="tabla">
          <thead>
            <tr>
              <th>Enfoque</th>
              <th>Quién puede influir</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Timestamp o hash del ledger</td>
              <td className="mal">El validador que arma el bloque</td>
              <td className="mal">Descartado</td>
            </tr>
            <tr>
              <td>Commit-reveal con un keeper</td>
              <td className="medio">El keeper, si se calla la revelación</td>
              <td className="medio">Descartado: liveness</td>
            </tr>
            <tr>
              <td>Oráculo VRF</td>
              <td className="medio">El operador del oráculo</td>
              <td className="medio">No hay uno en Stellar</td>
            </tr>
            <tr>
              <td className="bien">drand + verificación BLS on-chain ✓</td>
              <td className="bien">Nadie por debajo de la mayoría de drand</td>
              <td className="bien">Es lo que corre</td>
            </tr>
          </tbody>
        </table>
        <p>
          La verificación BLS12-381 dentro del contrato es posible porque Stellar la agregó como
          función nativa del host en el Protocolo 22. Zorrito la usa para verificar firmas de
          drand quicknet: un <code>pairing_check</code> entre la firma, el hash del mensaje, el
          generador de G2 y la clave pública del grupo.
        </p>

        <hr />

        <h2 id="keeper">🤖 Nadie tiene que estar</h2>
        <p>
          Cerrar la ronda y traer la firma son acciones que <strong>cualquiera</strong> puede
          hacer: no hay roles ni claves privilegiadas. El que las hace solo paga la fee. Hoy las
          dispara un keeper que corre como función serverless, y también cada visita a la app
          que encuentra una ronda vencida o un sorteo pendiente. Si el keeper desaparece, el
          pozo no se traba: el primero que abre la app lo destraba.
        </p>
        <p>
          Y si drand dejara de publicar, lo único que no pasaría es el sorteo. El capital se
          retira igual, en cualquier momento, con o sin sorteo pendiente.
        </p>

        <hr />

        <h2 id="probar">🧪 Probalo sin esperar una semana</h2>
        <p>
          El pozo de la home corre en mainnet con rondas semanales. Para ver el ciclo entero en
          minutos hay un <strong>pozo de prueba en testnet</strong>, con rondas de 10 minutos y
          XLM de prueba:{" "}
          {test ? <Link href="/test">zorritostellar.vercel.app/test</Link> : <em>en deploy</em>}.
          Es el mismo contrato, el mismo Blend (su pool de testnet) y el mismo drand. XLM de
          testnet gratis en{" "}
          <a href="https://laboratory.stellar.org/#account-creator?network=test" target="_blank" rel="noopener">
            el laboratorio de Stellar
          </a>
          .
        </p>

        <hr />

        <h2 id="blend">🌊 Blend: de dónde sale el premio</h2>
        <p>
          <a href="https://blend.capital" target="_blank" rel="noopener">
            Blend
          </a>{" "}
          es el protocolo de préstamos de Stellar. El pozo deposita el capital de todos como{" "}
          <strong>Supply</strong> en un pool de Blend v2 (la reserva de USDC del pool Fixed en mainnet; XLM en TestnetV2 en testnet): una posición que presta y cobra interés
          pero que no se usa como colateral, así que no tiene deuda y no puede ser liquidada.
        </p>
        <ul>
          <li>
            <strong>El interés lo pagan los que piden prestado</strong> en el pool. El APY que
            muestra la app es el que Blend está pagando ahora.
          </li>
          <li>
            <strong>El contrato habla con Blend por su cuenta</strong>, a través de un adapter
            propio. Nadie tiene la llave de esa posición: solo el pozo puede depositar y retirar.
          </li>
          <li>
            <strong>El premio es la diferencia</strong> entre lo que hay en Blend y el capital
            depositado. Si el pool no generó, el premio es 0 y nadie pierde.
          </li>
        </ul>

        <hr />

        <h2 id="escala">📈 Hecho para un millón de cuentas</h2>
        <p>
          Sortear entre muchos participantes con pesos distintos es caro si hay que recorrerlos.
          Zorrito guarda los pesos en un <strong>Fenwick tree</strong> sobre el storage del
          contrato, con capacidad para 2<sup>20</sup> cuentas (algo más de un millón). Depositar,
          retirar y sortear tocan siempre ~20 entradas, sin importar si hay 2 participantes o
          1.000.000.
        </p>
        <p>
          El tiempo se resuelve con álgebra, no con recorridos: el peso de cada cuenta es{" "}
          <code>depósito × T − b</code>, donde <code>b</code> se ajusta en cada movimiento. Así
          el peso de todos avanza con el reloj sin que nadie tenga que actualizarlo.
        </p>

        <hr />

        <h2 id="stack">🛠 Stack técnico</h2>
        <table className="tabla">
          <tbody>
            <tr>
              <td>
                <strong>Contratos</strong>
              </td>
              <td>
                Rust + Soroban (<code>soroban-sdk</code> 27). Tres contratos: el pozo, el adapter
                de Blend y un mock de rendimiento para tests. 58 tests, incluida la verificación
                BLS con claves propias, la racha, los referidos y el pozo operando contra el
                bytecode real de Blend.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Azar</strong>
              </td>
              <td>
                drand quicknet (bls-unchained-g1-rfc9380), verificado on-chain con las funciones
                BLS12-381 del host de Stellar. Descompresión de puntos en el cliente con{" "}
                <code>@noble/curves</code>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Rendimiento</strong>
              </td>
              <td>
                Blend v2: la reserva de USDC del pool Fixed en mainnet, la de XLM de TestnetV2
                en testnet. Integrado con <code>contractimport!</code> de los WASM oficiales.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Web</strong>
              </td>
              <td>
                Next.js 16, Tailwind 4, <code>@stellar/stellar-sdk</code> 17, Stellar Wallets Kit
                (Freighter, xBull, Lobstr). Desplegada en Vercel.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Keeper</strong>
              </td>
              <td>
                Función serverless en Vercel (<code>/api/keeper</code>), disparada por cron y por
                cada visita. Permissionless: cualquiera puede correr otro.
              </td>
            </tr>
          </tbody>
        </table>

        <hr />

        <h2 id="contratos">📋 Contratos</h2>
        {principal && principal.red === "mainnet" && (
          <Direccion etiqueta="Pozo Zorrito · mainnet · semanal" id={principal.id} red="mainnet" />
        )}
        <Direccion etiqueta="Pool de Blend v2 · mainnet (Fixed)" id={BLEND_MAINNET} red="mainnet" />
        {test && <Direccion etiqueta="Pozo de prueba · testnet · 10 min" id={test.id} red="testnet" />}
        <Direccion etiqueta="Pool de Blend v2 · testnet (TestnetV2)" id={BLEND_TESTNET} red="testnet" />
        <div className="addr-box">
          <span className="addr-label">drand quicknet · clave pública del grupo (G2)</span>
          {DRAND_PK.slice(0, 32)}…{DRAND_PK.slice(-32)}
          <br />
          <a href="https://api.drand.sh/v2/beacons/quicknet/info" target="_blank" rel="noopener">
            Ver en drand ↗
          </a>
        </div>
        <p className="text-sm">
          Código abierto:{" "}
          <a href="https://github.com/artugrande/zorrito" target="_blank" rel="noopener">
            github.com/artugrande/zorrito
          </a>
          . Los tests, los scripts de deploy y este mismo sitio están ahí.
        </p>

        <hr />

        <h2 id="riesgos">🛡️ Seguridad y riesgos, sin maquillaje</h2>

        <Riesgo nivel="bajo" titulo="Nadie puede elegir al ganador">
          El azar viene de drand y se verifica en el contrato. No hay clave de admin en el pozo:
          ningún rol puede pausar, cambiar el sorteo ni tocar fondos. El adapter tiene un admin
          que solo sirve para fijar, una única vez, quién es el pozo.
        </Riesgo>
        <Riesgo nivel="bajo" titulo="El capital no depende de nadie">
          Retirar no necesita permiso, no tiene penalidad y funciona aunque haya un sorteo
          pendiente, aunque el keeper esté caído y aunque drand deje de publicar.
        </Riesgo>
        <Riesgo nivel="medio" titulo="Riesgo de Blend: liquidez">
          El capital está prestado. Si el pool de Blend tiene casi toda su liquidez tomada, un
          retiro puede fallar hasta que alguien devuelva o deposite. Es el riesgo real de
          &quot;nadie pierde&quot;: no se pierde capital, pero puede haber que esperar. Blend lo
          mitiga con tasas que suben con la utilización.
        </Riesgo>
        <Riesgo nivel="medio" titulo="Riesgo de Blend: protocolo">
          Un bug en Blend afecta al pozo como a cualquier prestamista. Blend v2 está auditado y
          es el protocolo de crédito con más uso en Stellar, pero el riesgo no es cero.
        </Riesgo>
        <Riesgo nivel="bajo" titulo="Liveness de drand">
          Si drand no publica, no hay sorteo hasta que vuelva. El capital se retira igual. drand
          lleva años publicando cada 3 segundos con más de 20 operadores.
        </Riesgo>
        <Riesgo nivel="bajo" titulo="Renta de storage en Stellar">
          Las entradas persistentes vencen si nadie las extiende. El contrato extiende las suyas
          en cada uso; para cuentas inactivas durante meses hace falta que alguien las extienda
          (cualquiera puede). Pendiente de automatizar en el keeper.
        </Riesgo>
        <Riesgo nivel="medio" titulo="Contrato nuevo, sin auditoría">
          Construido desde cero durante el hackathon. El pozo de mainnet tiene un{" "}
          <strong>tope de capital</strong> fijo en el contrato justamente por esto: limita cuánto
          puede haber adentro hasta que una auditoría diga que se puede subir. No pongas plata
          que no puedas perder.
        </Riesgo>

        <hr />

        <h2 id="faq">❓ Preguntas</h2>
        <Faq q="¿Puedo perder plata?">
          No. El sorteo reparte solo el interés que generó el pozo. Tu depósito es tuyo y lo
          retirás cuando quieras. Lo único que puede pasar es tener que esperar si Blend está sin
          liquidez en ese momento.
        </Faq>
        <Faq q="¿Qué gano si no salgo sorteado?">
          Nada, y no perdés nada. Es la misma plata que tenías, pero con una chance de premio
          cada ronda en vez de un interés chico. Si preferís el interés seguro, Blend está ahí
          directo.
        </Faq>
        <Faq q="¿Por qué no ganó el que más plata tiene?">
          Porque el peso es plata por tiempo, no solo plata. Alguien con menos plata que entró
          antes puede pesar más. Y aun con más peso, es un sorteo: más chances no es certeza.
        </Faq>
        <Faq q="¿Puedo verificar un sorteo?">
          Sí. Cada sorteo emite un evento con la ronda de drand, la firma y el peso total. Con
          eso y los depósitos de la ronda, cualquiera recomputa la semilla y el ganador.
        </Faq>
        <Faq q="¿Qué pasa si nadie cierra la ronda a tiempo?">
          Nada malo. Se cierra cuando alguien la cierra, y hasta entonces el pozo sigue
          generando. El keeper y cada visita a la app la cierran solas.
        </Faq>
        <Faq q="¿Por qué USDC en mainnet y XLM en testnet?">
          Porque el premio sale de lo que la gente pide prestado, y en Stellar la gente pide
          prestado USDC: la reserva de USDC del pool Fixed está al 80 % de uso y paga ~8 %
          anual al que presta; la de XLM está al 0,1 % y paga 0 %. En testnet no hay USDC fácil
          de conseguir y XLM no necesita trustline, así que el pozo de prueba usa XLM. El
          contrato es el mismo con cualquier token que Blend acepte.
        </Faq>
        <Faq q="¿Va a haber un pozo de USDT0?">
          Hoy podés entrar con USDT0 y se cambia a USDC en la puerta. Un pozo que guarde USDT0
          directamente necesita que Blend lo preste, porque el premio sale de ahí. USDT0 llegó a
          Stellar en septiembre de 2026 y todavía no tiene reserva en ningún pool de Blend. El
          día que la tenga, es una entrada más en la configuración: el contrato no sabe qué
          token es.
        </Faq>
        <Faq q="¿Necesito algo en la wallet para entrar?">
          USDC y un poco de XLM para las fees. Si tu wallet todavía no acepta USDC, la app te
          ofrece agregarlo con un toque: es la trustline de Stellar, una sola vez.
        </Faq>
        <Faq q="¿Puedo entrar con XLM o con USDT0?">
          Sí, con las dos. Elegís la moneda al lado del monto, la app te dice cuánto USDC es hoy
          en Soroswap, y firmás dos veces: el cambio y el depósito. El cambio pasa por tu wallet,
          no por el pozo: el pozo recibe USDC como siempre y tu capital queda en dólares desde
          el primer segundo. Se acepta hasta 0,5 % menos que la cotización si el precio se mueve
          entre que mirás y firmás. Con USDT0 la app cotiza el par directo y el camino por XLM,
          y usa el que más da. Los retiros son siempre en USDC.
        </Faq>
        <Faq q="¿Puedo tener referidos sin poner plata?">
          Podés, pero no te suman: el bono de referidos vale como mucho la mitad de tu propio
          capital, y sin capital vale cero.
        </Faq>

        <p className="mt-8 text-center text-sm">
          <Link href="/">← Volver a la app</Link>
        </p>
      </article>
    </Marco>
  );
}

function Paso({ n, titulo, children }: { n: number; titulo: string; children: React.ReactNode }) {
  return (
    <div className="paso-item">
      <div className="paso-num">{n}</div>
      <div>
        <strong>{titulo}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

function Riesgo({
  nivel,
  titulo,
  children,
}: {
  nivel: "bajo" | "medio" | "info";
  titulo: string;
  children: React.ReactNode;
}) {
  const texto = { bajo: "BAJO", medio: "MEDIO", info: "INFO" }[nivel];
  return (
    <div className="riesgo">
      <span className={`tag tag-${nivel}`}>{texto}</span>
      <div>
        <strong>{titulo}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="riesgo flex-col gap-1">
      <strong>{q}</strong>
      <p>{children}</p>
    </div>
  );
}

function Direccion({ etiqueta, id, red }: { etiqueta: string; id: string; red: string }) {
  return (
    <div className="addr-box">
      <span className="addr-label">{etiqueta}</span>
      {id}
      <br />
      <a href={explorer(red, "contract", id)} target="_blank" rel="noopener">
        Ver en stellar.expert ↗
      </a>
    </div>
  );
}
