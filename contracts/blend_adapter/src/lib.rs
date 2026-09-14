#![no_std]

//! Adapter de Blend: la fuente de rendimiento real del pozo.
//!
//! Implementa la misma interfaz mínima que `mock_rendimiento`, así que el pozo
//! no distingue una de otra:
//!
//! ```text
//! depositar(de: Address, monto: i128)
//! retirar(a: Address, monto: i128)
//! balance(de: Address) -> i128     // capital + rendimiento devengado
//! ```
//!
//! Por detrás, el capital va como **Supply** (no colateral) a un pool de Blend
//! v2. Una posición de Supply pura genera el interés que pagan los que piden
//! prestado y no puede ser liquidada: no hay deuda ni oráculo en el camino.
//!
//! Los clientes y tipos de Blend salen de `contractimport!` sobre el WASM
//! oficial del pool (`blend/pool.wasm`, el que publica `blend-contract-sdk`).
//! No se usa ese crate como dependencia porque arrastra otra major de
//! `soroban-sdk` y dos majors no conviven en un contrato; el WASM, en cambio,
//! corre en el host sin importar con qué se compiló.
//!
//! ## El polvo de Blend
//!
//! Blend redondea hacia abajo los b-tokens que entrega al depositar, así que
//! una posición recién abierta vale hasta un stroop menos que lo depositado
//! hasta que el interés lo repone. Si `retirar` le pidiera al pool el monto
//! exacto y lo mandara derecho al destino, el pozo recibiría un stroop menos
//! de lo que prometió pagar y el retiro fallaría. (Pasó en mainnet, con XLM
//! al 0 %.)
//!
//! Por eso `retirar` le pide al pool **un stroop de más**, a nombre del
//! adapter, y de su propio saldo paga el monto exacto. Lo que sobra queda en
//! el adapter como fondo de polvo para el retiro siguiente. Si la posición no
//! alcanza para el stroop extra, Blend entrega lo que hay y el fondo cubre la
//! diferencia. Cualquiera puede sumarle al fondo con una transferencia común.
//!
//! ## Un dueño
//!
//! El adapter mantiene **una** posición, la de su dueño (el pozo). Se fija una
//! sola vez después del deploy, porque el pozo se construye apuntando al
//! adapter y el adapter no puede conocer la dirección del pozo antes de que
//! exista. Hasta que se fije, no acepta depósitos.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, vec, Address,
    Env, IntoVal, Symbol,
};

pub mod pool {
    // El cliente lo genera `contractimport!` desde el spec de Blend; la
    // cantidad de argumentos de `submit` y compañía no es decisión nuestra.
    #![allow(clippy::too_many_arguments)]
    soroban_sdk::contractimport!(file = "blend/pool.wasm");
}

#[cfg(any(test, feature = "testutils"))]
pub mod testutils;

/// `request_type` de Blend v2. No están en el spec del WASM porque el campo es
/// un `u32` pelado; los valores son los de `RequestType` en blend-contracts-v2.
pub const SUPPLY: u32 = 0;
pub const WITHDRAW: u32 = 1;

/// `b_rate` viene con 12 decimales en Blend v2.
pub const ESCALA_B_RATE: i128 = 1_000_000_000_000;

const BUMP_UMBRAL: u32 = 500_000;
const BUMP_EXTENSION: u32 = 518_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    SinDueno = 1,
    YaTieneDueno = 2,
    NoEsElDueno = 3,
    MontoInvalido = 4,
    /// El pool entregó menos que el monto y el fondo de polvo no cubre la
    /// diferencia. Se arregla mandándole un poco del token al adapter.
    PolvoInsuficiente = 5,
}

#[contracttype]
pub enum Clave {
    Admin,
    Pool,
    Token,
    Dueno,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// `admin` es quien después fija el dueño, una sola vez.
    pub fn __constructor(env: Env, admin: Address, pool: Address, token: Address) {
        let inst = env.storage().instance();
        inst.set(&Clave::Admin, &admin);
        inst.set(&Clave::Pool, &pool);
        inst.set(&Clave::Token, &token);
        inst.extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);
    }

    /// Fija el pozo como dueño de la posición. Una sola vez.
    pub fn fijar_dueno(env: Env, dueno: Address) {
        let admin: Address = env.storage().instance().get(&Clave::Admin).unwrap();
        admin.require_auth();
        if env.storage().instance().has(&Clave::Dueno) {
            panic_with_error!(&env, Error::YaTieneDueno);
        }
        env.storage().instance().set(&Clave::Dueno, &dueno);
        env.storage()
            .instance()
            .extend_ttl(BUMP_UMBRAL, BUMP_EXTENSION);
    }

    /// Recibe el capital del dueño y lo pone en Blend como Supply.
    pub fn depositar(env: Env, de: Address, monto: i128) {
        exigir_dueno(&env, &de);
        de.require_auth();
        if monto <= 0 {
            panic_with_error!(&env, Error::MontoInvalido);
        }
        let (pool, token) = config(&env);
        let yo = env.current_contract_address();

        token::Client::new(&env, &token).transfer(&de, &yo, &monto);

        // submit(from, spender, to, requests): `from` es la posición que se
        // toca, `spender` pone los tokens, `to` los recibe. Los tres somos
        // nosotros para un Supply. La llamada a `submit` no necesita
        // autorización (el que invoca autoriza), pero adentro el pool hace
        // token.transfer(yo, pool, monto) con nuestra autoridad, y ese
        // transfer es lo que hay que autorizar: va como raíz del árbol, no
        // colgando de `submit`. El host no consulta este árbol para el frame
        // directo, así que colgarlo de `submit` lo dejaría sin usar.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (yo.clone(), pool.clone(), monto).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        pool::Client::new(&env, &pool).submit(&yo, &yo, &yo, &pedidos(&env, SUPPLY, &token, monto));
    }

    /// Saca `monto` del pool y le manda exactamente `monto` a `a`. Solo el
    /// dueño. Ver "El polvo de Blend" arriba.
    pub fn retirar(env: Env, a: Address, monto: i128) {
        let dueno = dueno(&env);
        dueno.require_auth();
        if monto <= 0 {
            panic_with_error!(&env, Error::MontoInvalido);
        }
        let (pool, token) = config(&env);
        let yo = env.current_contract_address();

        // Un stroop de más, a nosotros. Si la posición no llega, Blend
        // entrega lo que hay. `to` somos nosotros, así que no hay transfer
        // anidado que autorizar: el pool nos paga con su propia autoridad.
        pool::Client::new(&env, &pool).submit(
            &yo,
            &yo,
            &yo,
            &pedidos(&env, WITHDRAW, &token, monto + 1),
        );

        let tk = token::Client::new(&env, &token);
        if tk.balance(&yo) < monto {
            panic_with_error!(&env, Error::PolvoInsuficiente);
        }
        tk.transfer(&yo, &a, &monto);
    }

    /// Capital más el rendimiento devengado: b-tokens × b_rate.
    ///
    /// `de` se ignora salvo para devolver 0 a quien no es el dueño: la posición
    /// es una sola.
    pub fn balance(env: Env, de: Address) -> i128 {
        match env.storage().instance().get::<_, Address>(&Clave::Dueno) {
            Some(d) if d == de => {}
            _ => return 0,
        }
        let (pool, token) = config(&env);
        let cliente = pool::Client::new(&env, &pool);
        let reserva = cliente.get_reserve(&token);
        let posiciones = cliente.get_positions(&env.current_contract_address());
        let b_tokens = posiciones.supply.get(reserva.config.index).unwrap_or(0);
        b_tokens * reserva.data.b_rate / ESCALA_B_RATE
    }

    pub fn dueno(env: Env) -> Option<Address> {
        env.storage().instance().get(&Clave::Dueno)
    }
}

fn pedidos(env: &Env, tipo: u32, token: &Address, monto: i128) -> soroban_sdk::Vec<pool::Request> {
    vec![
        env,
        pool::Request {
            request_type: tipo,
            address: token.clone(),
            amount: monto,
        },
    ]
}

fn config(env: &Env) -> (Address, Address) {
    let inst = env.storage().instance();
    (
        inst.get(&Clave::Pool).unwrap(),
        inst.get(&Clave::Token).unwrap(),
    )
}

fn dueno(env: &Env) -> Address {
    match env.storage().instance().get(&Clave::Dueno) {
        Some(d) => d,
        None => panic_with_error!(env, Error::SinDueno),
    }
}

fn exigir_dueno(env: &Env, quien: &Address) {
    if &dueno(env) != quien {
        panic_with_error!(env, Error::NoEsElDueno);
    }
}

mod test;
