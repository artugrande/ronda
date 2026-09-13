//! Verificación de beacons de drand sobre BLS12-381.
//!
//! drand (League of Entropy) es un beacon público de aleatoriedad: ~20
//! organizaciones independientes producen, con una firma BLS umbral, un valor
//! por ronda que nadie conoce antes de que se publique y que cualquiera puede
//! verificar con la clave pública del grupo. Es la fuente de azar que ningún
//! validador de Stellar controla, porque no vive en Stellar.
//!
//! Se usa la red **quicknet**: esquema `bls-unchained-g1-rfc9380`, una ronda
//! cada 3 segundos. "Unchained" significa que la firma de la ronda `r` cubre
//! solo `sha256(be64(r))` y no depende de la anterior, así que se puede
//! verificar sola.
//!
//! Verificación BLS con firma en G1 y clave en G2:
//!
//! ```text
//! e(firma, G2) == e(H(msg), pk)   ⟺   e(firma, G2) · e(−H(msg), pk) == 1
//! ```
//!
//! que es la forma que toma `pairing_check`.
//!
//! Los puntos van **sin comprimir** (96 bytes G1, 192 bytes G2): el host de
//! Soroban no descomprime. drand los sirve comprimidos, así que el que trae la
//! firma la descomprime off-chain — el contrato verifica que el punto esté en
//! la curva y en el subgrupo correcto, que es lo único que importa para que la
//! verificación sea sólida.

use soroban_sdk::{
    bytesn,
    crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine},
    vec, Bytes, BytesN, Env,
};

/// Domain separation tag de hash-to-curve para el esquema de quicknet.
pub const DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

/// Ronda de drand vigente en el instante `t` (Unix, segundos).
///
/// Ronda 1 sale en `genesis`; después una por `periodo`. Antes del génesis no
/// hay rondas.
pub fn ronda_en(genesis: u64, periodo: u64, t: u64) -> u64 {
    if t < genesis || periodo == 0 {
        return 0;
    }
    (t - genesis) / periodo + 1
}

/// Mensaje que firma drand para una ronda: `sha256(be64(ronda))`.
pub fn mensaje(env: &Env, ronda: u64) -> Bytes {
    let h = env
        .crypto()
        .sha256(&Bytes::from_array(env, &ronda.to_be_bytes()));
    Bytes::from_array(env, &h.to_array())
}

/// Generador estándar de G2 de BLS12-381, sin comprimir, en el layout del
/// host: `be(X_c1) || be(X_c0) || be(Y_c1) || be(Y_c0)`.
///
/// Es una constante pública de la curva (la misma que usan zkcrypto, arkworks
/// y el draft de la IETF). Hay un test que verifica que está en la curva y en
/// el subgrupo: un error de tipeo en cualquiera de los 192 bytes falla ahí.
pub fn generador_g2(env: &Env) -> Bls12381G2Affine {
    Bls12381G2Affine::from_bytes(bytesn!(
        env,
        0x13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801
    ))
}

/// `true` si `firma` es la firma BLS de drand para `ronda` bajo `pk`.
///
/// Rechaza puntos fuera del subgrupo antes de emparejar: sin eso, un punto de
/// un subgrupo chico podría satisfacer la ecuación sin conocer la clave.
pub fn verificar(env: &Env, pk: &BytesN<192>, ronda: u64, firma: &BytesN<96>) -> bool {
    let bls = env.crypto().bls12_381();

    let firma = Bls12381G1Affine::from_bytes(firma.clone());
    if !bls.g1_is_in_subgroup(&firma) {
        return false;
    }
    let pk = Bls12381G2Affine::from_bytes(pk.clone());
    if !bls.g2_is_in_subgroup(&pk) {
        return false;
    }

    let h = bls.hash_to_g1(&mensaje(env, ronda), &Bytes::from_slice(env, DST));

    bls.pairing_check(vec![env, firma, -h], vec![env, generador_g2(env), pk])
}
