//! Despliega un Blend v2 completo en el entorno de tests, con un pool activo y
//! una reserva para el token que se le pase. Portado del `BlendFixture` de
//! `blend-contract-sdk` (MIT), con nuestra `soroban-sdk`.
//!
//! Es lo que permite testear el adapter contra el protocolo real en vez de
//! contra una imitación.
//!
//! Los literales van en la notación de punto fijo de Blend (`0_7500000` es
//! 0,75 con 7 decimales), que clippy confunde con octal mal agrupado; y los
//! clientes generados por `contractimport!` tienen tantos argumentos como
//! diga el spec. Ninguna de las dos cosas es nuestra para cambiar.
#![allow(
    clippy::zero_prefixed_literal,
    clippy::inconsistent_digit_grouping,
    clippy::too_many_arguments
)]

use soroban_sdk::{
    testutils::{Address as _, BytesN as _},
    token::StellarAssetClient,
    vec, Address, BytesN, Env, String, Vec,
};

use crate::pool;

pub mod backstop {
    soroban_sdk::contractimport!(file = "blend/backstop.wasm");
}
pub mod emitter {
    soroban_sdk::contractimport!(file = "blend/emitter.wasm");
}
pub mod pool_factory {
    soroban_sdk::contractimport!(file = "blend/pool_factory.wasm");
}
pub mod comet {
    soroban_sdk::contractimport!(file = "blend/comet.wasm");
}

/// Un Blend desplegado, con un pool activo que tiene al `token` como reserva.
pub struct Blend {
    pub pool: Address,
    pub token: Address,
    pub deployer: Address,
}

/// Configuración de reserva "suficientemente buena" para tests, la misma del
/// SDK de Blend.
pub fn reserva_por_defecto() -> pool::ReserveConfig {
    pool::ReserveConfig {
        decimals: 7,
        c_factor: 0_7500000,
        l_factor: 0_7500000,
        util: 0_7500000,
        max_util: 0_9500000,
        r_base: 0_0100000,
        r_one: 0_0500000,
        r_two: 0_5000000,
        r_three: 1_5000000,
        reactivity: 0_0000020,
        index: 0,
        supply_cap: 100_000_000_0000000,
        enabled: true,
    }
}

/// Despliega emitter, backstop, comet y pool factory; crea un pool, le agrega
/// `token` como reserva, lo fondea en el backstop y lo activa.
///
/// Levanta el presupuesto mientras arma todo y lo vuelve al default al final.
pub fn desplegar(env: &Env, token: &Address) -> Blend {
    env.cost_estimate().budget().reset_unlimited();
    let deployer = Address::generate(env);

    let blnd = env
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();
    let usdc = env
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();

    let emitter = env.register(emitter::WASM, ());
    let backstop = Address::generate(env);
    let pool_factory = Address::generate(env);
    let comet = env.register(comet::WASM, ());

    let blnd_client = StellarAssetClient::new(env, &blnd);
    let usdc_client = StellarAssetClient::new(env, &usdc);
    blnd_client
        .mock_all_auths()
        .mint(&deployer, &(1_000_0000000 * 2001));
    usdc_client
        .mock_all_auths()
        .mint(&deployer, &(25_0000000 * 2001));

    let comet_client = comet::Client::new(env, &comet);
    comet_client.mock_all_auths().init(
        &deployer,
        &vec![env, blnd.clone(), usdc.clone()],
        &vec![env, 0_8000000, 0_2000000],
        &vec![env, 1_000_0000000, 25_0000000],
        &0_0030000,
    );
    comet_client.mock_all_auths().join_pool(
        &199_900_0000000,
        &vec![env, 1_000_0000000 * 2000, 25_0000000 * 2000],
        &deployer,
    );

    blnd_client.mock_all_auths().set_admin(&emitter);
    emitter::Client::new(env, &emitter)
        .mock_all_auths()
        .initialize(&blnd, &backstop, &comet);

    env.register_at(
        &backstop,
        backstop::WASM,
        (
            comet,
            emitter,
            blnd.clone(),
            usdc,
            pool_factory.clone(),
            Vec::<(Address, i128)>::new(env),
        ),
    );

    let pool_hash = env.deployer().upload_contract_wasm(pool::WASM);
    env.register_at(
        &pool_factory,
        pool_factory::WASM,
        (pool_factory::PoolInitMeta {
            backstop: backstop.clone(),
            blnd_id: blnd,
            pool_hash,
        },),
    );

    // El oráculo no se consulta para posiciones de Supply sin deuda, así que
    // una dirección cualquiera alcanza.
    let pool = pool_factory::Client::new(env, &pool_factory)
        .mock_all_auths()
        .deploy(
            &deployer,
            &String::from_str(env, "pozo"),
            &BytesN::<32>::random(env),
            &Address::generate(env),
            &0_1000000,
            &4,
            &1_0000000,
        );

    let pool_client = pool::Client::new(env, &pool);
    pool_client
        .mock_all_auths()
        .queue_set_reserve(token, &reserva_por_defecto());
    pool_client.mock_all_auths().set_reserve(token);

    backstop::Client::new(env, &backstop)
        .mock_all_auths()
        .deposit(&deployer, &pool, &50_000_0000000);
    pool_client.mock_all_auths().set_status(&3);
    pool_client.mock_all_auths().update_status();

    env.cost_estimate().budget().reset_default();

    Blend {
        pool,
        token: token.clone(),
        deployer,
    }
}
