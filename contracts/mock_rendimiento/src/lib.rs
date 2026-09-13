#![no_std]

//! Fuente de rendimiento de mentira, para tests y demo.
//!
//! Implementa la misma interfaz mínima que va a implementar el adapter real de
//! Blend, así que el pozo no sabe con cuál está hablando:
//!
//! ```text
//! depositar(de: Address, monto: i128)
//! retirar(a: Address, monto: i128)
//! balance(de: Address) -> i128     // capital + rendimiento devengado
//! ```
//!
//! El rendimiento acá se devenga a una tasa fija que se configura, en vez de
//! salir de un mercado. Es lo que permite testear el sorteo sin depender de
//! que Blend ande — el equivalente al `MockAavePool.sol` de la versión EVM.

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Map};

#[contracttype]
pub enum Clave {
    Token,
    /// Puntos básicos de rendimiento por año. 1000 = 10% anual.
    TasaBps,
    /// Capital depositado por cada cuenta, sin el rendimiento.
    Principal,
    /// Cuándo se devengó por última vez, por cuenta.
    Desde,
}

const SEGUNDOS_ANIO: i128 = 31_536_000;
const BPS: i128 = 10_000;

#[contract]
pub struct MockRendimiento;

#[contractimpl]
impl MockRendimiento {
    pub fn inicializar(env: Env, token: Address, tasa_bps: i128) {
        env.storage().instance().set(&Clave::Token, &token);
        env.storage().instance().set(&Clave::TasaBps, &tasa_bps);
    }

    pub fn depositar(env: Env, de: Address, monto: i128) {
        de.require_auth();
        let token: Address = env.storage().instance().get(&Clave::Token).unwrap();
        token::Client::new(&env, &token).transfer(&de, env.current_contract_address(), &monto);

        // Devengar lo acumulado hasta ahora antes de mover el capital, si no el
        // depósito nuevo cobraría intereses desde el principio del anterior.
        let devengado = Self::balance(env.clone(), de.clone());
        Self::fijar(&env, &de, devengado + monto);
    }

    pub fn retirar(env: Env, a: Address, monto: i128) {
        let devengado = Self::balance(env.clone(), a.clone());
        if monto > devengado {
            panic!("no alcanza el balance");
        }
        Self::fijar(&env, &a, devengado - monto);

        let token: Address = env.storage().instance().get(&Clave::Token).unwrap();
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &a, &monto);
    }

    /// Capital más el rendimiento devengado desde el último movimiento.
    pub fn balance(env: Env, de: Address) -> i128 {
        let principal = Self::leer(&env, &Clave::Principal, &de);
        if principal == 0 {
            return 0;
        }
        let desde = Self::leer(&env, &Clave::Desde, &de) as u64;
        let transcurrido = (env.ledger().timestamp().saturating_sub(desde)) as i128;
        let tasa: i128 = env.storage().instance().get(&Clave::TasaBps).unwrap_or(0);

        principal + principal * tasa * transcurrido / (BPS * SEGUNDOS_ANIO)
    }

    /// Solo para la demo: mueve el reloj del rendimiento hacia atrás para que
    /// se pueda mostrar un premio sin esperar una semana real.
    pub fn adelantar(env: Env, cuenta: Address, segundos: u64) {
        let desde = Self::leer(&env, &Clave::Desde, &cuenta) as u64;
        let mut mapa: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&Clave::Desde)
            .unwrap_or(Map::new(&env));
        mapa.set(cuenta, desde.saturating_sub(segundos) as i128);
        env.storage().instance().set(&Clave::Desde, &mapa);
    }

    fn fijar(env: &Env, quien: &Address, monto: i128) {
        let mut principal: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&Clave::Principal)
            .unwrap_or(Map::new(env));
        principal.set(quien.clone(), monto);
        env.storage().instance().set(&Clave::Principal, &principal);

        let mut desde: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&Clave::Desde)
            .unwrap_or(Map::new(env));
        desde.set(quien.clone(), env.ledger().timestamp() as i128);
        env.storage().instance().set(&Clave::Desde, &desde);
    }

    fn leer(env: &Env, clave: &Clave, quien: &Address) -> i128 {
        env.storage()
            .instance()
            .get::<_, Map<Address, i128>>(clave)
            .and_then(|m| m.get(quien.clone()))
            .unwrap_or(0)
    }
}
