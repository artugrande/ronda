#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Env,
};

#[allow(clippy::inconsistent_digit_grouping)]
/// 100 unidades con 7 decimales.
const CIEN: i128 = 100_0000000;
#[allow(clippy::inconsistent_digit_grouping)]
const FONDEO: i128 = 10_000_0000000;

const SEMANA: u64 = 604_800;
/// 10% anual en el mock, para que el rendimiento sea fácil de verificar a mano.
const TASA_BPS: i128 = 1_000;

struct Mesa {
    env: Env,
    pozo: Address,
    token: Address,
    keeper: Address,
    cuentas: Vec<Address>,
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
            // ~5s por ledger, para que las ventanas de commit sean realistas.
            x.sequence_number = l + (segundos / 5) as u32 + 1;
        });
    }
    /// Avanza solo ledgers, sin mover el reloj. Para la ventana del commit.
    fn ledgers(&self, n: u32) {
        let l = self.env.ledger().sequence();
        self.env.ledger().with_mut(|x| x.sequence_number = l + n);
    }
    fn secreto(&self, b: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[b; 32])
    }
    fn hash(&self, s: &BytesN<32>) -> BytesN<32> {
        self.env
            .crypto()
            .sha256(&Bytes::from_array(&self.env, &s.to_array()))
            .to_bytes()
    }
    /// Cierra la ronda: commitea, espera la ventana y sortea.
    fn sortear(&self, b: u8) -> Address {
        let s = self.secreto(b);
        self.c().comprometer_sorteo(&self.hash(&s));
        self.ledgers(ESPERA_LEDGERS);
        self.c().ejecutar_sorteo(&s)
    }
}

fn montar(n: u32) -> Mesa {
    let env = Env::default();
    // El pozo autoriza su propia llamada a la fuente con
    // `authorize_as_current_contract`, y eso anida un require_auth que
    // `mock_all_auths()` rechaza por no ser raíz.
    env.mock_all_auths_allowing_non_root_auth();
    // Arrancar lejos de cero: el mock devenga sobre timestamps absolutos.
    env.ledger().with_mut(|l| {
        l.timestamp = 1_700_000_000;
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

    let admin = Address::generate(&env);
    let keeper = Address::generate(&env);
    let pozo = env.register(Contract, ());
    ContractClient::new(&env, &pozo).inicializar(&admin, &keeper, &token, &fuente, &SEMANA);

    Mesa {
        env,
        pozo,
        token,
        keeper,
        cuentas,
    }
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

    let ganador = mesa.sortear(1);

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

    let ganador = mesa.sortear(1);
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
    mesa.sortear(1);

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
// El sorteo: commit-reveal
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn no_se_cierra_una_ronda_en_curso() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA / 2);
    mesa.c().comprometer_sorteo(&mesa.hash(&mesa.secreto(1)));
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn un_secreto_que_no_corresponde_no_sortea() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);

    c.comprometer_sorteo(&mesa.hash(&mesa.secreto(1)));
    mesa.ledgers(ESPERA_LEDGERS);
    // Revela otro: el keeper no puede cambiar de idea después de commitear.
    c.ejecutar_sorteo(&mesa.secreto(2));
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn no_se_sortea_en_el_mismo_ledger_del_commit() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);

    let s = mesa.secreto(1);
    c.comprometer_sorteo(&mesa.hash(&s));
    // Sin esperar: la semilla saldría de un transaction-set que el keeper ya
    // podía estar viendo al commitear.
    mesa.ledgers(ESPERA_LEDGERS - 1);
    c.ejecutar_sorteo(&s);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn un_commit_viejo_vence() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);

    let s = mesa.secreto(1);
    c.comprometer_sorteo(&mesa.hash(&s));
    // Guardarse un commit para usarlo en una ronda que convenga no se puede.
    mesa.ledgers(EXPIRA_LEDGERS + 1);
    c.ejecutar_sorteo(&s);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn no_se_sortea_sin_commit() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    mesa.c().ejecutar_sorteo(&mesa.secreto(1));
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn no_se_commitea_dos_veces() {
    let mesa = montar(2);
    let c = mesa.c();
    c.depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    c.comprometer_sorteo(&mesa.hash(&mesa.secreto(1)));
    c.comprometer_sorteo(&mesa.hash(&mesa.secreto(2)));
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn no_se_sortea_un_pozo_vacio() {
    let mesa = montar(2);
    mesa.avanzar(SEMANA);
    mesa.c().comprometer_sorteo(&mesa.hash(&mesa.secreto(1)));
}

#[test]
fn depositar_despues_del_commit_no_cambia_esa_ronda() {
    let mesa = montar(3);
    let c = mesa.c();

    c.depositar(&mesa.u(0), &CIEN);
    c.depositar(&mesa.u(1), &CIEN);
    mesa.avanzar(SEMANA);

    let s = mesa.secreto(1);
    c.comprometer_sorteo(&mesa.hash(&s));
    let congelado = c.estado();

    // Entra alguien nuevo con el commit ya puesto.
    c.depositar(&mesa.u(2), &(CIEN * 100));
    mesa.ledgers(ESPERA_LEDGERS);
    let ganador = c.ejecutar_sorteo(&s);

    assert!(
        ganador != mesa.u(2),
        "el que entró después del cierre no puede ganar esa ronda"
    );
    assert!(congelado.hay_commit);
}

#[test]
fn el_sorteo_es_reproducible_desde_lo_que_queda_on_chain() {
    // Mismo secreto, mismos depósitos y mismos tiempos -> mismo ganador. Es lo
    // que permite que cualquiera recompute el sorteo y lo verifique.
    let corrida = || {
        let mesa = montar(4);
        let c = mesa.c();
        for i in 0..4u32 {
            c.depositar(&mesa.u(i), &(CIEN * (i as i128 + 1)));
        }
        mesa.avanzar(SEMANA);
        let ganador = mesa.sortear(7);
        (0..4u32).find(|i| mesa.u(*i) == ganador).unwrap()
    };
    assert_eq!(corrida(), corrida());
}

#[test]
fn secretos_distintos_dan_ganadores_distintos() {
    // Con la misma configuración, cambiar solo el secreto tiene que poder
    // cambiar el ganador: si no, el secreto no está entrando en la semilla.
    let con = |b: u8| {
        let mesa = montar(8);
        let c = mesa.c();
        for i in 0..8u32 {
            c.depositar(&mesa.u(i), &CIEN);
        }
        mesa.avanzar(SEMANA);
        let g = mesa.sortear(b);
        (0..8u32).find(|i| mesa.u(*i) == g).unwrap()
    };
    let ganadores: Vec<u32> = {
        let env = Env::default();
        let mut v = Vec::new(&env);
        for b in 1..=12u8 {
            v.push_back(con(b));
        }
        v
    };
    let primero = ganadores.get_unchecked(0);
    assert!(
        (0..ganadores.len()).any(|i| ganadores.get_unchecked(i) != primero),
        "cambiar el secreto nunca cambió el ganador: no está en la semilla"
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

    for ronda in 0..3u8 {
        mesa.avanzar(SEMANA);
        assert_eq!(c.estado().ronda, ronda as u32);
        let premio = c.estado().premio;
        assert!(premio > 0, "la ronda {ronda} tiene que haber generado algo");
        mesa.sortear(ronda + 1);
        assert_eq!(c.estado().premio, 0, "el premio se pagó entero");
    }

    assert_eq!(c.estado().ronda, 3);
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
    let ganador = mesa.sortear(1);
    assert_eq!(ganador, mesa.u(0));
    assert!(mesa.saldo(0) > FONDEO - CIEN);
    assert_eq!(c.saldo(&mesa.u(0)), CIEN, "el capital sigue intacto");
}

#[test]
fn la_vista_trae_lo_que_muestra_la_pantalla() {
    let mesa = montar(3);
    let c = mesa.c();

    let v = c.estado();
    assert_eq!(v.participantes, 0);
    assert_eq!(v.principal, 0);
    assert_eq!(v.premio, 0);
    assert_eq!(v.apy_bps, None, "sin capital no hay APY que mostrar");

    for i in 0..3u32 {
        c.depositar(&mesa.u(i), &CIEN);
    }
    mesa.avanzar(SEMANA);

    let v = c.estado();
    assert_eq!(v.participantes, 3);
    assert_eq!(v.principal, CIEN * 3);
    assert!(v.premio > 0);
    assert_eq!(v.periodo, SEMANA);
    assert!(!v.hay_commit);

    // El APY que reporta tiene que parecerse al que configuramos en el mock.
    let apy = v.apy_bps.unwrap();
    assert!(
        (apy - TASA_BPS).abs() < 50,
        "APY reportado {apy} vs {TASA_BPS} configurado"
    );
}

#[test]
fn el_keeper_es_el_unico_que_cierra() {
    let mesa = montar(2);
    // Con mock_all_auths no se puede probar el rechazo, pero sí que la
    // autorización pedida es la del keeper y no la de cualquiera.
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.avanzar(SEMANA);
    mesa.c().comprometer_sorteo(&mesa.hash(&mesa.secreto(1)));

    let auths = mesa.env.auths();
    assert_eq!(
        auths.first().map(|(a, _)| a.clone()),
        Some(mesa.keeper.clone())
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn no_se_retira_mas_de_lo_depositado() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.c().retirar(&mesa.u(0), &(CIEN + 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn un_extraño_no_retira() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &CIEN);
    mesa.c().retirar(&mesa.u(1), &CIEN);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn no_se_deposita_cero() {
    let mesa = montar(2);
    mesa.c().depositar(&mesa.u(0), &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn no_se_inicializa_dos_veces() {
    let mesa = montar(2);
    let cfg = mesa.c().config();
    mesa.c()
        .inicializar(&cfg.admin, &cfg.keeper, &cfg.token, &cfg.fuente, &SEMANA);
}
