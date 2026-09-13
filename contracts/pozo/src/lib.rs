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
//! Soroban no expone el hash de ningún ledger pasado, así que el esquema clásico
//! de EVM (commitear un bloque y usar `blockhash` de uno posterior) no se puede
//! portar. En su lugar, tres fuentes que ninguna parte controla sola:
//!
//! 1. **Un secreto commiteado.** El keeper publica `sha256(secreto)` al cerrar
//!    la ronda y lo revela al sortear. No puede cambiarlo después de verlo todo.
//! 2. **La entropía de los depósitos.** Se mezcla en cada depósito, así que
//!    depende de quién entró, cuánto y cuándo.
//! 3. **El PRNG de la red.** Su semilla sale del hash del transaction-set, que
//!    no se conoce al simular: **el keeper no puede previsualizar quién gana**
//!    antes de mandar la transacción.
//!
//! Queda el riesgo de que un validador corrupto sesgue el punto 3. Es el mismo
//! que documenta la propia SDK de Soroban y no se puede eliminar sin un VRF
//! externo. Está dicho, no escondido.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/// Ledgers que tienen que pasar entre commit y sorteo.
///
/// Fuerza que la semilla del PRNG venga de un transaction-set que todavía no
/// existía cuando el keeper se comprometió al secreto.
pub const ESPERA_LEDGERS: u32 = 10;

/// Después de esto el commit vence y hay que rehacerlo. Evita que un keeper se
/// guarde un commit viejo esperando una ronda que le convenga.
pub const EXPIRA_LEDGERS: u32 = 2_000;

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
    YaInicializado = 1,
    SinInicializar = 2,
    MontoInvalido = 3,
    SaldoInsuficiente = 4,
    PozoLleno = 5,
    NoParticipa = 6,
    /// La ronda todavía no venció.
    RondaEnCurso = 7,
    /// No hay commit pendiente, o ya se usó.
    SinCommit = 8,
    YaHayCommit = 9,
    /// Falta esperar los ledgers entre commit y sorteo.
    CommitReciente = 10,
    CommitVencido = 11,
    /// El secreto revelado no corresponde al hash commiteado.
    SecretoInvalido = 12,
    /// No hay peso: nadie participó de la ronda.
    SinParticipantes = 13,
    PeriodoInvalido = 14,
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

#[contracttype]
#[derive(Clone, Debug)]
pub struct Config {
    pub admin: Address,
    /// Quien cierra la ronda y ejecuta el sorteo.
    pub keeper: Address,
    pub token: Address,
    /// Contrato que genera el rendimiento (Blend en producción, mock en tests).
    pub fuente: Address,
    /// Duración de una ronda, en segundos.
    pub periodo: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Sorteo {
    pub hash_secreto: BytesN<32>,
    pub ledger: u32,
    /// Peso total congelado al commitear, para que un depósito posterior no
    /// cambie las chances de una ronda que ya cerró.
    pub peso_total: i128,
}

/// Lo que necesita la pantalla, en una sola llamada.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Vista {
    pub participantes: u32,
    /// Capital total depositado. Es lo que nadie puede perder.
    pub principal: i128,
    /// Rendimiento generado hasta ahora: es el premio si se sorteara ya.
    pub premio: i128,
    pub ronda: u32,
    pub cierra_at: u64,
    pub periodo: u64,
    /// Rendimiento anual en puntos básicos, derivado de lo que reporta la
    /// fuente. `None` mientras no haya con qué calcularlo.
    pub apy_bps: Option<i128>,
    pub hay_commit: bool,
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
pub struct SorteoComprometido {
    #[topic]
    pub ronda: u32,
    pub ledger: u32,
    pub peso_total: i128,
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
    pub secreto: BytesN<32>,
    pub peso_total: i128,
}

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn inicializar(
        env: Env,
        admin: Address,
        keeper: Address,
        token: Address,
        fuente: Address,
        periodo: u64,
    ) {
        if env.storage().instance().has(&Clave::Config) {
            panic_with_error!(&env, Error::YaInicializado);
        }
        if periodo == 0 {
            panic_with_error!(&env, Error::PeriodoInvalido);
        }
        admin.require_auth();

        let ahora = env.ledger().timestamp();
        let inst = env.storage().instance();
        inst.set(
            &Clave::Config,
            &Config {
                admin,
                keeper,
                token,
                fuente,
                periodo,
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

    /// Cierra la ronda y congela las chances.
    ///
    /// El keeper publica `sha256(secreto)` sin revelarlo. A partir de acá el
    /// peso de cada uno queda fijo: depositar después ya no cambia esta ronda.
    pub fn comprometer_sorteo(env: Env, hash_secreto: BytesN<32>) {
        let cfg = config(&env);
        cfg.keeper.require_auth();

        if env.storage().instance().has(&Clave::Sorteo) {
            panic_with_error!(&env, Error::YaHayCommit);
        }
        let ahora = env.ledger().timestamp();
        if ahora < cierra_at(&env) {
            panic_with_error!(&env, Error::RondaEnCurso);
        }

        let peso_total = peso_total(&participantes(&env), ahora);
        if peso_total <= 0 {
            panic_with_error!(&env, Error::SinParticipantes);
        }

        let ledger = env.ledger().sequence();
        env.storage().instance().set(
            &Clave::Sorteo,
            &Sorteo {
                hash_secreto,
                ledger,
                peso_total,
            },
        );

        SorteoComprometido {
            ronda: ronda(&env),
            ledger,
            peso_total,
        }
        .publish(&env);
    }

    /// Revela el secreto, elige ganador y le paga todo el rendimiento.
    ///
    /// El capital de todos queda intacto y arranca una ronda nueva.
    pub fn ejecutar_sorteo(env: Env, secreto: BytesN<32>) -> Address {
        let cfg = config(&env);
        cfg.keeper.require_auth();

        let s: Sorteo = match env.storage().instance().get(&Clave::Sorteo) {
            Some(s) => s,
            None => panic_with_error!(&env, Error::SinCommit),
        };

        let ledger = env.ledger().sequence();
        if ledger < s.ledger + ESPERA_LEDGERS {
            panic_with_error!(&env, Error::CommitReciente);
        }
        if ledger > s.ledger + EXPIRA_LEDGERS {
            panic_with_error!(&env, Error::CommitVencido);
        }

        // El secreto tiene que ser el mismo que se commiteó a ciegas.
        let hash = env
            .crypto()
            .sha256(&Bytes::from_array(&env, &secreto.to_array()));
        if hash.to_bytes() != s.hash_secreto {
            panic_with_error!(&env, Error::SecretoInvalido);
        }

        let ganador = elegir(&env, &secreto, s.peso_total);

        // El premio es exactamente lo que la fuente devolvió por encima del
        // capital. Si esto diera negativo por una pérdida de la fuente, el
        // premio es cero y no se toca un centavo del capital de nadie.
        let principal = principal(&env);
        let en_fuente = balance_fuente(&env, &cfg);
        let premio = if en_fuente > principal {
            en_fuente - principal
        } else {
            0
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
            secreto,
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
        let en_fuente = balance_fuente(&env, &cfg);
        let premio = if en_fuente > principal {
            en_fuente - principal
        } else {
            0
        };

        Vista {
            participantes: ps.len(),
            principal,
            premio,
            ronda: ronda(&env),
            cierra_at: cierra_at(&env),
            periodo: cfg.periodo,
            apy_bps: apy_bps(&env, principal, premio),
            hay_commit: env.storage().instance().has(&Clave::Sorteo),
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

/// Elige ganador con probabilidad proporcional al peso.
///
/// La semilla combina el secreto commiteado, la entropía acumulada de los
/// depósitos y el PRNG de la red. Ver la nota de arriba sobre qué protege cada
/// uno y qué queda sin cubrir.
fn elegir(env: &Env, secreto: &BytesN<32>, peso_total: i128) -> Address {
    // Primero el PRNG de red, antes de resembrar: su semilla sale del hash del
    // transaction-set, que no se conoce al simular la transacción.
    let de_red: u64 = env.prng().gen();

    let mut material = Bytes::new(env);
    material.append(&Bytes::from_array(env, &secreto.to_array()));
    material.append(&Bytes::from_array(env, &entropia(env).to_array()));
    material.append(&Bytes::from_array(env, &de_red.to_be_bytes()));
    let semilla = env.crypto().sha256(&material);

    env.prng().seed(Bytes::from_array(env, &semilla.to_array()));

    // Dos u64 para no sesgar cuando el peso total pasa de 2^64. Con depósitos
    // grandes por muchos segundos se llega rápido.
    let alto = env.prng().gen::<u64>() as u128;
    let bajo = env.prng().gen::<u64>() as u128;
    let sorteado = (((alto << 64) | bajo) % (peso_total as u128)) as i128;

    // Barrido acumulado sobre la lista, que ya está toda en memoria.
    let ps = participantes(env);
    let ahora = env.ledger().timestamp();
    let mut acumulado = 0i128;
    for i in 0..ps.len() {
        let p = ps.get_unchecked(i);
        acumulado += peso(&p, ahora);
        if sorteado < acumulado {
            return p.addr;
        }
    }
    // Solo se llega acá por redondeo con el último; que gane el último es lo
    // correcto, no un fallback arbitrario.
    ps.get_unchecked(ps.len() - 1).addr
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

/// Mezcla el depósito en la entropía acumulada. Hace que el sorteo dependa
/// también de quién entró, cuánto y cuándo, no solo del secreto del keeper.
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
