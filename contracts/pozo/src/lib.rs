#![no_std]

//! Pozo — ahorro premiado sin pérdida de capital.
//!
//! Todos depositan en un pozo común. El pozo entero se pone a generar
//! rendimiento. Al cierre de cada ronda se sortea **todo el rendimiento
//! generado** entre los participantes: uno se lo lleva entero y **nadie pierde
//! capital**. El que no gana sigue con exactamente lo que puso, y vuelve a
//! participar en la ronda siguiente.
//!
//! Convierte el gasto en lotería —conducta ya masiva en Latam— en ahorro.
//!
//! ## De dónde sale el azar
//!
//! De **drand**, un beacon público de aleatoriedad producido por ~20
//! organizaciones independientes (League of Entropy) con una firma BLS umbral.
//! Cada 3 segundos publica la firma de una ronda numerada; nadie conoce la
//! firma de una ronda futura hasta que sale, y cualquiera la verifica con la
//! clave pública del grupo. Ver `drand.rs`.
//!
//! El protocolo tiene dos pasos y **ninguno necesita permiso**:
//!
//! 1. `cerrar_ronda`: cuando vence el período, cualquiera cierra. Se congelan
//!    las chances y el premio, y se fija una ronda de drand que cae **en el
//!    futuro** (≥ 10 minutos). Nadie —ni quien cierra, ni un validador— puede
//!    conocer todavía la firma de esa ronda.
//! 2. `ejecutar_sorteo`: cuando drand la publica, cualquiera la trae. El
//!    contrato la verifica on-chain con las host functions BLS12-381 que Stellar
//!    agregó en el Protocolo 22, deriva el ganador de esa firma, y paga.
//!
//! ## Qué queda protegido y contra quién
//!
//! - **Validadores de Stellar**: no controlan drand. No participan de la
//!   semilla en ningún punto. Es el problema que el diseño anterior, basado en
//!   el PRNG de red, no podía resolver.
//! - **Quien cierra la ronda**: elige el momento, pero la ronda de drand queda
//!   a ≥ 10 minutos, y un validador solo puede correr el reloj del ledger unos
//!   segundos. No hay ronda pasada que pueda elegir.
//! - **Quien ejecuta**: no elige nada. La firma es la que es, o no verifica.
//! - **Un operador que desaparece**: no existe el rol. Cualquiera puede cerrar
//!   y ejecutar, así que el premio nunca queda rehén de una persona.
//! - **drand mismo**: haría falta que una mayoría de las ~20 organizaciones se
//!   coludan para sesgar una ronda. Es el supuesto de confianza que queda, y es
//!   público y verificable, no un servidor de nadie.
//!
//! El capital nunca depende de nada de esto: `retirar` funciona siempre.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec,
};

mod drand;

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/// Cuánto en el futuro cae la ronda de drand que se fija al cerrar.
///
/// Es la distancia que garantiza que nadie conozca la firma todavía. Un
/// validador puede correr el timestamp del ledger unos segundos; diez minutos
/// están fuera de su alcance por órdenes de magnitud.
pub const MARGEN_SEGUNDOS: u64 = 600;

/// Tope de participantes. Todos viven en una sola entrada de storage que se lee
/// entera en el sorteo; más que esto habría que partirla o volver a un Fenwick.
pub const MAX_PARTICIPANTES: u32 = 200;

const BUMP_UMBRAL: u32 = 500_000;
const BUMP_EXTENSION: u32 = 518_400; // ~30 días

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    SinInicializar = 1,
    MontoInvalido = 2,
    SaldoInsuficiente = 3,
    PozoLleno = 4,
    NoParticipa = 5,
    /// La ronda todavía no venció.
    RondaEnCurso = 6,
    /// No hay ninguna ronda cerrada esperando sorteo.
    SinCierre = 7,
    /// Ya hay una ronda cerrada esperando su firma de drand.
    RondaYaCerrada = 8,
    /// La firma no es la de drand para la ronda fijada al cerrar.
    FirmaInvalida = 9,
    /// No hay peso: nadie participó de la ronda.
    SinParticipantes = 10,
    PeriodoInvalido = 11,
    DrandInvalido = 12,
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Participante {
    pub addr: Address,
    /// Capital actual. Nunca se toca al sortear.
    pub deposito: i128,
    /// Peso ya devengado en esta ronda: depósito × segundos, hasta `desde`.
    pub peso_devengado: i128,
    /// Cuándo cambió por última vez el depósito.
    pub desde: u64,
}

/// Un participante con su peso congelado al cerrar la ronda.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Boleto {
    pub addr: Address,
    pub peso: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Config {
    pub token: Address,
    /// Contrato que genera el rendimiento (Blend en producción, mock en tests).
    pub fuente: Address,
    /// Duración de una ronda, en segundos.
    pub periodo: u64,
    /// Clave pública del grupo de drand, G2 sin comprimir.
    pub drand_pk: BytesN<192>,
    /// Unix time de la ronda 1 de drand.
    pub drand_genesis: u64,
    /// Segundos entre rondas de drand.
    pub drand_periodo: u64,
}

/// Una ronda cerrada esperando su firma. Todo lo que define el sorteo queda
/// congelado acá: depositar o retirar después ya no lo cambia.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Sorteo {
    /// La ronda de drand cuya firma decide. Estaba en el futuro al cerrar.
    pub ronda_drand: u64,
    pub boletos: Vec<Boleto>,
    pub peso_total: i128,
    /// Entropía acumulada de los depósitos hasta el cierre.
    pub entropia: BytesN<32>,
    /// Rendimiento generado hasta el cierre. Es lo que se paga.
    pub premio: i128,
}

/// Lo que necesita la pantalla, en una sola llamada.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Vista {
    pub participantes: u32,
    /// Capital total depositado. Es lo que nadie puede perder.
    pub principal: i128,
    /// Rendimiento en juego: el generado hasta ahora, o el congelado si la
    /// ronda ya cerró y espera su sorteo.
    pub premio: i128,
    pub ronda: u32,
    pub cierra_at: u64,
    pub periodo: u64,
    /// Rendimiento anual en puntos básicos, derivado de lo que reporta la
    /// fuente. `None` mientras no haya con qué calcularlo.
    pub apy_bps: Option<i128>,
    /// `true` entre el cierre y el sorteo.
    pub sorteo_pendiente: bool,
    /// Qué ronda de drand hay que traer para sortear, si hay una pendiente.
    pub ronda_drand: Option<u64>,
}

#[contracttype]
pub enum Clave {
    Config,
    Participantes,
    Ronda,
    CierraAt,
    Entropia,
    Sorteo,
    /// Capital total. Es la línea que separa el premio del capital.
    Principal,
    /// Cuándo arrancó la ronda actual, para calcular el APY.
    RondaDesde,
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposito {
    #[topic]
    pub usuario: Address,
    pub monto: i128,
    pub principal: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Retiro {
    #[topic]
    pub usuario: Address,
    pub monto: i128,
    pub principal: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RondaCerrada {
    #[topic]
    pub ronda: u32,
    /// La ronda de drand que hay que traer. El keeper la lee de acá.
    pub ronda_drand: u64,
    pub peso_total: i128,
    pub premio: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SorteoEjecutado {
    #[topic]
    pub ronda: u32,
    #[topic]
    pub ganador: Address,
    pub premio: i128,
    /// Para que cualquiera pueda recomputar el sorteo y verificarlo.
    pub ronda_drand: u64,
    pub firma: BytesN<96>,
    pub peso_total: i128,
}

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// Constructor: corre en la misma transacción que el deploy, así que nadie
    /// puede adelantarse a inicializar con otra configuración.
    ///
    /// No hay admin ni keeper. Después de esto el contrato no tiene llaves.
    pub fn __constructor(
        env: Env,
        token: Address,
        fuente: Address,
        periodo: u64,
        drand_pk: BytesN<192>,
        drand_genesis: u64,
        drand_periodo: u64,
    ) {
        if periodo == 0 {
            panic_with_error!(&env, Error::PeriodoInvalido);
        }
        if drand_periodo == 0 {
            panic_with_error!(&env, Error::DrandInvalido);
        }

        let ahora = env.ledger().timestamp();
        let inst = env.storage().instance();
        inst.set(
            &Clave::Config,
            &Config {
                token,
                fuente,
                periodo,
                drand_pk,
                drand_genesis,
                drand_periodo,
            },
        );
        inst.set(&Clave::Participantes, &Vec::<Participante>::new(&env));
        inst.set(&Clave::Ronda, &0u32);
        inst.set(&Clave::CierraAt, &(ahora + periodo));
        inst.set(&Clave::RondaDesde, &ahora);
        inst.set(&Clave::Principal, &0i128);
        inst.set(&Clave::Entropia, &BytesN::from_array(&env, &[0u8; 32]));
        inst.extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);
    }

    /// Deposita capital y entra al sorteo. El capital se puede retirar entero
    /// cuando se quiera: lo que se sortea es el rendimiento, nunca el capital.
    pub fn depositar(env: Env, usuario: Address, monto: i128) {
        usuario.require_auth();
        if monto <= 0 {
            panic_with_error!(&env, Error::MontoInvalido);
        }
        let cfg = config(&env);
        let ahora = env.ledger().timestamp();

        // El capital entra al contrato y de ahí va derecho a generar.
        token::Client::new(&env, &cfg.token).transfer(
            &usuario,
            env.current_contract_address(),
            &monto,
        );
        invocar_fuente(&env, &cfg, "depositar", monto);

        let mut ps = participantes(&env);
        match indice_de(&ps, &usuario) {
            Some(i) => {
                let mut p = ps.get_unchecked(i);
                devengar(&mut p, ahora);
                p.deposito += monto;
                ps.set(i, p);
            }
            None => {
                if ps.len() >= MAX_PARTICIPANTES {
                    panic_with_error!(&env, Error::PozoLleno);
                }
                ps.push_back(Participante {
                    addr: usuario.clone(),
                    deposito: monto,
                    peso_devengado: 0,
                    desde: ahora,
                });
            }
        }
        guardar_participantes(&env, &ps);

        let principal = principal(&env) + monto;
        env.storage().instance().set(&Clave::Principal, &principal);

        mezclar_entropia(&env, &usuario, monto);

        Deposito {
            usuario,
            monto,
            principal,
        }
        .publish(&env);
    }

    /// Retira capital. Sin penalidad y en cualquier momento: el producto se
    /// apoya en que nadie pierde nada, y una salida trabada rompería eso.
    ///
    /// No depende de que haya o no un sorteo pendiente.
    pub fn retirar(env: Env, usuario: Address, monto: i128) {
        usuario.require_auth();
        if monto <= 0 {
            panic_with_error!(&env, Error::MontoInvalido);
        }
        let cfg = config(&env);
        let ahora = env.ledger().timestamp();

        let mut ps = participantes(&env);
        let i = match indice_de(&ps, &usuario) {
            Some(i) => i,
            None => panic_with_error!(&env, Error::NoParticipa),
        };
        let mut p = ps.get_unchecked(i);
        if monto > p.deposito {
            panic_with_error!(&env, Error::SaldoInsuficiente);
        }

        devengar(&mut p, ahora);
        p.deposito -= monto;
        ps.set(i, p);
        guardar_participantes(&env, &ps);

        let principal = principal(&env) - monto;
        env.storage().instance().set(&Clave::Principal, &principal);

        // Sacar de la fuente y devolver. El peso ya devengado se conserva: la
        // plata estuvo generando rendimiento mientras estuvo adentro.
        invocar_fuente(&env, &cfg, "retirar", monto);
        token::Client::new(&env, &cfg.token).transfer(
            &env.current_contract_address(),
            &usuario,
            &monto,
        );

        Retiro {
            usuario,
            monto,
            principal,
        }
        .publish(&env);
    }

    /// Cierra la ronda vencida y congela el sorteo. Cualquiera puede llamarla.
    ///
    /// Fija la ronda de drand que va a decidir, ≥ `MARGEN_SEGUNDOS` en el
    /// futuro: al cerrar, esa firma todavía no existe para nadie. Congela los
    /// pesos, el premio y la entropía. Depositar o retirar después no toca
    /// nada de esto.
    pub fn cerrar_ronda(env: Env) -> u64 {
        let cfg = config(&env);
        if env.storage().instance().has(&Clave::Sorteo) {
            panic_with_error!(&env, Error::RondaYaCerrada);
        }
        let ahora = env.ledger().timestamp();
        if ahora < cierra_at(&env) {
            panic_with_error!(&env, Error::RondaEnCurso);
        }

        let ps = participantes(&env);
        let mut boletos = Vec::new(&env);
        let mut peso_total = 0i128;
        for i in 0..ps.len() {
            let p = ps.get_unchecked(i);
            let w = peso(&p, ahora);
            if w > 0 {
                boletos.push_back(Boleto {
                    addr: p.addr,
                    peso: w,
                });
                peso_total += w;
            }
        }
        if peso_total <= 0 {
            panic_with_error!(&env, Error::SinParticipantes);
        }

        let ronda_drand = drand::ronda_en(
            cfg.drand_genesis,
            cfg.drand_periodo,
            ahora + MARGEN_SEGUNDOS,
        );
        let premio = premio_disponible(&env, &cfg);

        env.storage().instance().set(
            &Clave::Sorteo,
            &Sorteo {
                ronda_drand,
                boletos,
                peso_total,
                entropia: entropia(&env),
                premio,
            },
        );
        env.storage()
            .instance()
            .extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);

        RondaCerrada {
            ronda: ronda(&env),
            ronda_drand,
            peso_total,
            premio,
        }
        .publish(&env);

        ronda_drand
    }

    /// Trae la firma de drand de la ronda fijada al cerrar, verifica, elige
    /// ganador y le paga el rendimiento. Cualquiera puede llamarla.
    ///
    /// El capital de todos queda intacto y arranca una ronda nueva.
    pub fn ejecutar_sorteo(env: Env, firma: BytesN<96>) -> Address {
        let cfg = config(&env);
        let s: Sorteo = match env.storage().instance().get(&Clave::Sorteo) {
            Some(s) => s,
            None => panic_with_error!(&env, Error::SinCierre),
        };

        if !drand::verificar(&env, &cfg.drand_pk, s.ronda_drand, &firma) {
            panic_with_error!(&env, Error::FirmaInvalida);
        }

        let ganador = elegir(&env, &s, &firma);

        // Se paga lo congelado al cerrar, pero nunca más que lo que la fuente
        // tiene por encima del capital *ahora*. Si la fuente perdió plata entre
        // el cierre y el sorteo, el premio se achica; el capital no se toca.
        let disponible = premio_disponible(&env, &cfg);
        let premio = if s.premio < disponible {
            s.premio
        } else {
            disponible
        };

        if premio > 0 {
            invocar_fuente(&env, &cfg, "retirar", premio);
            token::Client::new(&env, &cfg.token).transfer(
                &env.current_contract_address(),
                &ganador,
                &premio,
            );
        }

        let ronda_cerrada = ronda(&env);
        SorteoEjecutado {
            ronda: ronda_cerrada,
            ganador: ganador.clone(),
            premio,
            ronda_drand: s.ronda_drand,
            firma,
            peso_total: s.peso_total,
        }
        .publish(&env);

        // Ronda nueva: el peso vuelve a cero, el capital sigue donde estaba.
        let ahora = env.ledger().timestamp();
        let mut ps = participantes(&env);
        for i in 0..ps.len() {
            let mut p = ps.get_unchecked(i);
            p.peso_devengado = 0;
            p.desde = ahora;
            ps.set(i, p);
        }
        guardar_participantes(&env, &ps);

        let inst = env.storage().instance();
        inst.remove(&Clave::Sorteo);
        inst.set(&Clave::Ronda, &(ronda_cerrada + 1));
        inst.set(&Clave::CierraAt, &(ahora + cfg.periodo));
        inst.set(&Clave::RondaDesde, &ahora);
        inst.extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);

        ganador
    }

    // -- Lecturas -----------------------------------------------------------

    /// Todo lo que muestra la pantalla, en una llamada.
    pub fn estado(env: Env) -> Vista {
        let cfg = config(&env);
        let ps = participantes(&env);
        let principal = principal(&env);
        let pendiente: Option<Sorteo> = env.storage().instance().get(&Clave::Sorteo);

        let premio = match &pendiente {
            Some(s) => s.premio,
            None => premio_disponible(&env, &cfg),
        };

        Vista {
            participantes: ps.len(),
            principal,
            premio,
            ronda: ronda(&env),
            cierra_at: cierra_at(&env),
            periodo: cfg.periodo,
            apy_bps: apy_bps(&env, principal, premio),
            sorteo_pendiente: pendiente.is_some(),
            ronda_drand: pendiente.map(|s| s.ronda_drand),
        }
    }

    /// Capital de una cuenta. Lo que puede retirar, siempre.
    pub fn saldo(env: Env, usuario: Address) -> i128 {
        let ps = participantes(&env);
        match indice_de(&ps, &usuario) {
            Some(i) => ps.get_unchecked(i).deposito,
            None => 0,
        }
    }

    /// Chances de una cuenta sobre el total, en puntos básicos.
    ///
    /// Es lo que muestra la UI como "tu probabilidad". El peso es
    /// depósito × tiempo: depositar justo antes del cierre casi no suma.
    ///
    /// Trunca hacia abajo, así que las chances de todos suman hasta
    /// `participantes - 1` puntos menos de 10.000. Nunca más: nadie ve una
    /// probabilidad mayor a la que tiene.
    pub fn chances_bps(env: Env, usuario: Address) -> i128 {
        let ps = participantes(&env);
        let ahora = env.ledger().timestamp();
        let total = peso_total(&ps, ahora);
        if total == 0 {
            return 0;
        }
        match indice_de(&ps, &usuario) {
            Some(i) => peso(&ps.get_unchecked(i), ahora) * 10_000 / total,
            None => 0,
        }
    }

    pub fn participantes(env: Env) -> Vec<Participante> {
        participantes(&env)
    }

    pub fn config(env: Env) -> Config {
        config(&env)
    }
}

// ---------------------------------------------------------------------------
// Selección del ganador
// ---------------------------------------------------------------------------

/// Elige ganador con probabilidad proporcional al peso congelado.
///
/// La semilla es `sha256(entropía ‖ firma ‖ ronda_drand)`. Es determinística
/// dado lo que queda on-chain, así que cualquiera puede recomputar el sorteo
/// desde el evento `SorteoEjecutado` y comprobar que el ganador es el que
/// tenía que ser.
fn elegir(env: &Env, s: &Sorteo, firma: &BytesN<96>) -> Address {
    let mut material = Bytes::new(env);
    material.append(&Bytes::from_array(env, &s.entropia.to_array()));
    material.append(&Bytes::from_array(env, &firma.to_array()));
    material.append(&Bytes::from_array(env, &s.ronda_drand.to_be_bytes()));
    let semilla = env.crypto().sha256(&material).to_array();

    // 128 bits de la semilla, para no sesgar cuando el peso total pasa de
    // 2^64 — con depósitos grandes por muchos segundos se llega rápido.
    let mut n: u128 = 0;
    for b in &semilla[..16] {
        n = (n << 8) | (*b as u128);
    }
    let sorteado = (n % (s.peso_total as u128)) as i128;

    let mut acumulado = 0i128;
    for i in 0..s.boletos.len() {
        let b = s.boletos.get_unchecked(i);
        acumulado += b.peso;
        if sorteado < acumulado {
            return b.addr;
        }
    }
    // Solo se llega acá por redondeo con el último; que gane el último es lo
    // correcto, no un fallback arbitrario.
    s.boletos.get_unchecked(s.boletos.len() - 1).addr
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Peso = depósito × segundos adentro. Depositar justo antes del cierre pesa
/// casi nada, que es lo que evita entrar al final a competir por el
/// rendimiento que generaron los que estuvieron toda la ronda.
fn peso(p: &Participante, ahora: u64) -> i128 {
    p.peso_devengado + p.deposito * (ahora.saturating_sub(p.desde) as i128)
}

fn peso_total(ps: &Vec<Participante>, ahora: u64) -> i128 {
    let mut total = 0i128;
    for i in 0..ps.len() {
        total += peso(&ps.get_unchecked(i), ahora);
    }
    total
}

/// Cierra el tramo de peso corriente. Se llama antes de tocar el depósito: si
/// no, el monto nuevo contaría desde el principio del tramo anterior.
fn devengar(p: &mut Participante, ahora: u64) {
    p.peso_devengado += p.deposito * (ahora.saturating_sub(p.desde) as i128);
    p.desde = ahora;
}

fn indice_de(ps: &Vec<Participante>, quien: &Address) -> Option<u32> {
    (0..ps.len()).find(|&i| &ps.get_unchecked(i).addr == quien)
}

/// Lo que la fuente tiene por encima del capital. Cero si perdió: el capital
/// de nadie se usa para pagar un premio.
fn premio_disponible(env: &Env, cfg: &Config) -> i128 {
    let principal = principal(env);
    let en_fuente = balance_fuente(env, cfg);
    if en_fuente > principal {
        en_fuente - principal
    } else {
        0
    }
}

fn config(env: &Env) -> Config {
    match env.storage().instance().get(&Clave::Config) {
        Some(c) => c,
        None => panic_with_error!(env, Error::SinInicializar),
    }
}

fn participantes(env: &Env) -> Vec<Participante> {
    env.storage()
        .instance()
        .get(&Clave::Participantes)
        .unwrap_or(Vec::new(env))
}

fn guardar_participantes(env: &Env, ps: &Vec<Participante>) {
    let inst = env.storage().instance();
    inst.set(&Clave::Participantes, ps);
    inst.extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);
}

fn principal(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&Clave::Principal)
        .unwrap_or(0i128)
}

fn ronda(env: &Env) -> u32 {
    env.storage().instance().get(&Clave::Ronda).unwrap_or(0u32)
}

fn cierra_at(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&Clave::CierraAt)
        .unwrap_or(0u64)
}

fn entropia(env: &Env) -> BytesN<32> {
    env.storage()
        .instance()
        .get(&Clave::Entropia)
        .unwrap_or(BytesN::from_array(env, &[0u8; 32]))
}

/// Mezcla el depósito en la entropía acumulada, para que el sorteo dependa
/// también de quién entró, cuánto y cuándo — no solo de drand.
fn mezclar_entropia(env: &Env, quien: &Address, monto: i128) {
    let mut material = Bytes::new(env);
    material.append(&Bytes::from_array(env, &entropia(env).to_array()));
    material.append(&quien.clone().to_xdr(env));
    material.append(&Bytes::from_array(env, &monto.to_be_bytes()));
    material.append(&Bytes::from_array(
        env,
        &env.ledger().timestamp().to_be_bytes(),
    ));
    material.append(&Bytes::from_array(
        env,
        &env.ledger().sequence().to_be_bytes(),
    ));
    let nueva = env.crypto().sha256(&material);
    env.storage()
        .instance()
        .set(&Clave::Entropia, &nueva.to_bytes());
}

/// Llama a la fuente de rendimiento firmando como el propio pozo.
///
/// La fuente exige la autorización de quien deposita o retira, y ese "quien" es
/// este contrato. Un contrato que firma en su propio nombre para una llamada
/// anidada tiene que declarar el árbol completo con
/// `authorize_as_current_contract`: no alcanza con estar arriba en el stack.
///
/// El árbol es de dos niveles porque la fuente, a su vez, mueve el token:
///
/// ```text
/// fuente.<metodo>(pozo, monto)
///   └── token.transfer(pozo, fuente, monto)     (al depositar)
/// ```
///
/// Al retirar, la transferencia va al revés y la hace la fuente con su propia
/// autoridad, así que ahí el sub-árbol queda vacío.
fn invocar_fuente(env: &Env, cfg: &Config, metodo: &str, monto: i128) {
    let yo = env.current_contract_address();

    let sub = if metodo == "depositar" {
        vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: cfg.token.clone(),
                    fn_name: Symbol::new(env, "transfer"),
                    args: (yo.clone(), cfg.fuente.clone(), monto).into_val(env),
                },
                sub_invocations: vec![env],
            }),
        ]
    } else {
        vec![env]
    };

    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: cfg.fuente.clone(),
                fn_name: Symbol::new(env, metodo),
                args: (yo.clone(), monto).into_val(env),
            },
            sub_invocations: sub,
        }),
    ]);

    env.invoke_contract::<()>(
        &cfg.fuente,
        &Symbol::new(env, metodo),
        (yo, monto).into_val(env),
    );
}

fn balance_fuente(env: &Env, cfg: &Config) -> i128 {
    env.invoke_contract::<i128>(
        &cfg.fuente,
        &Symbol::new(env, "balance"),
        (env.current_contract_address(),).into_val(env),
    )
}

/// APY implícito, en puntos básicos, a partir de lo generado en lo que va de la
/// ronda. `None` si todavía no hay con qué calcularlo.
fn apy_bps(env: &Env, principal: i128, premio: i128) -> Option<i128> {
    if principal <= 0 || premio <= 0 {
        return None;
    }
    let transcurrido = env.ledger().timestamp().saturating_sub(
        env.storage()
            .instance()
            .get(&Clave::RondaDesde)
            .unwrap_or(0),
    );
    if transcurrido == 0 {
        return None;
    }
    const SEGUNDOS_ANIO: i128 = 31_536_000;
    Some(premio * 10_000 * SEGUNDOS_ANIO / (principal * transcurrido as i128))
}

mod test;
