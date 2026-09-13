#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token, vec, Env, IntoVal,
};

// Los montos se agrupan como <unidades>_<7 decimales> para que se lean en la
// misma escala en que los maneja Stellar, no en miles.
#[allow(clippy::inconsistent_digit_grouping)]
/// 100 unidades con 7 decimales. El 7º decimal en cero, como exige el contrato.
const MONTO: i128 = 100_0000000;
#[allow(clippy::inconsistent_digit_grouping)]
const FONDEO: i128 = 10_000_0000000;
const PERIODO: u64 = 86_400;

struct Mesa {
    env: Env,
    id: Address,
    token: Address,
    oraculo: Address,
    miembros: Vec<Address>,
}

impl Mesa {
    fn cliente(&self) -> ContractClient<'_> {
        ContractClient::new(&self.env, &self.id)
    }

    fn token(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.token)
    }

    fn m(&self, i: u32) -> Address {
        self.miembros.get_unchecked(i)
    }

    fn saldo(&self, i: u32) -> i128 {
        self.token().balance(&self.m(i))
    }

    /// Deja pasar un período completo.
    fn avanzar(&self) {
        let t = self.env.ledger().timestamp();
        self.env.ledger().with_mut(|l| l.timestamp = t + PERIODO);
    }

    /// Simula la llegada de USDT0 al contrato desde otra cadena.
    fn llega_oft(&self, monto: i128) {
        token::StellarAssetClient::new(&self.env, &self.token).mint(&self.id, &monto);
    }
}

fn montar(n: u32) -> (Mesa, u32) {
    let env = Env::default();
    env.mock_all_auths();

    let emisor = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(emisor);
    let token = sac.address();
    let acuñador = token::StellarAssetClient::new(&env, &token);

    let mut miembros = Vec::new(&env);
    for _ in 0..n {
        let a = Address::generate(&env);
        acuñador.mint(&a, &FONDEO);
        miembros.push_back(a);
    }

    let oraculo = Address::generate(&env);
    let id = env.register(Contract, ());
    let ronda_id =
        ContractClient::new(&env, &id).crear_ronda(&oraculo, &token, &miembros, &MONTO, &PERIODO);

    (
        Mesa {
            env,
            id,
            token,
            oraculo,
            miembros,
        },
        ronda_id,
    )
}

// ---------------------------------------------------------------------------
// Camino feliz
// ---------------------------------------------------------------------------

#[test]
fn ronda_completa_todos_al_dia() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    for turno in 0..3u32 {
        for i in 0..3u32 {
            c.acreditar(&r, &mesa.m(i));
        }
        assert_eq!(c.estado(&r).pozo, 3 * MONTO);

        mesa.avanzar();
        let (quien, cuanto) = c.ejecutar_turno(&r).unwrap();
        assert_eq!(quien, mesa.m(turno), "cobra el titular del turno {turno}");
        assert_eq!(cuanto, 3 * MONTO);
    }

    // Tres turnos, tres aportes cada uno: todos vuelven a cero.
    for i in 0..3u32 {
        assert_eq!(mesa.saldo(i), FONDEO, "miembro {i} queda como empezó");
    }
    assert_eq!(mesa.token().balance(&mesa.id), 0, "el contrato no retiene");
    assert_eq!(c.estado(&r).estado, EstadoRonda::Finalizada);
}

#[test]
fn estado_reporta_pendientes_y_beneficiario() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    let v = c.estado(&r);
    assert_eq!(v.turno, 0);
    assert_eq!(v.beneficiario, Some(mesa.m(0)));
    assert_eq!(v.pendientes.len(), 3);

    c.acreditar(&r, &mesa.m(1));
    let v = c.estado(&r);
    assert_eq!(v.pozo, MONTO);
    assert_eq!(v.pendientes, vec![&mesa.env, mesa.m(0), mesa.m(2)]);
    assert_eq!(v.miembros.get_unchecked(1).aportado, MONTO);
}

// ---------------------------------------------------------------------------
// Atribución cross-chain
// ---------------------------------------------------------------------------

#[test]
fn etiqueta_va_en_el_sexto_decimal() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    let etiquetado = c.registrar_intencion(&r, &mesa.m(0));

    assert!(etiquetado > MONTO, "la etiqueta suma polvo sobre el monto");
    assert_eq!(
        etiquetado % PASO_ETIQUETA,
        0,
        "el 7º decimal tiene que ser cero: no viaja en el OFT"
    );
    let polvo = etiquetado - MONTO;
    assert!(
        polvo <= (MAX_ETIQUETA as i128) * PASO_ETIQUETA,
        "la etiqueta no puede desbordar a dígitos con valor"
    );
}

#[test]
fn etiquetas_distintas_por_miembro() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    let a = c.registrar_intencion(&r, &mesa.m(0));
    let b = c.registrar_intencion(&r, &mesa.m(1));
    let d = c.registrar_intencion(&r, &mesa.m(2));

    assert_ne!(a, b);
    assert_ne!(b, d);
    assert_ne!(a, d);
}

#[test]
fn intencion_es_idempotente() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    let primera = c.registrar_intencion(&r, &mesa.m(0));
    let segunda = c.registrar_intencion(&r, &mesa.m(0));
    assert_eq!(
        primera, segunda,
        "no se emite una etiqueta nueva por pedirla dos veces"
    );
    assert_eq!(c.intencion_de(&r, &mesa.m(0)), Some(primera));
}

#[test]
fn confirmar_oft_acredita_al_dueño_de_la_etiqueta() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    let etiquetado = c.registrar_intencion(&r, &mesa.m(2));
    mesa.llega_oft(etiquetado); // el USDT0 ya está en el contrato

    let guid = BytesN::from_array(&mesa.env, &[7u8; 32]);
    let acreditado = c.confirmar_oft(&r, &etiquetado, &guid);

    assert_eq!(acreditado, mesa.m(2), "machea por monto exacto");
    assert_eq!(c.estado(&r).pozo, etiquetado);
    assert_eq!(
        c.intencion_de(&r, &mesa.m(2)),
        None,
        "la etiqueta se libera al confirmar"
    );
    // No se le tocó el saldo en Stellar: los fondos vinieron de otra cadena.
    assert_eq!(mesa.saldo(2), FONDEO);
}

#[test]
fn la_etiqueta_no_se_reusa_en_el_turno_siguiente() {
    let (mesa, r) = montar(2);
    let c = mesa.cliente();

    let primera = c.registrar_intencion(&r, &mesa.m(0));
    mesa.llega_oft(primera);
    c.confirmar_oft(&r, &primera, &BytesN::from_array(&mesa.env, &[1u8; 32]));
    c.acreditar(&r, &mesa.m(1));

    mesa.avanzar();
    c.ejecutar_turno(&r);

    // Propiedad de seguridad: el contador no rebobina. Si una entrega lenta del
    // turno anterior llegara ahora con la etiqueta vieja, no puede acreditarse
    // a quien sea que haya pedido etiqueta después.
    let segunda = c.registrar_intencion(&r, &mesa.m(0));
    assert_ne!(
        segunda, primera,
        "una entrega atrasada no puede caer sobre una etiqueta reciclada"
    );

    let tercera = c.registrar_intencion(&r, &mesa.m(1));
    assert_ne!(tercera, primera);
    assert_ne!(tercera, segunda);
}

#[test]
#[should_panic]
fn solo_el_oraculo_confirma_un_oft() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    let etiquetado = c.registrar_intencion(&r, &mesa.m(0));
    mesa.llega_oft(etiquetado);
    let guid = BytesN::from_array(&mesa.env, &[9u8; 32]);

    // El propio miembro firma en lugar del oráculo: acreditarse solo sería
    // acreditarse sin que la plata haya llegado nunca.
    let impostor = mesa.m(0);
    assert_ne!(impostor, mesa.oraculo);
    c.mock_auths(&[MockAuth {
        address: &impostor,
        invoke: &MockAuthInvoke {
            contract: &mesa.id,
            fn_name: "confirmar_oft",
            args: (r, etiquetado, guid.clone()).into_val(&mesa.env),
            sub_invokes: &[],
        },
    }])
    .confirmar_oft(&r, &etiquetado, &guid);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn oft_sin_intencion_no_acredita() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    let huerfano = MONTO + 50 * PASO_ETIQUETA;
    mesa.llega_oft(huerfano);
    c.confirmar_oft(&r, &huerfano, &BytesN::from_array(&mesa.env, &[0u8; 32]));
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn una_entrega_corta_no_machea_ninguna_etiqueta() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    // Si el destino cobra una fee inesperada, llega menos que lo etiquetado.
    // Ese monto no machea nada y queda para que el oráculo lo resuelva a mano:
    // nunca se acredita de más ni se adivina el remitente.
    let etiquetado = c.registrar_intencion(&r, &mesa.m(0));
    let corto = etiquetado - PASO_ETIQUETA;
    mesa.llega_oft(corto);
    c.confirmar_oft(&r, &corto, &BytesN::from_array(&mesa.env, &[3u8; 32]));
}

// ---------------------------------------------------------------------------
// Morosos
// ---------------------------------------------------------------------------

#[test]
fn el_que_no_aporta_queda_moroso_y_pierde_el_turno() {
    let (mesa, r) = montar(4);
    let c = mesa.cliente();

    // Turno 0: aportan todos menos el índice 2.
    for i in [0u32, 1, 3] {
        c.acreditar(&r, &mesa.m(i));
    }
    mesa.avanzar();
    let (quien, cuanto) = c.ejecutar_turno(&r).unwrap();
    assert_eq!(quien, mesa.m(0));
    assert_eq!(
        cuanto,
        3 * MONTO,
        "el turno paga lo que se juntó, no el nominal"
    );

    let v = c.estado(&r);
    let moroso = v.miembros.get_unchecked(2);
    assert_eq!(moroso.estado, EstadoMiembro::Moroso);
    assert_eq!(
        moroso.incumplimientos, 1,
        "el incumplimiento queda on-chain"
    );

    // Turnos 1 y 2: sigue el resto. En el turno 2 el titular sería el moroso.
    for turno in 1..3u32 {
        for i in [0u32, 1, 3] {
            c.acreditar(&r, &mesa.m(i));
        }
        mesa.avanzar();
        let (quien, cuanto) = c.ejecutar_turno(&r).unwrap();
        assert_eq!(cuanto, 3 * MONTO);
        let esperado = if turno == 1 { 1 } else { 3 };
        assert_eq!(quien, mesa.m(esperado), "el turno {turno} saltea al moroso");
    }

    let v = c.estado(&r);
    assert_eq!(v.estado, EstadoRonda::Finalizada);
    assert_eq!(v.miembros.get_unchecked(2).cobrado, 0, "el moroso no cobra");
    // Los tres que cumplieron quedan a cero; el moroso nunca puso nada.
    for i in [0u32, 1, 3] {
        assert_eq!(mesa.saldo(i), FONDEO);
    }
    assert_eq!(mesa.saldo(2), FONDEO);
    assert_eq!(mesa.token().balance(&mesa.id), 0);
}

#[test]
fn el_moroso_pierde_lo_que_ya_habia_aportado() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    // Turno 0: aportan los tres. Cobra el 0.
    for i in 0..3u32 {
        c.acreditar(&r, &mesa.m(i));
    }
    mesa.avanzar();
    c.ejecutar_turno(&r);

    // Turno 1: el índice 2 abandona antes de que le toque cobrar.
    c.acreditar(&r, &mesa.m(0));
    c.acreditar(&r, &mesa.m(1));
    mesa.avanzar();
    let (quien, cuanto) = c.ejecutar_turno(&r).unwrap();
    assert_eq!(quien, mesa.m(1));
    assert_eq!(cuanto, 2 * MONTO);

    // Aportó un turno y nunca cobró: ese es el costo de abandonar.
    assert_eq!(mesa.saldo(2), FONDEO - MONTO);
    let v = c.estado(&r);
    assert_eq!(
        v.estado,
        EstadoRonda::Finalizada,
        "no queda nadie por cobrar"
    );
    assert_eq!(mesa.token().balance(&mesa.id), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn el_moroso_no_puede_seguir_aportando() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();

    c.acreditar(&r, &mesa.m(0));
    c.acreditar(&r, &mesa.m(1));
    mesa.avanzar();
    c.ejecutar_turno(&r);

    c.acreditar(&r, &mesa.m(2));
}

#[test]
fn si_no_queda_nadie_para_cobrar_se_reembolsa_el_turno() {
    let (mesa, r) = montar(2);
    let c = mesa.cliente();

    // Turno 0: solo aporta el 0, que además es el titular. El 1 queda moroso.
    c.acreditar(&r, &mesa.m(0));
    mesa.avanzar();
    let (quien, cuanto) = c.ejecutar_turno(&r).unwrap();
    assert_eq!(quien, mesa.m(0));
    assert_eq!(cuanto, MONTO);

    let v = c.estado(&r);
    assert_eq!(v.estado, EstadoRonda::Finalizada);
    assert_eq!(mesa.saldo(0), FONDEO, "cobró exactamente lo que puso");
    assert_eq!(mesa.saldo(1), FONDEO, "el moroso nunca puso nada");
    assert_eq!(mesa.token().balance(&mesa.id), 0, "no queda plata atrapada");
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn rechaza_monto_con_septimo_decimal() {
    let env = Env::default();
    env.mock_all_auths();
    let emisor = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(emisor).address();
    let id = env.register(Contract, ());

    let miembros = vec![&env, Address::generate(&env), Address::generate(&env)];
    // 100.0000001 — la etiqueta no sobreviviría al recorte del OFT.
    ContractClient::new(&env, &id).crear_ronda(
        &Address::generate(&env),
        &token,
        &miembros,
        &(MONTO + 1),
        &PERIODO,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn rechaza_miembro_duplicado() {
    let env = Env::default();
    env.mock_all_auths();
    let emisor = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(emisor).address();
    let id = env.register(Contract, ());

    let repetido = Address::generate(&env);
    let miembros = vec![&env, repetido.clone(), Address::generate(&env), repetido];
    ContractClient::new(&env, &id).crear_ronda(
        &Address::generate(&env),
        &token,
        &miembros,
        &MONTO,
        &PERIODO,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn no_se_aporta_dos_veces_al_mismo_turno() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();
    c.acreditar(&r, &mesa.m(0));
    c.acreditar(&r, &mesa.m(0));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn no_se_ejecuta_el_turno_antes_de_tiempo() {
    let (mesa, r) = montar(3);
    let c = mesa.cliente();
    c.acreditar(&r, &mesa.m(0));
    c.ejecutar_turno(&r);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn un_extraño_no_puede_aportar() {
    let (mesa, r) = montar(3);
    let intruso = Address::generate(&mesa.env);
    mesa.cliente().acreditar(&r, &intruso);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn ronda_inexistente() {
    let (mesa, _) = montar(3);
    mesa.cliente().estado(&999);
}

#[test]
fn el_aporte_exige_firma_del_miembro() {
    let (mesa, r) = montar(3);
    // Sin mock_all_auths no habría forma de firmar por otro; acá verificamos
    // que la autorización registrada sea la del propio miembro.
    mesa.cliente().acreditar(&r, &mesa.m(0));
    let auths = mesa.env.auths();
    assert_eq!(auths.first().map(|(a, _)| a.clone()), Some(mesa.m(0)));
}
