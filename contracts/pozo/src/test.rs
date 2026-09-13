#![cfg(test)]

use super::*;
use soroban_sdk::{
    crypto::bls12_381::Bls12381Fr,
    testutils::{Address as _, Ledger as _},
    token, Env, Vec, U256,
};

#[allow(clippy::inconsistent_digit_grouping)]
/// 100 unidades con 7 decimales.
const CIEN: i128 = 100_0000000;
#[allow(clippy::inconsistent_digit_grouping)]
const FONDEO: i128 = 10_000_0000000;

const SEMANA: u64 = 604_800;
/// 10% anual en el mock, para que el rendimiento sea fácil de verificar a mano.
const TASA_BPS: i128 = 1_000;

/// Parámetros de un drand de mentira que controlan los tests. Mismo período
/// que quicknet; el génesis coincide con el arranque del reloj del test.
const ARRANQUE: u64 = 1_700_000_000;
const DRAND_PERIODO: u64 = 3;

struct Mesa {
    env: Env,
    pozo: Address,
    token: Address,
    cuentas: Vec<Address>,
    /// La clave secreta del "drand" de este test.
    sk: Bls12381Fr,
}

impl Mesa {
    fn c(&self) -> ContractClient<'_> {
        ContractClient::new(&self.env, &self.pozo)
    }
    fn token(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.token)
    }
    fn u(&self, i: u32) -> Address {
        self.cuentas.get_unchecked(i)
    }
    fn saldo(&self, i: u32) -> i128 {
        self.token().balance(&self.u(i))
    }
    fn avanzar(&self, segundos: u64) {
        let t = self.env.ledger().timestamp();
        let l = self.env.ledger().sequence();
        self.env.ledger().with_mut(|x| {
            x.timestamp = t + segundos;
            x.sequence_number = l + (segundos / 5) as u32 + 1;
        });
    }
    /// Firma una ronda como lo haría drand: `sk · H(sha256(be64(ronda)))`.
    fn firmar(&self, ronda: u64) -> BytesN<96> {
        firmar_con(&self.env, &self.sk, ronda)
    }
    /// Cierra la ronda, "espera" a que drand publique, y sortea.
    fn sortear(&self) -> Address {
        let ronda_drand = self.c().cerrar_ronda();
        // drand publica la ronda cuando llega su momento; acá alcanza con
        // dejar pasar el margen.
        self.avanzar(MARGEN_SEGUNDOS + DRAND_PERIODO);
        self.c().ejecutar_sorteo(&self.firmar(ronda_drand))
    }
}

fn escalar(env: &Env, n: u32) -> Bls12381Fr {
    Bls12381Fr::from_u256(U256::from_u32(env, n))
}

fn pk_de(env: &Env, sk: &Bls12381Fr) -> BytesN<192> {
    env.crypto()
        .bls12_381()
        .g2_mul(&drand::generador_g2(env), sk)
        .to_bytes()
}

fn firmar_con(env: &Env, sk: &Bls12381Fr, ronda: u64) -> BytesN<96> {
    let bls = env.crypto().bls12_381();
    let h = bls.hash_to_g1(
        &drand::mensaje(env, ronda),
        &Bytes::from_slice(env, drand::DST),
    );
    bls.g1_mul(&h, sk).to_bytes()
}

fn montar_con_clave(n: u32, semilla_sk: u32) -> Mesa {
    let env = Env::default();
    // `mock_all_auths()` a secas, a propósito. La fuente mueve tokens del pozo
    // un nivel más abajo, y este es el único modo de test que exige que ese
    // transfer esté cubierto por `authorize_as_current_contract`. Con
    // `mock_all_auths_allowing_non_root_auth()` el árbol mal armado que llegó
    // a testnet pasaba todos los tests.
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = ARRANQUE;
        l.sequence_number = 1_000;
    });

    let emisor = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(emisor).address();
    let acuñador = token::StellarAssetClient::new(&env, &token);

    let mut cuentas = Vec::new(&env);
    for _ in 0..n {
        let a = Address::generate(&env);
        acuñador.mint(&a, &FONDEO);
        cuentas.push_back(a);
    }

    // La fuente de rendimiento necesita fondos para poder pagar el interés que
    // devenga: es el equivalente a que el mercado tenga con qué.
    let fuente = env.register(mock_rendimiento::MockRendimiento, ());
    mock_rendimiento::MockRendimientoClient::new(&env, &fuente).inicializar(&token, &TASA_BPS);
    acuñador.mint(&fuente, &FONDEO);

    let sk = escalar(&env, semilla_sk);
    let pk = pk_de(&env, &sk);
    let pozo = env.register(
        Contract,
        (
            token.clone(),
            fuente.clone(),
            SEMANA,
            pk,
            ARRANQUE,
            DRAND_PERIODO,
        ),
    );

    Mesa {
        env,
        pozo,
        token,
        cuentas,
        sk,
    }
}

fn montar(n: u32) -> Mesa {
    montar_con_clave(n, 7)
}

// ---------------------------------------------------------------------------
// Lo que define el producto: nadie pierde capital
// ---------------------------------------------------------------------------

#[test]
fn el_que_pierde_conserva_todo_su_capital() {
    let mesa = montar(3);
    let c = mesa.c();

    for i in 0..3u32 {
        c.depositar(&mesa.u(i), &CIEN);
    }
    mesa.avanzar(SEMANA);

    let ganador = mesa.sortear();

    for i in 0..3u32 {
        let u = mesa.u(i);
        assert_eq!(
            c.saldo(&u),
            CIEN,
            "el capital no se toca, gane o pierda quien gane"
        );
        if u != ganador {
            assert_eq!(
                mesa.saldo(i),
                FONDEO - CIEN,
                "el que no gana queda exactamente como entró"
            );
        }
    }
}

#[test]
fn el_ganador_se_lleva_todo_el_rendimiento() {
    let mesa = montar(3);
    let c = mesa.c();

    for i in 0..3u32 {
        c.depositar(&mesa.u(i), &CIEN);
    }
    mesa.avanzar(SEMANA);

    let premio_esperado = c.estado().premio;
    assert!(premio_esperado > 0, "una semana al 10% anual genera algo");

    let ganador = mesa.sortear();
    let i = (0..3u32).find(|i| mesa.u(*i) == ganador).unwrap();

    assert_eq!(
        mesa.saldo(i),
        FONDEO - CIEN + premio_esperado,
        "el ganador recibe el rendimiento entero, sin tocar su capital"
    );
    assert_eq!(c.saldo(&ganador), CIEN, "su capital sigue en el pozo");
}

#[test]
fn el_capital_se_puede_retirar_siempre() {
    let mesa = montar(2);
    let c = mesa.c();

    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA / 2);

    // Sin penalidad y sin esperar al cierre: el producto se apoya en que salir
    // es libre.
    c.retirar(&mesa.u(0), &CIEN);
    assert_eq!(mesa.saldo(0), FONDEO);
    assert_eq!(c.saldo(&mesa.u(0)), 0);
    assert_eq!(c.estado().principal, 0);
}

#[test]
fn se_puede_retirar_una_parte() {
    let mesa = montar(2);
    let c = mesa.c();

    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA / 2);
    c.retirar(&mesa.u(0), &(CIEN / 4));

    assert_eq!(c.saldo(&mesa.u(0)), CIEN - CIEN / 4);
    assert_eq!(mesa.saldo(0), FONDEO - CIEN + CIEN / 4);
}

#[test]
fn el_capital_sale_aunque_haya_un_sorteo_pendiente() {
    // Lo que garantiza que ningún sorteo trabado pueda atrapar plata: retirar
    // no mira si hay una ronda cerrada esperando.
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    c.cerrar_ronda();

    c.retirar(&mesa.u(0), &CIEN);
    assert_eq!(mesa.saldo(0), FONDEO, "el capital sale igual");
}

#[test]
fn retirar_entre_el_cierre_y_el_sorteo_no_toca_el_premio() {
    // El premio y las chances quedaron congelados al cerrar. Que alguien
    // saque su capital después no cambia quién gana ni cuánto.
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    c.depositar(&mesa.u(1), &CIEN);
    mesa.avanzar(SEMANA);

    let ronda_drand = c.cerrar_ronda();
    let premio = c.estado().premio;
    assert!(premio > 0);

    c.retirar(&mesa.u(1), &CIEN);
    mesa.avanzar(MARGEN_SEGUNDOS + DRAND_PERIODO);
    let ganador = c.ejecutar_sorteo(&mesa.firmar(ronda_drand));

    let i = (0..2u32).find(|i| mesa.u(*i) == ganador).unwrap();
    let esperado = if i == 1 { FONDEO } else { FONDEO - CIEN } + premio;
    assert_eq!(mesa.saldo(i), esperado, "cobra el premio congelado entero");
    assert_eq!(c.estado().principal, CIEN);
}

// ---------------------------------------------------------------------------
// El peso: depósito × tiempo
// ---------------------------------------------------------------------------

#[test]
fn el_que_deposita_al_final_casi_no_tiene_chances() {
    let mesa = montar(2);
    let c = mesa.c();

    // Uno estuvo toda la semana; el otro entra un minuto antes del cierre con
    // diez veces más plata.
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA - 60);
    c.depositar(&mesa.u(1), &(CIEN * 10));
    mesa.avanzar(60);

    let temprano = c.chances_bps(&mesa.u(0));
    let tardio = c.chances_bps(&mesa.u(1));

    assert!(
        temprano > tardio * 5,
        "el que generó el rendimiento tiene que pesar mucho más: {temprano} vs {tardio}"
    );
    // Cada chance se trunca hacia abajo por separado, así que la suma queda
    // hasta (participantes - 1) puntos corta. Nunca por encima: nadie puede
    // mostrar más probabilidad de la que tiene.
    let suma = temprano + tardio;
    assert!(
        (9_999..=10_000).contains(&suma),
        "las chances tienen que sumar el total salvo el truncamiento: {suma}"
    );
}

#[test]
fn a_igual_tiempo_las_chances_son_proporcionales_al_monto() {
    let mesa = montar(2);
    let c = mesa.c();

    c.depositar(&mesa.u(0), &CIEN);
    c.depositar(&mesa.u(1), &(CIEN * 3));
    mesa.avanzar(SEMANA);

    // 1:3 -> 2500 / 7500 bps.
    assert_eq!(c.chances_bps(&mesa.u(0)), 2_500);
    assert_eq!(c.chances_bps(&mesa.u(1)), 7_500);
}

#[test]
fn el_peso_se_reinicia_en_cada_ronda() {
    let mesa = montar(2);
    let c = mesa.c();

    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    // El segundo entra recién al final de la primera ronda.
    c.depositar(&mesa.u(1), &CIEN);
    mesa.sortear();

    // Arrancada la ronda nueva, el tiempo acumulado en la anterior no cuenta.
    mesa.avanzar(SEMANA);
    assert_eq!(c.chances_bps(&mesa.u(0)), 5_000);
    assert_eq!(c.chances_bps(&mesa.u(1)), 5_000);
}

#[test]
fn retirar_conserva_el_peso_ya_generado() {
    let mesa = montar(2);
    let c = mesa.c();

    c.depositar(&mesa.u(0), &CIEN);
    c.depositar(&mesa.u(1), &CIEN);
    mesa.avanzar(SEMANA);

    // Retira todo al final: su plata igual estuvo generando toda la semana, así
    // que no pierde las chances que ya devengó.
    c.retirar(&mesa.u(0), &CIEN);
    assert!(
        c.chances_bps(&mesa.u(0)) > 4_000,
        "el tiempo ya cumplido no se borra al salir"
    );
}

// ---------------------------------------------------------------------------
// La verificación BLS, sola
// ---------------------------------------------------------------------------

#[test]
fn el_generador_g2_esta_en_la_curva_y_en_el_subgrupo() {
    // Los 192 bytes del generador están tipeados a mano en drand.rs. Una cadena
    // de 384 bits al azar no cae en la curva, así que esto detecta cualquier
    // error de transcripción.
    let env = Env::default();
    let bls = env.crypto().bls12_381();
    let gen = drand::generador_g2(&env);
    assert!(bls.g2_is_on_curve(&gen), "no está en la curva");
    assert!(bls.g2_is_in_subgroup(&gen), "no está en el subgrupo");
}

#[test]
fn bls_acepta_la_firma_legitima_y_rechaza_el_resto() {
    let env = Env::default();
    // Fuera de una invocación de contrato el presupuesto no se renueva entre
    // llamadas, y tres pairings seguidos se pasan del de una transacción. En
    // el contrato cada sorteo es su propia transacción; ver el test de costo.
    env.cost_estimate().budget().reset_unlimited();
    let sk = escalar(&env, 42);
    let pk = pk_de(&env, &sk);

    let buena = firmar_con(&env, &sk, 1000);
    assert!(
        drand::verificar(&env, &pk, 1000, &buena),
        "la firma legítima verifica"
    );

    // Misma clave, otra ronda.
    assert!(!drand::verificar(&env, &pk, 1001, &buena));

    // Otra clave, misma ronda.
    let otra = firmar_con(&env, &escalar(&env, 43), 1000);
    assert!(!drand::verificar(&env, &pk, 1000, &otra));
}

#[test]
fn ninguna_operacion_crece_con_la_cantidad_de_cuentas() {
    // Lo que hace que esto escale: depositar, retirar y sortear tocan
    // LOG_CAPACIDAD nodos del árbol cada uno, sea que haya diez cuentas o un
    // millón. Se mide el costo de cada operación con el pozo chico y con
    // muchas cuentas más, y tiene que ser el mismo dentro de un margen. El
    // sorteo además se compara con el límite de CPU por transacción de la red.
    extern crate std;
    const LIMITE_CPU_RED: u64 = 100_000_000;
    // Alcanza con que sean muchas más que las que caben en el camino del
    // descenso: los nodos tocados son los mismos con 10 que con un millón, lo
    // que cambia es cuántos existen. Mil mantiene el test bajo el minuto.
    const MUCHAS: u32 = 1_000;

    let mesa = montar(0);
    let c = mesa.c();
    let mut budget = mesa.env.cost_estimate().budget();
    let acuñador = token::StellarAssetClient::new(&mesa.env, &mesa.token);
    let nueva = || {
        let a = Address::generate(&mesa.env);
        acuñador.mint(&a, &(CIEN * 2));
        a
    };

    // Lo que la red cobra de verdad es el footprint: cuántas entradas y cuántos
    // bytes lee y escribe la transacción. Eso es lo que tiene que quedar igual.
    //
    // Las instrucciones que reporta el harness NO sirven para comparar entre
    // tamaños: el host de tests guarda el ledger entero en un mapa medido y le
    // cobra a cada acceso la búsqueda sobre todas las entradas que existen.
    // En la red la transacción declara sus claves y el host carga exactamente
    // esas; no hay búsqueda que pagar. Se imprimen igual, como cota superior.
    struct Medida {
        cpu: i64,
        mem: i64,
        lecturas: u32,
        escrituras: u32,
    }
    // Recursos de la última invocación, tal como los vería la red.
    let medir = || {
        let r = mesa.env.cost_estimate().resources();
        Medida {
            cpu: r.instructions,
            mem: r.mem_bytes,
            lecturas: r.disk_read_entries + r.memory_read_entries,
            escrituras: r.write_entries,
        }
    };

    // Un depósito y un retiro con el pozo casi vacío.
    let a0 = nueva();
    budget.reset_default();
    c.depositar(&a0, &CIEN);
    let dep_chico = medir();
    budget.reset_default();
    c.retirar(&a0, &(CIEN / 2));
    let ret_chico = medir();

    // Muchas cuentas más. Son muchas transacciones distintas; acá se levanta
    // el límite solo para el armado.
    budget.reset_unlimited();
    for _ in 0..MUCHAS {
        c.depositar(&nueva(), &CIEN);
    }
    assert_eq!(c.estado().participantes, MUCHAS + 1);

    let a1 = nueva();
    budget.reset_default();
    c.depositar(&a1, &CIEN);
    let dep_grande = medir();
    budget.reset_default();
    c.retirar(&a1, &(CIEN / 2));
    let ret_grande = medir();

    mesa.avanzar(SEMANA);
    budget.reset_unlimited();
    let ronda_drand = c.cerrar_ronda();
    mesa.avanzar(MARGEN_SEGUNDOS + DRAND_PERIODO);
    let firma = mesa.firmar(ronda_drand);

    // El sorteo, bajo el presupuesto real de una transacción.
    budget.reset_default();
    c.ejecutar_sorteo(&firma);
    let sorteo = medir();

    let linea = |q: &str, m: &Medida| {
        std::println!(
            "{q:<28} {:>3} lecturas {:>3} escrituras {:>10} instr {:>9} B mem",
            m.lecturas,
            m.escrituras,
            m.cpu,
            m.mem
        );
    };
    linea("depositar, 1 cuenta", &dep_chico);
    linea("depositar, 1001 cuentas", &dep_grande);
    linea("retirar, 1 cuenta", &ret_chico);
    linea("retirar, 1001 cuentas", &ret_grande);
    linea("ejecutar_sorteo, 1001", &sorteo);

    // El footprint está acotado por una constante que no depende de cuántas
    // cuentas haya: a lo sumo LOG_CAPACIDAD + 1 nodos del árbol (el índice 1
    // es el peor caso, está en los 21 niveles; los demás en menos) más un
    // puñado fijo de entradas: la cuenta, su dirección, la instancia, los
    // saldos del token y la fuente. Por eso con más cuentas puede tocar
    // MENOS entradas, nunca más que la cota.
    const NODOS: u32 = LOG_CAPACIDAD + 1;
    const COTA_ESCRITURAS: u32 = NODOS + 12;
    const COTA_LECTURAS: u32 = NODOS + 16;
    for (q, m) in [
        ("depositar chico", &dep_chico),
        ("depositar grande", &dep_grande),
        ("retirar chico", &ret_chico),
        ("retirar grande", &ret_grande),
    ] {
        assert!(
            m.escrituras <= COTA_ESCRITURAS,
            "{q}: {} escrituras",
            m.escrituras
        );
        assert!(m.lecturas <= COTA_LECTURAS, "{q}: {} lecturas", m.lecturas);
    }
    // El sorteo desciende LOG_CAPACIDAD nodos y escribe casi nada.
    assert!(
        sorteo.lecturas <= NODOS + 10,
        "sorteo: {} lecturas",
        sorteo.lecturas
    );
    assert!(
        sorteo.escrituras <= 8,
        "sorteo: {} escrituras",
        sorteo.escrituras
    );
    // Y aun con el medidor pesimista del harness, todo entra en una transacción.
    for (q, m) in [
        ("depositar", &dep_grande),
        ("retirar", &ret_grande),
        ("sorteo", &sorteo),
    ] {
        assert!(
            (m.cpu as u64) < LIMITE_CPU_RED,
            "{q} no entra en una transacción: {} >= {LIMITE_CPU_RED}",
            m.cpu
        );
    }
}

#[test]
fn la_capacidad_es_un_millon() {
    assert_eq!(CAPACIDAD, 1_048_576);
    assert_eq!(1u32 << LOG_CAPACIDAD, CAPACIDAD);
}

#[test]
fn el_indice_no_se_reusa_y_una_cuenta_vacia_sigue_pudiendo_ganar() {
    // Retirar todo al final de la ronda no borra el peso ya devengado: la
    // cuenta queda con depósito 0 pero sus chances de esa ronda siguen, y si
    // gana cobra igual. Es la promesa de "la plata estuvo generando".
    let mesa = montar(1);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    c.retirar(&mesa.u(0), &CIEN);
    assert_eq!(
        c.estado().participantes,
        0,
        "sin capital no cuenta como activa"
    );
    assert!(
        c.chances_bps(&mesa.u(0)) > 9_000,
        "pero el peso devengado sigue"
    );

    let ganador = mesa.sortear();
    assert_eq!(ganador, mesa.u(0));
    assert!(
        mesa.saldo(0) > FONDEO,
        "cobró el premio con el capital ya afuera"
    );
}

#[test]
fn un_participante_pasivo_pesa_desde_el_inicio_de_cada_ronda() {
    // Nadie tiene que "renovar" nada: el que deposita una vez y no vuelve a
    // tocar la cuenta pesa en cada ronda desde su inicio. Es lo que garantiza
    // la versión perezosa de `b` en los nodos.
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    c.depositar(&mesa.u(1), &CIEN);
    mesa.avanzar(SEMANA);
    mesa.sortear();

    // Ronda nueva: la cuenta 1 vuelve a tocar (retira y redeposita), la 0 no.
    mesa.avanzar(SEMANA / 2);
    c.retirar(&mesa.u(1), &CIEN);
    c.depositar(&mesa.u(1), &CIEN);
    mesa.avanzar(SEMANA / 2);

    // Las dos estuvieron con el mismo capital todo el tiempo: mismas chances.
    let p0 = c.chances_bps(&mesa.u(0));
    let p1 = c.chances_bps(&mesa.u(1));
    assert!((p0 - p1).abs() <= 1, "pasivo {p0} vs activo {p1}");
}

#[test]
fn ronda_en_sigue_el_reloj_de_drand() {
    // Ronda 1 en el génesis, una nueva cada período; antes del génesis nada.
    assert_eq!(drand::ronda_en(100, 3, 99), 0);
    assert_eq!(drand::ronda_en(100, 3, 100), 1);
    assert_eq!(drand::ronda_en(100, 3, 102), 1);
    assert_eq!(drand::ronda_en(100, 3, 103), 2);
    assert_eq!(drand::ronda_en(100, 3, 100 + 3 * 200), 201);
}

// ---------------------------------------------------------------------------
// El sorteo
// ---------------------------------------------------------------------------

#[test]
fn la_ronda_de_drand_queda_en_el_futuro() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);

    let ahora = mesa.env.ledger().timestamp();
    let fijada = c.cerrar_ronda();
    let vigente = drand::ronda_en(ARRANQUE, DRAND_PERIODO, ahora);

    assert!(
        fijada >= vigente + MARGEN_SEGUNDOS / DRAND_PERIODO,
        "la firma de esa ronda no puede existir todavía: {fijada} vs vigente {vigente}"
    );
    assert_eq!(c.estado().ronda_drand, Some(fijada));
    assert!(c.estado().sorteo_pendiente);
}

#[test]
fn cerrar_y_sortear_no_piden_permiso_a_nadie() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);

    let ronda_drand = c.cerrar_ronda();
    assert!(
        mesa.env.auths().is_empty(),
        "cerrar no exige la firma de ninguna cuenta"
    );

    mesa.avanzar(MARGEN_SEGUNDOS + DRAND_PERIODO);
    c.ejecutar_sorteo(&mesa.firmar(ronda_drand));
    assert!(
        mesa.env.auths().is_empty(),
        "sortear tampoco: no hay keeper que pueda desaparecer"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn no_se_cierra_una_ronda_en_curso() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA / 2);
    mesa.c().cerrar_ronda();
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn la_firma_de_otra_ronda_no_sortea() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);

    let ronda_drand = c.cerrar_ronda();
    mesa.avanzar(MARGEN_SEGUNDOS + DRAND_PERIODO);
    // Una firma legítima de drand, pero de la ronda siguiente: no es la que se
    // fijó al cerrar, así que no decide nada.
    c.ejecutar_sorteo(&mesa.firmar(ronda_drand + 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn la_firma_de_otra_clave_no_sortea() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);

    let ronda_drand = c.cerrar_ronda();
    mesa.avanzar(MARGEN_SEGUNDOS + DRAND_PERIODO);
    // Alguien que no es drand firma la ronda correcta con su propia clave.
    let impostor = escalar(&mesa.env, 99);
    c.ejecutar_sorteo(&firmar_con(&mesa.env, &impostor, ronda_drand));
}

#[test]
#[should_panic]
fn una_firma_basura_no_sortea() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    c.cerrar_ronda();
    mesa.avanzar(MARGEN_SEGUNDOS + DRAND_PERIODO);
    // Ni siquiera es un punto de la curva. El host lo rechaza antes de que
    // el contrato llegue a emparejar.
    c.ejecutar_sorteo(&BytesN::from_array(&mesa.env, &[7u8; 96]));
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn no_se_sortea_sin_cierre() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    mesa.c().ejecutar_sorteo(&mesa.firmar(1));
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn no_se_cierra_dos_veces() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    c.cerrar_ronda();
    c.cerrar_ronda();
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn no_se_cierra_un_pozo_vacio() {
    let mesa = montar(2);
    mesa.avanzar(SEMANA);
    mesa.c().cerrar_ronda();
}

#[test]
fn una_ronda_que_vencio_vacia_arranca_con_el_primero_que_entra() {
    let mesa = montar(2);
    let c = mesa.c();

    // Nadie entra durante toda la semana: la ronda vence vacía.
    mesa.avanzar(SEMANA + 3_600);
    c.depositar(&mesa.u(0), &CIEN);

    // No se cierra al instante: el reloj arrancó con el depósito.
    let v = c.estado();
    assert_eq!(v.cierra_at, mesa.env.ledger().timestamp() + SEMANA);
    let r = c.try_cerrar_ronda();
    assert!(r.is_err(), "la ronda recién arrancó, no puede cerrarse");

    mesa.avanzar(SEMANA);
    c.depositar(&mesa.u(1), &CIEN);
    assert!(
        c.chances_bps(&mesa.u(0)) > 9_900,
        "el primero tuvo la semana entera; el segundo entró al final"
    );
    mesa.sortear();
}

#[test]
fn el_reloj_no_se_reinicia_si_alguien_ya_tiene_peso() {
    let mesa = montar(2);
    let c = mesa.c();

    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA / 2);
    // Sale con todo: capital cero, pero media semana de peso devengado.
    c.retirar(&mesa.u(0), &CIEN);
    let cierra = c.estado().cierra_at;

    c.depositar(&mesa.u(1), &CIEN);
    assert_eq!(
        c.estado().cierra_at,
        cierra,
        "el pozo está vacío pero alguien ya devengó peso: la ronda sigue"
    );
    mesa.avanzar(SEMANA / 2);
    assert_eq!(c.chances_bps(&mesa.u(0)), 5_000);
    assert_eq!(c.chances_bps(&mesa.u(1)), 5_000);
}

#[test]
fn depositar_despues_del_cierre_no_cambia_esa_ronda() {
    let mesa = montar(3);
    let c = mesa.c();

    c.depositar(&mesa.u(0), &CIEN);
    c.depositar(&mesa.u(1), &CIEN);
    mesa.avanzar(SEMANA);

    let ronda_drand = c.cerrar_ronda();

    // Entra alguien nuevo con la ronda ya cerrada, con cien veces más plata.
    c.depositar(&mesa.u(2), &(CIEN * 100));
    mesa.avanzar(MARGEN_SEGUNDOS + DRAND_PERIODO);
    let ganador = c.ejecutar_sorteo(&mesa.firmar(ronda_drand));

    assert!(
        ganador != mesa.u(2),
        "el que entró después del cierre no puede ganar esa ronda"
    );
}

#[test]
fn el_sorteo_es_reproducible_desde_lo_que_queda_on_chain() {
    // Misma firma, mismos depósitos y mismos tiempos -> mismo ganador. Es lo
    // que permite que cualquiera recompute el sorteo y lo verifique.
    let corrida = || {
        let mesa = montar(4);
        let c = mesa.c();
        for i in 0..4u32 {
            c.depositar(&mesa.u(i), &(CIEN * (i as i128 + 1)));
        }
        mesa.avanzar(SEMANA);
        let ganador = mesa.sortear();
        (0..4u32).find(|i| mesa.u(*i) == ganador).unwrap()
    };
    assert_eq!(corrida(), corrida());
}

#[test]
fn firmas_distintas_dan_ganadores_distintos() {
    // Con todo lo demás igual, cambiar solo la firma de drand tiene que poder
    // cambiar el ganador: si no, la firma no está entrando en la semilla. Se
    // simula con beacons de clave distinta.
    let con = |clave: u32| {
        let mesa = montar_con_clave(8, clave);
        let c = mesa.c();
        for i in 0..8u32 {
            c.depositar(&mesa.u(i), &CIEN);
        }
        mesa.avanzar(SEMANA);
        let g = mesa.sortear();
        (0..8u32).find(|i| mesa.u(*i) == g).unwrap()
    };
    let primero = con(1);
    assert!(
        (2..=12u32).any(|k| con(k) != primero),
        "cambiar la firma nunca cambió el ganador: no está en la semilla"
    );
}

// ---------------------------------------------------------------------------
// Rondas encadenadas y vista
// ---------------------------------------------------------------------------

#[test]
fn el_pozo_sigue_generando_ronda_tras_ronda() {
    let mesa = montar(3);
    let c = mesa.c();

    for i in 0..3u32 {
        c.depositar(&mesa.u(i), &CIEN);
    }

    for ronda in 1..=3u32 {
        mesa.avanzar(SEMANA);
        assert_eq!(c.estado().ronda, ronda);
        let premio = c.estado().premio;
        assert!(premio > 0, "la ronda {ronda} tiene que haber generado algo");
        mesa.sortear();
    }

    assert_eq!(c.estado().ronda, 4);
    assert_eq!(c.estado().principal, CIEN * 3, "el capital nunca se movió");
}

#[test]
fn adelantar_el_mock_genera_premio_sin_esperar() {
    // La palanca de la demo: mostrar un premio real sin esperar una semana.
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    assert_eq!(c.estado().premio, 0);

    mock_rendimiento::MockRendimientoClient::new(&mesa.env, &c.config().fuente)
        .adelantar(&mesa.pozo, &SEMANA);

    let premio = c.estado().premio;
    assert!(premio > 0, "adelantar el reloj de la fuente genera premio");

    // Y ese premio se puede sortear y cobrar de verdad, no es solo cosmético.
    mesa.avanzar(SEMANA);
    let ganador = mesa.sortear();
    assert_eq!(ganador, mesa.u(0));
    assert!(mesa.saldo(0) > FONDEO - CIEN);
    assert_eq!(c.saldo(&mesa.u(0)), CIEN, "el capital sigue intacto");
}

#[test]
fn la_vista_trae_lo_que_muestra_la_pantalla() {
    let mesa = montar(3);
    let c = mesa.c();

    let v = c.estado();
    assert_eq!(v.ronda, 1, "las rondas arrancan en 1; el 0 es 'nunca'");
    assert_eq!(v.participantes, 0);
    assert_eq!(v.principal, 0);
    assert_eq!(v.premio, 0);
    assert_eq!(v.apy_bps, None, "sin capital no hay APY que mostrar");
    assert!(!v.sorteo_pendiente);
    assert_eq!(v.ronda_drand, None);

    for i in 0..3u32 {
        c.depositar(&mesa.u(i), &CIEN);
    }
    mesa.avanzar(SEMANA);

    let v = c.estado();
    assert_eq!(v.participantes, 3);
    assert_eq!(v.principal, CIEN * 3);
    assert!(v.premio > 0);
    assert_eq!(v.periodo, SEMANA);

    // El APY que reporta tiene que parecerse al que configuramos en el mock.
    let apy = v.apy_bps.unwrap();
    assert!(
        (apy - TASA_BPS).abs() < 50,
        "APY reportado {apy} vs {TASA_BPS} configurado"
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn no_se_retira_mas_de_lo_depositado() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.c().retirar(&mesa.u(0), &(CIEN + 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn un_extraño_no_retira() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.c().retirar(&mesa.u(1), &CIEN);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn no_se_deposita_cero() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &0);
}

// ---------------------------------------------------------------------------
// Con Blend de verdad como fuente
// ---------------------------------------------------------------------------

/// El pozo contra el adapter de Blend y el pool real de Blend v2, en vez del
/// mock. Prueba que los tres árboles de autorización anidados —usuario → pozo,
/// pozo → adapter, adapter → pool— componen, y que el capital vuelve entero.
#[test]
fn el_pozo_funciona_con_blend_como_fuente() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = ARRANQUE;
        l.sequence_number = 1_000;
    });

    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let acuñador = token::StellarAssetClient::new(&env, &token);
    let blend = blend_adapter::testutils::desplegar(&env, &token);

    // adapter → pozo → fijar_dueno(pozo): el pozo se construye apuntando al
    // adapter, así que el adapter conoce al pozo recién después.
    let admin = Address::generate(&env);
    let adapter = env.register(
        blend_adapter::Contract,
        (admin.clone(), blend.pool.clone(), token.clone()),
    );
    let sk = escalar(&env, 7);
    let pozo = env.register(
        Contract,
        (
            token.clone(),
            adapter.clone(),
            SEMANA,
            pk_de(&env, &sk),
            ARRANQUE,
            DRAND_PERIODO,
        ),
    );
    blend_adapter::ContractClient::new(&env, &adapter).fijar_dueno(&pozo);

    let c = ContractClient::new(&env, &pozo);
    let tk = token::Client::new(&env, &token);
    let ana = Address::generate(&env);
    let beto = Address::generate(&env);
    acuñador.mint(&ana, &FONDEO);
    acuñador.mint(&beto, &FONDEO);

    c.depositar(&ana, &CIEN);
    c.depositar(&beto, &(CIEN * 3));
    assert_eq!(c.estado().principal, CIEN * 4);
    assert_eq!(c.estado().participantes, 2);
    assert_eq!(
        tk.balance(&blend.pool),
        CIEN * 4,
        "todo el capital está en Blend"
    );
    assert_eq!(tk.balance(&pozo), 0);
    assert_eq!(tk.balance(&adapter), 0);

    // Sin nadie que pida prestado, Blend no genera: el premio es 0 y el
    // sorteo no puede pagar más que eso. El capital, intacto.
    assert_eq!(c.estado().premio, 0);

    c.retirar(&ana, &CIEN);
    assert_eq!(tk.balance(&ana), FONDEO, "ana recupera todo, exacto");
    c.retirar(&beto, &(CIEN * 3));
    assert_eq!(tk.balance(&beto), FONDEO, "beto también");
    assert_eq!(c.estado().principal, 0);
    assert_eq!(tk.balance(&blend.pool), 0);
}
