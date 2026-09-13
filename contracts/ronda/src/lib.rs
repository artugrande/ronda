#![no_std]

//! Ronda — ahorro rotativo (vaquita / tanda) sobre Soroban.
//!
//! Un grupo aporta un monto fijo por período y cada período uno se lleva el
//! pozo, por turnos. El contrato custodia los fondos, ordena los turnos y paga.
//!
//! Dos vías de aporte:
//!
//! - **Nativa** (`acreditar`): el miembro ya tiene el token en Stellar y firma
//!   una transferencia al contrato.
//! - **Cross-chain** (`registrar_intencion` + `confirmar_oft`): el miembro
//!   declara que va a aportar desde otra cadena, el contrato le devuelve un
//!   monto etiquetado único, y cuando el USDT0 llega el oráculo machea ese
//!   monto contra la intención pendiente. Ver `PRODUCTO.md` §Atribución.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, Vec,
};

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/// El OFT recorta el 7º decimal antes de armar el mensaje cross-chain (los
/// decimales locales son 7 y los compartidos 6). La etiqueta tiene que vivir en
/// el 6º decimal o más arriba, nunca en el 7º: un stroop es el 7º decimal, así
/// que el paso mínimo que viaja es de 10 stroops.
pub const PASO_ETIQUETA: i128 = 10;

/// Techo de la etiqueta: 9999 * 10 stroops = 0.0099990 unidades de polvo.
pub const MAX_ETIQUETA: u32 = 9_999;

/// Intentos al buscar una etiqueta libre antes de rendirse.
const INTENTOS_ETIQUETA: u32 = 64;

/// Cota de miembros — acota los loops de `ejecutar_turno`.
pub const MAX_MIEMBROS: u32 = 24;

// Los TTL de storage expiran en silencio (ver CLAUDE.md): las lecturas
// devuelven missing-value sin warning. Se extienden en cada escritura.
const BUMP_UMBRAL: u32 = 500_000;
const BUMP_EXTENSION: u32 = 518_400; // ~30 días a 5s por ledger

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    RondaInexistente = 1,
    RondaFinalizada = 2,
    NoEsMiembro = 3,
    YaAporto = 4,
    TurnoNoVencido = 5,
    /// El monto tiene que ser positivo y con el 7º decimal en cero, porque ese
    /// dígito no sobrevive al viaje cross-chain.
    MontoInvalido = 6,
    PeriodoInvalido = 7,
    MiembrosInvalidos = 8,
    MiembroDuplicado = 9,
    SinEtiquetaLibre = 10,
    IntencionInexistente = 11,
    /// El miembro quedó excluido por incumplimiento.
    MiembroExcluido = 12,
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EstadoMiembro {
    /// Al día y todavía no cobró su turno.
    Activo,
    /// Ya cobró. Sigue obligado a aportar hasta el final.
    Cobro,
    /// Falló un turno: pierde el turno futuro y no puede seguir aportando.
    Moroso,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EstadoRonda {
    EnCurso,
    Finalizada,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Miembro {
    pub addr: Address,
    pub estado: EstadoMiembro,
    /// Total aportado a lo largo de la ronda.
    pub aportado: i128,
    /// Total cobrado (0 o el pozo de su turno).
    pub cobrado: i128,
    /// Turnos que dejó de pagar. Es el historial de cumplimiento.
    pub incumplimientos: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Ronda {
    pub oraculo: Address,
    pub token: Address,
    /// Orden de cobro. También es la lista de miembros.
    pub orden: Vec<Address>,
    pub monto_turno: i128,
    pub periodo: u64,
    /// Índice del próximo turno a ejecutar dentro de `orden`.
    pub turno: u32,
    pub proximo_turno_at: u64,
    pub estado: EstadoRonda,
    /// Lo juntado para el turno en curso.
    pub pozo: i128,
}

/// Lo que devuelve `estado`: quién pagó, de quién es el turno.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Vista {
    pub turno: u32,
    /// Quién cobra si el turno se ejecutara ahora. `None` si no queda nadie
    /// activo — la ronda se finaliza y se reembolsa el turno en curso.
    pub beneficiario: Option<Address>,
    pub pozo: i128,
    pub monto_turno: i128,
    pub proximo_turno_at: u64,
    pub estado: EstadoRonda,
    pub miembros: Vec<Miembro>,
    /// Miembros que todavía no aportaron al turno en curso.
    pub pendientes: Vec<Address>,
}

// ---------------------------------------------------------------------------
// Eventos
//
// Todo lo que el indexer necesita seguir. `ronda` y `miembro` van como topics
// para que se pueda filtrar del lado del RPC.
// ---------------------------------------------------------------------------

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RondaCreada {
    #[topic]
    pub ronda: u32,
    pub miembros: u32,
    pub monto_turno: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntencionRegistrada {
    #[topic]
    pub ronda: u32,
    #[topic]
    pub miembro: Address,
    /// El monto exacto que hay que mandar desde la otra cadena.
    pub monto_etiquetado: i128,
    pub turno: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AporteAcreditado {
    #[topic]
    pub ronda: u32,
    #[topic]
    pub miembro: Address,
    pub monto: i128,
    pub turno: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OftConfirmado {
    #[topic]
    pub ronda: u32,
    #[topic]
    pub miembro: Address,
    /// El `guid` del `oft_received`, para auditar el cruce.
    pub guid: BytesN<32>,
    pub monto: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MorosoMarcado {
    #[topic]
    pub ronda: u32,
    #[topic]
    pub miembro: Address,
    pub turno: u32,
    pub incumplimientos: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnoEjecutado {
    #[topic]
    pub ronda: u32,
    #[topic]
    pub beneficiario: Address,
    pub monto: i128,
    pub turno: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reembolsado {
    #[topic]
    pub ronda: u32,
    #[topic]
    pub miembro: Address,
    pub monto: i128,
    pub turno: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RondaFinalizada {
    #[topic]
    pub ronda: u32,
    pub turnos_pagados: u32,
}

#[contracttype]
pub enum Clave {
    /// Autoincremental de `ronda_id`.
    Contador,
    Ronda(u32),
    Miembro(u32, Address),
    /// (ronda, turno, miembro) -> monto aportado en ese turno.
    Aporte(u32, u32, Address),
    /// (ronda, monto_etiquetado) -> miembro. Es el índice que consulta el
    /// indexer cuando ve un `oft_received`.
    Intencion(u32, i128),
    /// (ronda, miembro) -> monto_etiquetado pendiente.
    IntencionDe(u32, Address),
    /// Próxima etiqueta a probar, por ronda.
    Etiqueta(u32),
}

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// Crea una ronda. `orden` es a la vez la lista de miembros y el orden de
    /// cobro: el primero del vector cobra el primer turno.
    ///
    /// `monto_turno` tiene que tener el 7º decimal en cero (`% 10 == 0`) para
    /// que la etiqueta cross-chain sobreviva al recorte del OFT.
    pub fn crear_ronda(
        env: Env,
        oraculo: Address,
        token: Address,
        orden: Vec<Address>,
        monto_turno: i128,
        periodo: u64,
    ) -> u32 {
        if orden.len() < 2 || orden.len() > MAX_MIEMBROS {
            panic_with_error!(&env, Error::MiembrosInvalidos);
        }
        if monto_turno <= 0 || monto_turno % PASO_ETIQUETA != 0 {
            panic_with_error!(&env, Error::MontoInvalido);
        }
        if periodo == 0 {
            panic_with_error!(&env, Error::PeriodoInvalido);
        }

        // Sin duplicados: un miembro repetido cobraría dos turnos.
        let n = orden.len();
        for i in 0..n {
            let a = orden.get_unchecked(i);
            for j in (i + 1)..n {
                if a == orden.get_unchecked(j) {
                    panic_with_error!(&env, Error::MiembroDuplicado);
                }
            }
        }

        let id: u32 = env
            .storage()
            .instance()
            .get(&Clave::Contador)
            .unwrap_or(0u32);
        env.storage().instance().set(&Clave::Contador, &(id + 1));
        env.storage()
            .instance()
            .extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);

        let r = Ronda {
            oraculo,
            token,
            orden: orden.clone(),
            monto_turno,
            periodo,
            turno: 0,
            proximo_turno_at: env.ledger().timestamp() + periodo,
            estado: EstadoRonda::EnCurso,
            pozo: 0,
        };
        guardar_ronda(&env, id, &r);

        for i in 0..n {
            let addr = orden.get_unchecked(i);
            guardar_miembro(
                &env,
                id,
                &Miembro {
                    addr,
                    estado: EstadoMiembro::Activo,
                    aportado: 0,
                    cobrado: 0,
                    incumplimientos: 0,
                },
            );
        }

        RondaCreada {
            ronda: id,
            miembros: n,
            monto_turno,
        }
        .publish(&env);
        id
    }

    /// Aporte nativo: el miembro ya tiene el token en Stellar y transfiere al
    /// contrato. Cubre el turno en curso.
    pub fn acreditar(env: Env, ronda_id: u32, miembro: Address) {
        miembro.require_auth();

        let mut r = leer_ronda(&env, ronda_id);
        exigir_en_curso(&env, &r);
        let mut m = leer_miembro(&env, ronda_id, &miembro);
        exigir_puede_aportar(&env, &m);
        exigir_no_aporto(&env, ronda_id, r.turno, &miembro);

        let monto = r.monto_turno;
        token::Client::new(&env, &r.token).transfer(
            &miembro,
            env.current_contract_address(),
            &monto,
        );

        registrar_aporte(&env, &mut r, ronda_id, &mut m, monto);
    }

    /// Declara la intención de aportar desde otra cadena y devuelve el monto
    /// etiquetado que hay que mandar, exacto.
    ///
    /// Es idempotente: si el miembro ya tiene una intención pendiente para el
    /// turno en curso, devuelve la misma etiqueta.
    pub fn registrar_intencion(env: Env, ronda_id: u32, miembro: Address) -> i128 {
        miembro.require_auth();

        let r = leer_ronda(&env, ronda_id);
        exigir_en_curso(&env, &r);
        let m = leer_miembro(&env, ronda_id, &miembro);
        exigir_puede_aportar(&env, &m);
        exigir_no_aporto(&env, ronda_id, r.turno, &miembro);

        let clave_de = Clave::IntencionDe(ronda_id, miembro.clone());
        if let Some(previo) = env.storage().persistent().get::<_, i128>(&clave_de) {
            extender(&env, &clave_de);
            return previo;
        }

        // Primera etiqueta libre a partir del contador de la ronda. El contador
        // avanza siempre y no rebobina al liberarse una etiqueta: si una
        // entrega cross-chain llega tarde, con el turno ya cerrado, su monto no
        // puede haber sido reasignado a otro miembro mientras tanto. Recién se
        // recicla al dar la vuelta completa a MAX_ETIQUETA.
        let clave_seq = Clave::Etiqueta(ronda_id);
        let seq: u32 = env.storage().persistent().get(&clave_seq).unwrap_or(1u32);
        let mut etiqueta = seq;
        let mut intentos = 0u32;
        let monto = loop {
            if intentos >= INTENTOS_ETIQUETA {
                panic_with_error!(&env, Error::SinEtiquetaLibre);
            }
            if etiqueta == 0 || etiqueta > MAX_ETIQUETA {
                etiqueta = 1;
            }
            let candidato = r.monto_turno + (etiqueta as i128) * PASO_ETIQUETA;
            if !env
                .storage()
                .persistent()
                .has(&Clave::Intencion(ronda_id, candidato))
            {
                break candidato;
            }
            etiqueta += 1;
            intentos += 1;
        };

        env.storage()
            .persistent()
            .set(&Clave::Intencion(ronda_id, monto), &miembro);
        extender(&env, &Clave::Intencion(ronda_id, monto));
        env.storage().persistent().set(&clave_de, &monto);
        extender(&env, &clave_de);
        env.storage()
            .persistent()
            .set(&clave_seq, &(etiqueta.wrapping_add(1)));
        extender(&env, &clave_seq);

        IntencionRegistrada {
            ronda: ronda_id,
            miembro,
            monto_etiquetado: monto,
            turno: r.turno,
        }
        .publish(&env);
        monto
    }

    /// El oráculo vio un `oft_received` y lo machea contra la intención
    /// pendiente por monto exacto. Los fondos ya están en el contrato: esto no
    /// transfiere nada, solo acredita.
    ///
    /// `guid` es el del evento del OFT y queda en el log como auditoría.
    pub fn confirmar_oft(
        env: Env,
        ronda_id: u32,
        monto_recibido: i128,
        guid: BytesN<32>,
    ) -> Address {
        let mut r = leer_ronda(&env, ronda_id);
        r.oraculo.require_auth();
        exigir_en_curso(&env, &r);

        let clave = Clave::Intencion(ronda_id, monto_recibido);
        let miembro: Address = match env.storage().persistent().get(&clave) {
            Some(a) => a,
            None => panic_with_error!(&env, Error::IntencionInexistente),
        };

        // No hace falta chequear el monto: la etiqueta solo existe como
        // `monto_turno + etiqueta * PASO_ETIQUETA`, así que un match exacto ya
        // implica que cubre el turno. Una entrega por menos (fee inesperada en
        // destino) no machea contra nada y cae en `IntencionInexistente`, que
        // es lo que queremos: la resuelve el oráculo a mano.
        let mut m = leer_miembro(&env, ronda_id, &miembro);
        exigir_puede_aportar(&env, &m);
        exigir_no_aporto(&env, ronda_id, r.turno, &miembro);

        // Liberar la etiqueta antes de acreditar: el mismo monto tiene que
        // poder reusarse en el turno siguiente.
        env.storage().persistent().remove(&clave);
        env.storage()
            .persistent()
            .remove(&Clave::IntencionDe(ronda_id, miembro.clone()));

        registrar_aporte(&env, &mut r, ronda_id, &mut m, monto_recibido);

        OftConfirmado {
            ronda: ronda_id,
            miembro: miembro.clone(),
            guid,
            monto: monto_recibido,
        }
        .publish(&env);
        miembro
    }

    /// Cierra el turno en curso: marca morosos, paga al titular lo que
    /// efectivamente se juntó y avanza.
    ///
    /// Permissionless — cualquiera puede disparar el turno una vez vencido el
    /// período. Devuelve el beneficiario y lo que cobró.
    pub fn ejecutar_turno(env: Env, ronda_id: u32) -> Option<(Address, i128)> {
        let mut r = leer_ronda(&env, ronda_id);
        exigir_en_curso(&env, &r);

        if env.ledger().timestamp() < r.proximo_turno_at {
            panic_with_error!(&env, Error::TurnoNoVencido);
        }

        // 1. El que no aportó este turno queda moroso: pierde el turno futuro y
        //    el incumplimiento queda on-chain.
        let n = r.orden.len();
        for i in 0..n {
            let addr = r.orden.get_unchecked(i);
            let mut m = leer_miembro(&env, ronda_id, &addr);
            if m.estado == EstadoMiembro::Moroso {
                continue;
            }
            if aporte_de(&env, ronda_id, r.turno, &addr) == 0 {
                m.estado = EstadoMiembro::Moroso;
                m.incumplimientos += 1;
                guardar_miembro(&env, ronda_id, &m);
                MorosoMarcado {
                    ronda: ronda_id,
                    miembro: addr,
                    turno: r.turno,
                    incumplimientos: m.incumplimientos,
                }
                .publish(&env);
            }
        }

        // 2. Beneficiario: el primero del orden, desde el turno actual, que
        //    siga activo. Los morosos que quedaron en el medio se saltean.
        let idx = indice_beneficiario(&env, ronda_id, &r);

        let salida = match idx {
            Some(i) => {
                let addr = r.orden.get_unchecked(i);
                let monto = r.pozo;
                if monto > 0 {
                    token::Client::new(&env, &r.token).transfer(
                        &env.current_contract_address(),
                        &addr,
                        &monto,
                    );
                }
                let mut m = leer_miembro(&env, ronda_id, &addr);
                m.estado = EstadoMiembro::Cobro;
                m.cobrado += monto;
                guardar_miembro(&env, ronda_id, &m);

                r.turno = i + 1;
                r.pozo = 0;
                TurnoEjecutado {
                    ronda: ronda_id,
                    beneficiario: addr.clone(),
                    monto,
                    turno: i,
                }
                .publish(&env);
                Some((addr, monto))
            }
            None => {
                // No queda nadie que pueda cobrar. Se devuelve el turno en
                // curso a quien lo haya aportado y la ronda se cierra.
                reembolsar_turno(&env, &mut r, ronda_id);
                r.turno = n;
                None
            }
        };

        // 3. Avanzar el reloj y cerrar si se acabaron los turnos.
        //
        // El turno siguiente arranca ahora, no en el horario nominal. Sumar el
        // período sobre `proximo_turno_at` parece lo natural, pero si la ronda
        // venía atrasada deja el turno siguiente ya vencido al nacer: se pueden
        // encadenar cierres y marcar morosos a miembros que nunca tuvieron
        // chance de aportar.
        //
        // Como ejecutar exige `now >= proximo_turno_at`, esto nunca adelanta el
        // calendario: cuando el turno se cierra en hora, da exactamente lo
        // mismo que sumar el período.
        r.proximo_turno_at = env.ledger().timestamp() + r.periodo;
        if r.turno >= n || indice_beneficiario(&env, ronda_id, &r).is_none() {
            if r.turno < n {
                reembolsar_turno(&env, &mut r, ronda_id);
                r.turno = n;
            }
            r.estado = EstadoRonda::Finalizada;
            RondaFinalizada {
                ronda: ronda_id,
                turnos_pagados: turnos_pagados(&env, ronda_id, &r),
            }
            .publish(&env);
        }
        guardar_ronda(&env, ronda_id, &r);

        salida
    }

    /// Quién pagó, de quién es el turno.
    pub fn estado(env: Env, ronda_id: u32) -> Vista {
        let r = leer_ronda(&env, ronda_id);
        let n = r.orden.len();

        let mut miembros = Vec::new(&env);
        let mut pendientes = Vec::new(&env);
        for i in 0..n {
            let addr = r.orden.get_unchecked(i);
            let m = leer_miembro(&env, ronda_id, &addr);
            if r.estado == EstadoRonda::EnCurso
                && m.estado != EstadoMiembro::Moroso
                && aporte_de(&env, ronda_id, r.turno, &addr) == 0
            {
                pendientes.push_back(addr);
            }
            miembros.push_back(m);
        }

        let beneficiario =
            indice_beneficiario(&env, ronda_id, &r).map(|i| r.orden.get_unchecked(i));

        Vista {
            turno: r.turno,
            beneficiario,
            pozo: r.pozo,
            monto_turno: r.monto_turno,
            proximo_turno_at: r.proximo_turno_at,
            estado: r.estado,
            miembros,
            pendientes,
        }
    }

    /// Monto etiquetado pendiente de un miembro, si tiene uno.
    pub fn intencion_de(env: Env, ronda_id: u32, miembro: Address) -> Option<i128> {
        env.storage()
            .persistent()
            .get(&Clave::IntencionDe(ronda_id, miembro))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extender(env: &Env, clave: &Clave) {
    env.storage()
        .persistent()
        .extend_ttl(clave, BUMP_UMBRAL, BUMP_EXTENSION);
}

fn guardar_ronda(env: &Env, id: u32, r: &Ronda) {
    let clave = Clave::Ronda(id);
    env.storage().persistent().set(&clave, r);
    extender(env, &clave);
}

fn leer_ronda(env: &Env, id: u32) -> Ronda {
    match env.storage().persistent().get(&Clave::Ronda(id)) {
        Some(r) => {
            extender(env, &Clave::Ronda(id));
            r
        }
        None => panic_with_error!(env, Error::RondaInexistente),
    }
}

fn guardar_miembro(env: &Env, id: u32, m: &Miembro) {
    let clave = Clave::Miembro(id, m.addr.clone());
    env.storage().persistent().set(&clave, m);
    extender(env, &clave);
}

fn leer_miembro(env: &Env, id: u32, addr: &Address) -> Miembro {
    match env
        .storage()
        .persistent()
        .get(&Clave::Miembro(id, addr.clone()))
    {
        Some(m) => m,
        None => panic_with_error!(env, Error::NoEsMiembro),
    }
}

fn aporte_de(env: &Env, id: u32, turno: u32, addr: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&Clave::Aporte(id, turno, addr.clone()))
        .unwrap_or(0i128)
}

fn exigir_en_curso(env: &Env, r: &Ronda) {
    if r.estado != EstadoRonda::EnCurso {
        panic_with_error!(env, Error::RondaFinalizada);
    }
}

fn exigir_puede_aportar(env: &Env, m: &Miembro) {
    if m.estado == EstadoMiembro::Moroso {
        panic_with_error!(env, Error::MiembroExcluido);
    }
}

fn exigir_no_aporto(env: &Env, id: u32, turno: u32, addr: &Address) {
    if aporte_de(env, id, turno, addr) != 0 {
        panic_with_error!(env, Error::YaAporto);
    }
}

/// Anota el aporte del turno en curso y suma al pozo. El excedente de la
/// etiqueta cross-chain queda en el pozo, no se devuelve.
fn registrar_aporte(env: &Env, r: &mut Ronda, id: u32, m: &mut Miembro, monto: i128) {
    let clave = Clave::Aporte(id, r.turno, m.addr.clone());
    env.storage().persistent().set(&clave, &monto);
    extender(env, &clave);

    m.aportado += monto;
    guardar_miembro(env, id, m);

    r.pozo += monto;
    guardar_ronda(env, id, r);

    AporteAcreditado {
        ronda: id,
        miembro: m.addr.clone(),
        monto,
        turno: r.turno,
    }
    .publish(env);
}

/// Cuántos miembros llegaron a cobrar. Solo para el evento de cierre.
fn turnos_pagados(env: &Env, id: u32, r: &Ronda) -> u32 {
    let mut n = 0u32;
    for i in 0..r.orden.len() {
        if leer_miembro(env, id, &r.orden.get_unchecked(i)).estado == EstadoMiembro::Cobro {
            n += 1;
        }
    }
    n
}

/// Primer miembro activo desde el turno en curso. `None` si no queda ninguno.
fn indice_beneficiario(env: &Env, id: u32, r: &Ronda) -> Option<u32> {
    if r.estado != EstadoRonda::EnCurso {
        return None;
    }
    let n = r.orden.len();
    let mut i = r.turno;
    while i < n {
        let addr = r.orden.get_unchecked(i);
        if leer_miembro(env, id, &addr).estado == EstadoMiembro::Activo {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Devuelve a cada aportante lo que puso en el turno en curso. Se usa cuando la
/// ronda se cierra sin que quede nadie con derecho a cobrar.
fn reembolsar_turno(env: &Env, r: &mut Ronda, id: u32) {
    if r.pozo == 0 {
        return;
    }
    let cliente = token::Client::new(env, &r.token);
    let contrato = env.current_contract_address();
    let n = r.orden.len();
    for i in 0..n {
        let addr = r.orden.get_unchecked(i);
        let monto = aporte_de(env, id, r.turno, &addr);
        if monto > 0 {
            cliente.transfer(&contrato, &addr, &monto);
            let mut m = leer_miembro(env, id, &addr);
            m.aportado -= monto;
            guardar_miembro(env, id, &m);
            Reembolsado {
                ronda: id,
                miembro: addr,
                monto,
                turno: r.turno,
            }
            .publish(env);
        }
    }
    r.pozo = 0;
}

mod test;
