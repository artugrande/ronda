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
//!   semilla en ningún punto.
//! - **Quien cierra la ronda**: elige el momento, pero la ronda de drand queda
//!   a ≥ 10 minutos, y un validador solo puede correr el reloj del ledger unos
//!   segundos. No hay ronda pasada que pueda elegir.
//! - **Quien ejecuta**: no elige nada. La firma es la que es, o no verifica.
//! - **Un operador que desaparece**: no existe el rol. Cualquiera puede cerrar
//!   y ejecutar, así que el premio nunca queda rehén de una persona.
//! - **drand mismo**: haría falta que una mayoría de las ~20 organizaciones se
//!   coludan. Es el supuesto de confianza que queda, y es público.
//!
//! El capital nunca depende de nada de esto: `retirar` funciona siempre.
//!
//! ## Cómo escala a un millón
//!
//! Ninguna operación lee a todos los participantes. Cada cuenta es una entrada
//! de storage, y las chances viven en un **Fenwick tree** sobre storage, con
//! capacidad `CAPACIDAD` (2^20). Depositar, retirar y sortear tocan
//! `LOG_CAPACIDAD` = 20 nodos cada uno, sea que haya diez cuentas o un millón.
//!
//! El peso es depósito × tiempo, que en un Fenwick de valores estáticos no
//! entra directo. Se entra por linealidad: el peso de una cuenta en el instante
//! `T` (relativo al inicio de la ronda) es `a·T − b`, con `a` = depósito y
//! `b = depósito·t_entrada − peso_ya_devengado`. Los dos coeficientes suman por
//! prefijos, así que cada nodo guarda `(Σa, Σb)` y el peso acumulado hasta un
//! índice es `T·Σa − Σb`. Ver `Nodo` y `peso_nodo`.
//!
//! Al cerrar no se copia nada: la ronda siguiente arranca en el cierre, y las
//! chances de la ronda cerrada quedan congeladas en el árbol por dos
//! mecanismos. `b` se versiona por ronda dentro del nodo, así que un nodo no
//! escrito en la ronda nueva vale 0 —que es exactamente "todos arrancan desde
//! cero". `a` se comparte entre rondas porque el depósito sobrevive, así que
//! cuando un nodo se escribe **durante una ventana de sorteo pendiente**,
//! guarda primero una copia congelada estampada con esa ronda; el sorteo lee
//! la copia si existe y el valor vivo si nadie tocó el nodo. Ver `congelar`.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Symbol,
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

/// Capacidad del árbol: 2^20 cuentas. Cada duplicación cuesta una iteración
/// más por operación, así que subirla es cambiar dos constantes.
pub const LOG_CAPACIDAD: u32 = 20;
pub const CAPACIDAD: u32 = 1 << LOG_CAPACIDAD;

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

/// Una cuenta. Una entrada de storage por cuenta; nunca se listan.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cuenta {
    /// Posición 1-based en el árbol. Se asigna al primer depósito y no se
    /// reusa nunca.
    pub indice: u32,
    /// Capital actual. Nunca se toca al sortear.
    pub deposito: i128,
    /// Ronda a la que corresponden `desde` y `devengado`. Si es anterior a la
    /// ronda en curso, los dos valen 0 para la ronda en curso.
    pub ronda: u32,
    /// Segundos desde el inicio de la ronda hasta el último movimiento.
    pub desde: u64,
    /// Peso ya devengado en la ronda: depósito × segundos, hasta `desde`.
    pub devengado: i128,
}

/// Un nodo del Fenwick tree. Guarda los coeficientes lineales del peso
/// (`T·a − b`) para su rango de índices, más una copia congelada para la
/// ronda cuyo sorteo está pendiente.
///
/// Las estampas de ronda valen 0 en un nodo recién creado, y 0 nunca es una
/// ronda real (empiezan en 1): así un nodo fresco no puede confundirse con uno
/// escrito o congelado en la ronda en curso.
#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Nodo {
    /// Σ depósito del rango. Sobrevive entre rondas.
    pub a: i128,
    /// Σ b del rango, válido solo para `ronda_b`. Otra ronda lo lee como 0.
    pub b: i128,
    pub ronda_b: u32,
    /// Copia de `(a, b)` tal como estaban al cerrar `ronda_congelada`.
    pub a_congelado: i128,
    pub b_congelado: i128,
    pub ronda_congelada: u32,
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
/// fijo acá o congelado en el árbol: depositar o retirar después no lo cambia.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Sorteo {
    /// La ronda del pozo que cerró.
    pub ronda: u32,
    /// La ronda de drand cuya firma decide. Estaba en el futuro al cerrar.
    pub ronda_drand: u64,
    /// Instante del cierre, en segundos desde el inicio de esa ronda.
    pub t_cierre: u64,
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
    /// Cuentas con capital adentro ahora.
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
    // Instancia: chico y de acceso constante.
    Config,
    Ronda,
    RondaDesde,
    CierraAt,
    Entropia,
    Sorteo,
    /// Cuentas con índice asignado. Solo crece.
    Indexadas,
    /// Cuentas con depósito > 0 ahora.
    Activas,
    /// Σ a de todo el árbol = capital total.
    TotalA,
    /// Σ b de todo el árbol para una ronda.
    TotalB(u32),
    // Persistente: una entrada por cuenta y por nodo del árbol.
    Cuenta(Address),
    Direccion(u32),
    Nodo(u32),
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
        // Las rondas arrancan en 1: el 0 queda reservado como "nunca" para las
        // estampas de los nodos (`ronda_b`, `ronda_congelada`), que nacen en
        // 0 por `Default`. Si la primera ronda fuera la 0, un nodo recién
        // creado parecería congelado para ella con copia (0, 0) y el sorteo
        // vería todos los pesos en cero.
        inst.set(&Clave::Ronda, &1u32);
        inst.set(&Clave::RondaDesde, &ahora);
        inst.set(&Clave::CierraAt, &(ahora + periodo));
        inst.set(&Clave::Entropia, &BytesN::from_array(&env, &[0u8; 32]));
        inst.set(&Clave::Indexadas, &0u32);
        inst.set(&Clave::Activas, &0u32);
        inst.set(&Clave::TotalA, &0i128);
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

        // El capital entra al contrato y de ahí va derecho a generar.
        token::Client::new(&env, &cfg.token).transfer(
            &usuario,
            env.current_contract_address(),
            &monto,
        );
        invocar_fuente(&env, &cfg, "depositar", monto);

        let ronda = ronda(&env);
        // Un pozo sin nadie adentro no tiene reloj: la ronda arranca con el
        // primero que entra. Si no, una ronda que venció vacía se cerraría un
        // segundo después del primer depósito. Se reinicia solo cuando nadie
        // tiene peso en la ronda (ni capital ni tiempo devengado), así que a
        // ningún participante le cambia nada.
        if principal(&env) == 0 && total_b(&env, ronda) == 0 {
            let ahora = env.ledger().timestamp();
            let inst = env.storage().instance();
            inst.set(&Clave::RondaDesde, &ahora);
            inst.set(&Clave::CierraAt, &(ahora + cfg.periodo));
        }
        let t = t_ronda(&env);
        let mut c = match cuenta(&env, &usuario) {
            Some(c) => c,
            None => {
                let n: u32 = env.storage().instance().get(&Clave::Indexadas).unwrap_or(0);
                if n >= CAPACIDAD {
                    panic_with_error!(&env, Error::PozoLleno);
                }
                env.storage().instance().set(&Clave::Indexadas, &(n + 1));
                let clave = Clave::Direccion(n + 1);
                env.storage().persistent().set(&clave, &usuario);
                extender(&env, &clave);
                Cuenta {
                    indice: n + 1,
                    deposito: 0,
                    ronda,
                    desde: t,
                    devengado: 0,
                }
            }
        };

        let (a0, b0) = coeficientes(&mut c, ronda, t);
        if c.deposito == 0 {
            contar_activas(&env, 1);
        }
        c.deposito += monto;
        let (a1, b1) = coeficientes(&mut c, ronda, t);
        guardar_cuenta(&env, &usuario, &c);
        actualizar(&env, ronda, c.indice, a1 - a0, b1 - b0);

        let principal = principal(&env);
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
    /// No depende de que haya o no un sorteo pendiente. El peso ya devengado en
    /// la ronda se conserva: la plata estuvo generando mientras estuvo adentro.
    pub fn retirar(env: Env, usuario: Address, monto: i128) {
        usuario.require_auth();
        if monto <= 0 {
            panic_with_error!(&env, Error::MontoInvalido);
        }
        let cfg = config(&env);

        let mut c = match cuenta(&env, &usuario) {
            Some(c) => c,
            None => panic_with_error!(&env, Error::NoParticipa),
        };
        if monto > c.deposito {
            panic_with_error!(&env, Error::SaldoInsuficiente);
        }

        let ronda = ronda(&env);
        let t = t_ronda(&env);
        let (a0, b0) = coeficientes(&mut c, ronda, t);
        c.deposito -= monto;
        if c.deposito == 0 {
            contar_activas(&env, -1);
        }
        let (a1, b1) = coeficientes(&mut c, ronda, t);
        guardar_cuenta(&env, &usuario, &c);
        actualizar(&env, ronda, c.indice, a1 - a0, b1 - b0);

        invocar_fuente(&env, &cfg, "retirar", monto);
        token::Client::new(&env, &cfg.token).transfer(
            &env.current_contract_address(),
            &usuario,
            &monto,
        );

        let principal = principal(&env);
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
    /// futuro: al cerrar, esa firma todavía no existe para nadie. La ronda
    /// siguiente arranca acá mismo: lo que se deposite desde ahora cuenta para
    /// ella y no toca las chances de la que cerró.
    pub fn cerrar_ronda(env: Env) -> u64 {
        let cfg = config(&env);
        if env.storage().instance().has(&Clave::Sorteo) {
            panic_with_error!(&env, Error::RondaYaCerrada);
        }
        let ahora = env.ledger().timestamp();
        if ahora < cierra_at(&env) {
            panic_with_error!(&env, Error::RondaEnCurso);
        }

        let r = ronda(&env);
        let t_cierre = t_ronda(&env);
        let peso_total = (t_cierre as i128) * principal(&env) - total_b(&env, r);
        if peso_total <= 0 {
            panic_with_error!(&env, Error::SinParticipantes);
        }

        let ronda_drand = drand::ronda_en(
            cfg.drand_genesis,
            cfg.drand_periodo,
            ahora + MARGEN_SEGUNDOS,
        );
        let premio = premio_disponible(&env, &cfg);

        let inst = env.storage().instance();
        inst.set(
            &Clave::Sorteo,
            &Sorteo {
                ronda: r,
                ronda_drand,
                t_cierre,
                peso_total,
                entropia: entropia(&env),
                premio,
            },
        );
        // La ronda nueva empieza ahora, no cuando alguien ejecute el sorteo.
        inst.set(&Clave::Ronda, &(r + 1));
        inst.set(&Clave::RondaDesde, &ahora);
        inst.set(&Clave::CierraAt, &(ahora + cfg.periodo));
        inst.extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);

        RondaCerrada {
            ronda: r,
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
    /// El capital de todos queda intacto. La ronda siguiente ya está corriendo
    /// desde el cierre; esto solo paga.
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

        env.storage().instance().remove(&Clave::Sorteo);
        env.storage()
            .instance()
            .extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);

        SorteoEjecutado {
            ronda: s.ronda,
            ganador: ganador.clone(),
            premio,
            ronda_drand: s.ronda_drand,
            firma,
            peso_total: s.peso_total,
        }
        .publish(&env);

        ganador
    }

    // -- Lecturas -----------------------------------------------------------

    /// Todo lo que muestra la pantalla, en una llamada.
    pub fn estado(env: Env) -> Vista {
        let cfg = config(&env);
        let principal = principal(&env);
        let pendiente: Option<Sorteo> = env.storage().instance().get(&Clave::Sorteo);

        let premio = match &pendiente {
            Some(s) => s.premio,
            None => premio_disponible(&env, &cfg),
        };

        Vista {
            participantes: env.storage().instance().get(&Clave::Activas).unwrap_or(0),
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
        cuenta(&env, &usuario).map(|c| c.deposito).unwrap_or(0)
    }

    /// Chances de una cuenta sobre el total, en puntos básicos, para la ronda
    /// en curso.
    ///
    /// Es lo que muestra la UI como "tu probabilidad". El peso es
    /// depósito × tiempo: depositar justo antes del cierre casi no suma.
    ///
    /// Trunca hacia abajo, así que las chances de todos suman hasta
    /// `participantes - 1` puntos menos de 10.000. Nunca más: nadie ve una
    /// probabilidad mayor a la que tiene.
    pub fn chances_bps(env: Env, usuario: Address) -> i128 {
        let r = ronda(&env);
        let t = t_ronda(&env) as i128;
        let total = t * principal(&env) - total_b(&env, r);
        if total <= 0 {
            return 0;
        }
        match cuenta(&env, &usuario) {
            Some(mut c) => {
                let (a, b) = coeficientes(&mut c, r, t as u64);
                (a * t - b) * 10_000 / total
            }
            None => 0,
        }
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
    for byte in &semilla[..16] {
        n = (n << 8) | (*byte as u128);
    }
    let sorteado = (n % (s.peso_total as u128)) as i128;

    let indice = buscar(env, s, sorteado);
    env.storage()
        .persistent()
        .get(&Clave::Direccion(indice))
        .unwrap()
}

/// Descenso binario sobre el Fenwick: el menor índice cuyo peso acumulado
/// supera `objetivo`. Toca `LOG_CAPACIDAD` nodos, sea cual sea la cantidad de
/// cuentas.
fn buscar(env: &Env, s: &Sorteo, mut objetivo: i128) -> u32 {
    let mut pos = 0u32;
    for k in (0..LOG_CAPACIDAD).rev() {
        let siguiente = pos + (1 << k);
        if siguiente > CAPACIDAD {
            continue;
        }
        let w = peso_nodo(env, siguiente, s);
        if w <= objetivo {
            pos = siguiente;
            objetivo -= w;
        }
    }
    pos + 1
}

// ---------------------------------------------------------------------------
// Fenwick tree
// ---------------------------------------------------------------------------

fn nodo(env: &Env, i: u32) -> Nodo {
    env.storage()
        .persistent()
        .get(&Clave::Nodo(i))
        .unwrap_or_default()
}

/// Suma `(da, db)` a todos los nodos que cubren el índice `i` para la ronda
/// `r`. Si hay un sorteo pendiente de una ronda anterior, cada nodo tocado
/// guarda antes su copia congelada.
fn actualizar(env: &Env, r: u32, i: u32, da: i128, db: i128) {
    let pendiente: Option<Sorteo> = env.storage().instance().get(&Clave::Sorteo);
    let mut i = i;
    while i <= CAPACIDAD {
        let mut n = nodo(env, i);
        if let Some(s) = &pendiente {
            congelar(&mut n, s.ronda);
        }
        if n.ronda_b != r {
            n.b = 0;
            n.ronda_b = r;
        }
        n.a += da;
        n.b += db;
        let clave = Clave::Nodo(i);
        env.storage().persistent().set(&clave, &n);
        extender(env, &clave);
        i += i & i.wrapping_neg();
    }

    let inst = env.storage().instance();
    inst.set(&Clave::TotalA, &(principal(env) + da));
    inst.set(&Clave::TotalB(r), &(total_b(env, r) + db));
}

/// Antes de escribir un nodo mientras el sorteo de `ronda` está pendiente,
/// preservar cómo estaba al cerrar. Solo la primera escritura por ventana
/// copia; las siguientes ya encuentran la estampa.
fn congelar(n: &mut Nodo, ronda: u32) {
    if n.ronda_congelada != ronda {
        n.a_congelado = n.a;
        n.b_congelado = if n.ronda_b == ronda { n.b } else { 0 };
        n.ronda_congelada = ronda;
    }
}

/// Peso del rango de un nodo en el instante del cierre de la ronda sorteada:
/// `t_cierre · Σa − Σb`, con los valores congelados si el nodo se tocó después
/// del cierre y los vivos si no.
fn peso_nodo(env: &Env, i: u32, s: &Sorteo) -> i128 {
    let n = nodo(env, i);
    let (a, b) = if n.ronda_congelada == s.ronda {
        (n.a_congelado, n.b_congelado)
    } else {
        (n.a, if n.ronda_b == s.ronda { n.b } else { 0 })
    };
    (s.t_cierre as i128) * a - b
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Los coeficientes `(a, b)` de una cuenta para la ronda `r` en el instante
/// `t`, con `peso = a·t − b`. Antes, la trae a la ronda `r` si venía de una
/// anterior (peso desde cero) y devenga el tramo corriente hasta `t`.
///
/// Se llama antes y después de tocar el depósito; la diferencia es lo que va
/// al árbol.
fn coeficientes(c: &mut Cuenta, r: u32, t: u64) -> (i128, i128) {
    if c.ronda != r {
        c.ronda = r;
        c.desde = 0;
        c.devengado = 0;
    }
    c.devengado += c.deposito * (t.saturating_sub(c.desde) as i128);
    c.desde = t;
    (c.deposito, c.deposito * (t as i128) - c.devengado)
}

/// Segundos desde el inicio de la ronda en curso.
fn t_ronda(env: &Env) -> u64 {
    let desde: u64 = env
        .storage()
        .instance()
        .get(&Clave::RondaDesde)
        .unwrap_or(0);
    env.ledger().timestamp().saturating_sub(desde)
}

fn cuenta(env: &Env, quien: &Address) -> Option<Cuenta> {
    env.storage()
        .persistent()
        .get(&Clave::Cuenta(quien.clone()))
}

fn guardar_cuenta(env: &Env, quien: &Address, c: &Cuenta) {
    let clave = Clave::Cuenta(quien.clone());
    env.storage().persistent().set(&clave, c);
    extender(env, &clave);
}

fn contar_activas(env: &Env, delta: i32) {
    let inst = env.storage().instance();
    let n: u32 = inst.get(&Clave::Activas).unwrap_or(0);
    inst.set(&Clave::Activas, &((n as i64 + delta as i64) as u32));
}

fn extender(env: &Env, clave: &Clave) {
    env.storage()
        .persistent()
        .extend_ttl(clave, BUMP_UMBRAL, BUMP_EXTENSION);
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

/// Capital total. Es también Σa del árbol entero.
fn principal(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&Clave::TotalA)
        .unwrap_or(0i128)
}

fn total_b(env: &Env, r: u32) -> i128 {
    env.storage()
        .instance()
        .get(&Clave::TotalB(r))
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
    let transcurrido = t_ronda(env);
    if transcurrido == 0 {
        return None;
    }
    const SEGUNDOS_ANIO: i128 = 31_536_000;
    Some(premio * 10_000 * SEGUNDOS_ANIO / (principal * transcurrido as i128))
}

mod test;
