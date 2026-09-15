# Zorrito — ahorro premiado sin pérdida de capital

**Track:** Genesis · **Categoría:** Herramientas financieras locales
**Una línea:** Ponés plata en un pozo, el pozo genera en Blend, y cada semana
uno de los participantes se lleva el rendimiento de todos. El capital de cada
uno queda intacto y se retira cuando se quiera.

**App:** https://zorritostellar.vercel.app · **Docs:** https://zorritostellar.vercel.app/docs
**Repo:** https://github.com/artugrande/zorrito

> Este repo arrancó como una ronda rotativa (la vaquita). Ese producto quedó
> documentado en [RONDA.md](RONDA.md) y su contrato sigue en
> `contracts/ronda`, pero el producto es el pozo. Este documento describe el
> pozo.

---

## El problema

Ahorrar es aburrido y el interés es chico. Para alguien con 50 dólares, un
4% anual son 2 dólares al año: no cambia nada y no motiva. El resultado es que
la mayoría no ahorra, o ahorra en el colchón, y la plata que sí llega a DeFi
va a rendimientos que ese usuario no siente.

La lotería tiene el problema inverso: motiva muchísimo y destruye capital.

## La idea

Juntar las dos cosas y sacarles lo malo. El **pozo sin pérdida** (prize-linked
savings) existe desde hace décadas en el mundo bancario (Premium Bonds en el
Reino Unido desde 1956, más de 22 millones de participantes) y en DeFi
(PoolTogether en Ethereum). El capital de todos genera rendimiento; el
rendimiento se sortea; nadie pierde lo que puso.

Lo que no existía era una versión sobre Stellar. En los 812 proyectos del
ecosistema relevados en [GAPS.md](GAPS.md) y [EVM-GAPS.md](EVM-GAPS.md),
cero hacen esto. Y Stellar tiene las tres piezas que hacen falta:

1. **Rendimiento real y componible**: Blend, el mercado de crédito, con
   posiciones de Supply que no tienen deuda y no pueden liquidarse.
2. **Azar verificable on-chain**: desde el Protocolo 22 el host tiene
   funciones BLS12-381, lo que permite verificar dentro del contrato la
   firma de [drand](https://drand.love), un beacon público de aleatoriedad.
3. **Transacciones baratas**: cerrar y sortear cuestan fracciones de centavo,
   así que cualquiera puede hacerlo y el sistema no depende de nadie.

## Cómo funciona

1. **Depositás.** La plata va al contrato y de ahí a Blend como Supply, en la
   misma transacción. Empieza a generar interés al instante.
2. **La ronda corre.** Una semana (10 minutos en el pozo demo). Cada segundo
   que tu plata está adentro suma peso: `depósito × tiempo`.
3. **Cierra.** Al vencer, cualquiera cierra la ronda. El premio (todo lo que
   generó el pozo) y el peso de cada uno se congelan. El contrato fija qué
   ronda futura de drand va a decidir: una que todavía no existe.
4. **drand publica.** Cuando sale, cualquiera trae la firma. El contrato la
   verifica on-chain y elige al ganador con probabilidad proporcional al peso.
5. **Uno cobra.** El premio va entero a la wallet del ganador. Los demás
   siguen con exactamente lo que pusieron. La ronda siguiente ya arrancó.

Retirar funciona siempre: sin penalidad, sin esperar el sorteo, sin permiso.

## Qué lo hace distinto

- **Sin roles.** No hay admin, no hay pausa, no hay clave que pueda tocar
  fondos ni influir en el sorteo. Las dos acciones de mantenimiento son
  permissionless.
- **Azar que ni nosotros ni la red podemos sesgar.** No se usa nada del
  ledger como fuente de aleatoriedad. Sesgar el sorteo exige corromper a la
  mayoría de las ~20 organizaciones que operan drand.
- **Sin dependencia de un keeper.** Un keeper cerrado o desaparecido no traba
  nada: la app misma dispara el cierre y el sorteo cuando alguien la abre.
- **Escala desde el día cero.** Fenwick tree sobre storage con capacidad para
  un millón de cuentas. Depositar, retirar y sortear tocan ~20 entradas, con
  2 participantes o con 1.000.000.
- **Justo por construcción.** El peso es plata por tiempo: la misma
  proporción con la que cada uno generó el premio. Entrar a último momento
  con mucha plata casi no suma.

## Alcance del hackathon

### Hecho

- Contrato `pozo` (Rust/Soroban): depósitos, retiro libre, cierre, sorteo con
  verificación BLS de drand, Fenwick tree, 37 tests.
- Adapter de Blend v2 (`blend_adapter`): Supply no colateral, testeado
  contra el bytecode real de Blend. 8 tests más el pozo operando a través de
  él.
- Testnet: pozo demo (rondas de 10 min) generando en el pool TestnetV2 de
  Blend, con más de 20 sorteos consecutivos con firmas reales de drand.
- Keeper serverless en Vercel, disparado por cron y por cada visita.
- App móvil-first: premio, countdown, APY de Blend, tu posición, depositar y
  retirar, últimos ganadores, docs.

- Racha diaria y referidos, en el contrato y en la app, en la misma unidad
  que el peso: la semana completa de "ahorré hoy" duplica las chances; cada
  referido suma el 10 % de su capital, con tope de la mitad del propio.

- Mainnet: pozo semanal de USDC con tope de 5.000 generando en la reserva de
  USDC del pool Fixed de Blend v2 (~8 % anual; XLM ahí paga 0 %). Pozo de
  prueba en testnet (`/test`) en XLM con rondas de 10 minutos.

- Entrar pagando con XLM o con USDT0: la app cotiza a la vez en Soroswap y
  en el DEX clásico de Stellar (path payment, lo que usan Freighter y
  Lobstr), cambia por el que más da en la wallet del usuario y deposita lo
  que salió. Dos firmas. El pozo no lo ve: recibe USDC como siempre, y la
  garantía de no perder capital no cambia. USDT0 es el USDT de Tether en
  Stellar desde septiembre de 2026; hoy solo el DEX lo cambia (10 USDT0 →
  9,9955 USDC), y Soroswap entra a la comparación cuando tenga el par.

- Probado en mainnet con Freighter, con plata real: cambio de XLM a USDC
  por Soroswap, depósito en Blend y retiro completo, todo desde la app.

### Pendiente antes de la submission

- Video de demo.
- Capital inicial en el pozo para que el primer sorteo tenga un premio
  visible.

### Fuera de alcance

- Auditoría. Hasta entonces, el pozo de mainnet tiene un tope de capital fijo
  en el contrato.
- Extender la renta de storage de cuentas inactivas desde el keeper.

## Riesgos, dichos

| Riesgo | Nivel | Qué pasa y qué lo mitiga |
|---|---|---|
| Liquidez de Blend | medio | El capital está prestado. Con el pool casi todo tomado, un retiro puede fallar hasta que baje la utilización. No se pierde capital; puede haber que esperar. Las tasas de Blend suben con la utilización para que eso dure poco. |
| Protocolo Blend | medio | Un bug en Blend afecta al pozo como a cualquier prestamista. Blend v2 está auditado; el riesgo no es cero. |
| drand se detiene | bajo | No hay sorteo hasta que vuelva. El capital se retira igual. |
| Keeper caído | bajo | Cualquiera cierra y sortea; la app lo hace sola en cada visita. |
| Renta de storage | bajo | Las cuentas inactivas meses vencen si nadie las extiende. Cualquiera puede; falta automatizarlo. |
| Sin auditoría | medio | Construido desde cero en el hackathon. Por eso el tope de capital en mainnet. |

## Qué contesta cada criterio del jurado

- **Innovación**: el primer pozo sin pérdida en Stellar, con azar verificable
  on-chain vía drand + BLS12-381, sin roles ni keeper de confianza.
- **Uso de Stellar**: Soroban, host functions BLS del Protocolo 22, Blend
  como fuente de rendimiento, SAC nativo, Stellar Wallets Kit.
- **Funciona**: en mainnet, con Blend y drand de verdad, y decenas de rondas
  sorteadas en testnet. Todo verificable en stellar.expert.
- **Impacto**: convierte el ahorro en algo que motiva, sin que nadie pueda
  perder. Diseñado para un millón de usuarios desde el primer commit.
