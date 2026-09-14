#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Env};

#[allow(clippy::inconsistent_digit_grouping)]
const CIEN: i128 = 100_0000000;

struct Mesa {
    env: Env,
    adapter: Address,
    token: Address,
    pool: Address,
    dueno: Address,
}

fn montar() -> Mesa {
    let env = Env::default();
    // `mock_all_auths()` a secas, a propósito: es el único modo que exige que
    // el transfer anidado que hace el pool en nombre del adapter esté cubierto
    // por `authorize_as_current_contract`. El modo `allowing_non_root_auth`
    // lo daría por autorizado y escondería un árbol mal armado.
    env.mock_all_auths();

    let emisor = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(emisor).address();
    let blend = testutils::desplegar(&env, &token);

    let admin = Address::generate(&env);
    let adapter = env.register(Contract, (admin.clone(), blend.pool.clone(), token.clone()));
    // El "pozo" de este test es una cuenta cualquiera con tokens.
    let dueno = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token).mint(&dueno, &(CIEN * 10));
    ContractClient::new(&env, &adapter).fijar_dueno(&dueno);

    Mesa {
        env,
        adapter,
        token,
        pool: blend.pool,
        dueno,
    }
}

#[test]
fn el_deposito_llega_al_pool_como_supply() {
    let mesa = montar();
    let c = ContractClient::new(&mesa.env, &mesa.adapter);
    let tk = token::Client::new(&mesa.env, &mesa.token);

    c.depositar(&mesa.dueno, &CIEN);

    assert_eq!(tk.balance(&mesa.dueno), CIEN * 9, "salió de la cuenta");
    assert_eq!(tk.balance(&mesa.adapter), 0, "no se quedó en el adapter");
    assert_eq!(tk.balance(&mesa.pool), CIEN, "está en el pool");

    // La posición es Supply, no colateral: no puede liquidarse.
    let pos = pool::Client::new(&mesa.env, &mesa.pool).get_positions(&mesa.adapter);
    assert_eq!(pos.supply.len(), 1);
    assert_eq!(pos.collateral.len(), 0);
    assert_eq!(pos.liabilities.len(), 0);
}

#[test]
fn el_balance_es_el_capital_recien_depositado() {
    // Con la reserva recién creada b_rate vale exactamente 1.0, así que el
    // balance tiene que ser el capital: eso valida la escala de 12 decimales.
    let mesa = montar();
    let c = ContractClient::new(&mesa.env, &mesa.adapter);
    assert_eq!(c.balance(&mesa.dueno), 0);
    c.depositar(&mesa.dueno, &CIEN);
    assert_eq!(c.balance(&mesa.dueno), CIEN);
}

#[test]
fn retirar_devuelve_exactamente_lo_pedido() {
    let mesa = montar();
    let c = ContractClient::new(&mesa.env, &mesa.adapter);
    let tk = token::Client::new(&mesa.env, &mesa.token);

    c.depositar(&mesa.dueno, &CIEN);
    c.retirar(&mesa.dueno, &(CIEN / 4));
    assert_eq!(
        tk.balance(&mesa.dueno),
        CIEN * 9 + CIEN / 4,
        "recibe exacto lo que pidió, sin polvo de redondeo"
    );
    // Un stroop menos en la posición: es el que quedó en el adapter como
    // fondo de polvo, y vuelve en el retiro siguiente.
    assert_eq!(c.balance(&mesa.dueno), CIEN - CIEN / 4 - 1);

    c.retirar(&mesa.dueno, &(CIEN - CIEN / 4));
    assert_eq!(tk.balance(&mesa.dueno), CIEN * 10, "sale todo el capital");
    assert_eq!(c.balance(&mesa.dueno), 0);
}

#[test]
fn retirar_manda_los_tokens_directo_al_destino() {
    let mesa = montar();
    let c = ContractClient::new(&mesa.env, &mesa.adapter);
    let tk = token::Client::new(&mesa.env, &mesa.token);
    c.depositar(&mesa.dueno, &CIEN);

    // El pozo pasa su propia dirección como destino y después le paga al
    // usuario él mismo; acá se verifica que el pool entregue donde se le dice.
    let otro = Address::generate(&mesa.env);
    c.retirar(&otro, &CIEN);
    assert_eq!(tk.balance(&otro), CIEN);
    // El stroop de más que se le pide al pool en cada retiro parcial queda
    // como fondo de polvo. Acá el retiro fue total: el pool entregó lo que
    // había y no sobró nada.
    assert_eq!(tk.balance(&mesa.adapter), 0);
}

#[test]
fn el_balance_de_un_extraño_es_cero() {
    let mesa = montar();
    let c = ContractClient::new(&mesa.env, &mesa.adapter);
    c.depositar(&mesa.dueno, &CIEN);
    assert_eq!(c.balance(&Address::generate(&mesa.env)), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn un_extraño_no_deposita_en_la_posicion_del_dueno() {
    let mesa = montar();
    let intruso = Address::generate(&mesa.env);
    token::StellarAssetClient::new(&mesa.env, &mesa.token).mint(&intruso, &CIEN);
    ContractClient::new(&mesa.env, &mesa.adapter).depositar(&intruso, &CIEN);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn el_dueno_se_fija_una_sola_vez() {
    let mesa = montar();
    ContractClient::new(&mesa.env, &mesa.adapter).fijar_dueno(&Address::generate(&mesa.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn sin_dueno_no_se_deposita() {
    let env = Env::default();
    env.mock_all_auths();
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let blend = testutils::desplegar(&env, &token);
    let adapter = env.register(
        Contract,
        (Address::generate(&env), blend.pool, token.clone()),
    );
    let alguien = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token).mint(&alguien, &CIEN);
    ContractClient::new(&env, &adapter).depositar(&alguien, &CIEN);
}

#[test]
fn un_retiro_parcial_deja_un_stroop_de_polvo_y_el_total_lo_usa() {
    let mesa = montar();
    let c = ContractClient::new(&mesa.env, &mesa.adapter);
    let tk = token::Client::new(&mesa.env, &mesa.token);
    c.depositar(&mesa.dueno, &CIEN);

    c.retirar(&mesa.dueno, &(CIEN / 2));
    assert_eq!(
        tk.balance(&mesa.dueno),
        CIEN * 9 + CIEN / 2,
        "recibe exactamente lo pedido"
    );
    assert_eq!(
        tk.balance(&mesa.adapter),
        1,
        "el stroop de más queda como fondo"
    );
    // La posición quedó un stroop abajo; el fondo lo compensa. `balance` mira
    // solo la posición, así el fondo nunca se cuenta como premio y no se va
    // en un sorteo.
    assert_eq!(c.balance(&mesa.dueno), CIEN / 2 - 1);

    // Retiro total: el pool entrega lo que queda (un stroop menos que lo
    // pedido) y el fondo cubre la diferencia.
    c.retirar(&mesa.dueno, &(CIEN / 2));
    assert_eq!(tk.balance(&mesa.dueno), CIEN * 10, "sale todo el capital");
    assert_eq!(c.balance(&mesa.dueno), 0);
    assert_eq!(tk.balance(&mesa.adapter), 0, "el fondo se usó");
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn sin_fondo_de_polvo_un_retiro_corto_falla_claro() {
    // Si el pool entrega menos que el monto y el adapter no tiene nada
    // guardado, el error dice qué pasó en vez de un "balance is not
    // sufficient" del token.
    let mesa = montar();
    let c = ContractClient::new(&mesa.env, &mesa.adapter);
    c.depositar(&mesa.dueno, &CIEN);
    c.retirar(&mesa.dueno, &(CIEN / 2));
    // Un stroop de fondo, y la posición vale CIEN/2 − 1: pedir CIEN/2 + 1 da
    // CIEN/2 − 1 del pool más el fondo = CIEN/2. Pedir CIEN/2 + 1 falla.
    c.retirar(&mesa.dueno, &(CIEN / 2 + 1));
}
