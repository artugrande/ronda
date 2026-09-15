# Zorrito

**Prize-linked savings on Stellar. Nobody loses. One person wins the yield.**

You put money into a shared pool. The pool lends it on Blend and earns
interest. Once a week, one participant wins the interest everyone generated.
Everybody else keeps exactly what they put in, and can withdraw at any time.

- **App:** https://stellar.zorrito.app
- **How it works:** https://stellar.zorrito.app/docs
- **Testnet playground** (10-minute rounds): https://stellar.zorrito.app/test

Built for the **Argentina Builder Challenge** (BAF × Stellar), Genesis track.
Live on Stellar mainnet with real money since September 2026.

---

## What it does

1. **Deposit USDC.** It goes straight into Blend as a Supply position and
   starts earning at once. No minimum. You can also pay with **XLM or
   USDT0**: the app quotes Soroswap and the classic Stellar DEX at the same
   time and swaps through whichever pays more, in your wallet, before
   depositing. The pool itself only ever holds USDC.
2. **The round runs.** One week on mainnet. Every second your money is in
   adds to your weight: `deposit × time`. Marking "I saved today" seven days
   in a row doubles your odds. Friends who join through your link add 10 %
   of their capital to your weight.
3. **The round closes.** Anyone can close it once it expires. The prize
   (everything the pool earned) and everyone's weight are frozen. The
   contract picks a **future** drand round that will decide the winner.
4. **drand publishes.** Anyone brings the signature. The contract verifies
   it on-chain with BLS12-381 and picks the winner proportionally to weight.
5. **One person gets paid.** The prize goes to the winner's wallet in the
   same transaction. Everyone else still has exactly what they deposited.
   The next round has already started.

Withdrawing always works: no penalty, no waiting for the draw, no permission.

## What makes it different

- **No roles.** No admin, no pause, no key that can touch funds or influence
  the draw. Closing a round and running the draw are permissionless.
- **Randomness nobody can bias.** Nothing from the ledger is used as a seed.
  The winner comes from a [drand](https://drand.love) quicknet signature for
  a round that did not exist when the pool closed, verified inside the
  contract with the BLS12-381 host functions of Protocol 22. Biasing it would
  take a majority of the ~20 organisations that run drand.
- **No keeper dependency.** A serverless keeper closes rounds and runs draws,
  and so does every visit to the app that finds work to do. If the keeper
  disappears, the first person to open the app unblocks the pool.
- **Built for a million accounts from day one.** Weights live in a Fenwick
  tree over contract storage with capacity 2^20. Deposit, withdraw and draw
  touch ~21 storage entries whether there are 2 participants or 1,000,000.
- **Fair by construction.** Weight is money × time, the same proportion in
  which each participant generated the prize. Jumping in with a lot of money
  a minute before the close barely counts.

## Architecture

```
contracts/pozo/            the pool: deposits, weights, close, drand-verified draw, streak, referrals, cap
contracts/blend_adapter/   Supply position on Blend v2 behind a 3-function interface
contracts/mock_rendimiento a yield source for tests and local demos
web/                       Next.js app, serverless keeper, scripts
scripts/                   deploy scripts (testnet and mainnet)
```

**Pool contract** (`contracts/pozo`, Rust / Soroban SDK 27). Entry points:

| Function | Who | What |
|---|---|---|
| `depositar(user, amount)` / `depositar_con_referente(user, amount, referrer)` | the user | join the pool and the draw |
| `retirar(user, amount)` | the user | take capital out, always, even mid-draw |
| `ahorrar_hoy(user)` | the user | mark the daily streak |
| `cerrar_ronda()` | **anyone** | freeze weights and prize; pin a drand round ≥ 10 min in the future |
| `ejecutar_sorteo(signature)` | **anyone** | verify the drand BLS signature on-chain, pick the winner, pay |
| `estado()`, `cuenta_de(user)`, `chances_bps(user)` | read-only | pool state, account state, "your odds" |

The weight `deposit × time` enters the tree by linearity (`a·T − b`, two
coefficients that sum over prefixes). Closing copies nothing: the new round
starts at the close and the closed round's weights stay frozen in the tree by
lazy versioning. Measured: a deposit's footprint is 23–30 writes with 1 or
with 1,001 accounts, and a draw with 1,001 accounts costs 45M instructions
against a 100M limit.

**Blend adapter** (`contracts/blend_adapter`). A single Supply (non-collateral)
position on a Blend v2 pool: it earns interest and cannot be liquidated.
Tested against Blend's real bytecode. Blend rounds b-tokens down on deposit,
so a withdrawal of the exact amount could come up one stroop short; the
adapter asks the pool for one stroop extra and pays the exact amount from its
own balance, keeping the remainder as a dust fund.

**Web app** (`web/`). Next.js 16, Tailwind 4, `@stellar/stellar-sdk` 17,
Stellar Wallets Kit (Freighter, xBull, Lobstr). Prize growing live, countdown
to the second, Blend APY read from the pool, streak, referral link, swap-in
from XLM or USDT0, human-readable status messages with a link to every
transaction. Deployed on Vercel.

**Keeper** (`web/src/app/api/keeper/route.ts`). The same logic as the CLI
script, as a serverless function triggered by cron and by page visits.

## Addresses

**Mainnet** (the home page): USDC, weekly rounds, 5,000 USDC cap.

| | |
|---|---|
| Pool | `CBPOMGHGCWH2QMG4V4FTZKGBCEN7K37R2OIDGD5VWBAKYTOWG7CDCGGA` |
| Blend adapter | `CD5XQWHFSW427KOQAMAXBMMM6X4BIH6AXZUP76PBB6SWYSSAA4D53MKC` |
| Blend v2 pool (Fixed) | `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` |
| Soroswap router | `CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH` |

**Testnet** (`/test`): XLM, 10-minute rounds, for seeing the whole cycle in
minutes.

| | |
|---|---|
| Pool | `CDNKUQX5YT5JYDF2UB3NZXI7UFKRKUTU7W23P42TLXUTGY4WE5IZI5X2` |
| Blend adapter | `CCHLQA7SGZAEVGLAFUL4Y6DMBG7ZUZYSZZ7AGN44GNNJCCJ6VECV7ISA` |
| Blend v2 pool (TestnetV2) | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` |

All addresses are fixed in `web/src/lib/config.ts`. A new deploy is a commit.

## Status

- Pool contract with drand-verified draws, streak, referrals and capital cap.
  50 tests, footprint and cost measured.
- Blend adapter with dust fund, 10 tests, plus the pool operating through it
  against Blend's real bytecode.
- Testnet pool on Blend TestnetV2 with dozens of consecutive rounds drawn
  with real drand signatures.
- Mainnet pool on Blend's Fixed USDC reserve (~8 % APY to lenders at launch).
- Tested end to end on mainnet with real money, from the app with Freighter:
  swap from XLM to USDC through Soroswap and through the classic DEX, deposit
  into Blend, full withdrawal. Example:
  [f1a4be3a…](https://stellar.expert/explorer/public/tx/f1a4be3a828eb0bc704881ceedf24c6caf7c556aff2436b18d5fe87032b43271).

Why USDC and not XLM: the prize is what borrowers pay, and on Stellar people
borrow USDC. Blend's Fixed pool has the USDC reserve at ~80 % utilisation
paying ~8 % to lenders; the XLM reserve sits at 0.1 % and pays 0 %.
`web/scripts/apy-blend.ts` prints the live table.

## Risks, stated plainly

- **Blend liquidity (medium).** Capital is lent out. If the pool is almost
  fully utilised, a withdrawal can fail until someone repays or deposits. No
  capital is lost, but you may have to wait. Blend raises rates with
  utilisation so that this does not last.
- **Blend protocol (medium).** A bug in Blend affects the pool like any other
  lender. Blend v2 is audited; the risk is not zero.
- **drand (low).** If drand stops publishing there is no draw until it is
  back. Capital can be withdrawn regardless.
- **Keeper (low).** No dependency: anyone can close and draw, and the app
  does it on every visit that finds work.
- **Storage rent (low).** Entries of accounts idle for months expire unless
  someone extends them. Anyone can; automating it in the keeper is pending.
- **No audit (medium).** Built from scratch during the hackathon. That is why
  the mainnet pool has a capital cap fixed in the contract.

## Running it locally

```bash
# Contracts. rust-toolchain.toml pins the Rust version and the wasm32v1-none
# target; rustup installs them on entering the repo. Do not install a
# different Rust by hand: the compatible window is narrow (see SETUP.md).
cargo test && stellar contract build

# Web. Node >= 22.12 is required by @stellar/stellar-sdk; web/.npmrc makes
# npm install fail on older versions instead of warning.
cd web && nvm use && npm install
npm run typecheck && npm run lint && npm run build
npm run dev
```

Point the testnet pool at another deploy during development with
`NEXT_PUBLIC_POZO_LOCAL` in `web/.env.local`. For the Stellar CLI use the
prebuilt binary, **not `cargo install`** (it fails in a `libdbus-sys` build
script); see [SETUP.md](SETUP.md).

### Deploying a pool

```bash
scripts/enchufar-blend-testnet.sh   # testnet: Blend TestnetV2, 10-minute rounds
scripts/desplegar-mainnet.sh        # mainnet: Blend Fixed, USDC, weekly, capped
```

The mainnet script needs a CLI identity with XLM (`IDENTIDAD`, default
`zorrito-mainnet`), deploys against USDC (`ACTIVO`, or `native` for XLM) and
sets a capital cap (`TOPE`, default 5,000). `web/scripts/costo-deploy.ts`
simulates the WASM uploads and prints how much XLM you need before spending
any. It checks the pool has the token as a reserve, deploys the adapter,
deploys the pool pointing at the adapter, and sets the pool as the adapter's
owner. The order is forced by construction: the pool is built pointing at its
yield source, and the adapter cannot know the pool before it exists.

### Keeper

`web/vercel.json` runs `/api/keeper` by cron once a day (the Hobby plan
maximum), and every page visit that finds an expired round or a pending draw
triggers it too. `KEEPER_SECRET` in Vercel is the key that pays the fees;
without it the function only reports what it would do.

```bash
cd web && SOLO_MIRAR=1 npm run keeper     # watch-only loop from a terminal
```

### Useful scripts (`web/scripts/`)

| Script | What it does |
|---|---|
| `apy-blend.ts` | What every reserve of every Blend v2 pool pays lenders right now |
| `cotizar.ts G... 10 USDT0` | How much USDC 10 USDT0 (or XLM) fetch on Soroswap and on the DEX, and which wins |
| `costo-deploy.ts G...` | What uploading the WASMs would cost, simulated |
| `keeper.ts` | The keeper as a loop for a terminal |
| `drand-pk.ts` | Decompresses drand's group public key for the deploy |

## Documents

| Read this | For |
|---|---|
| **[PRODUCTO.md](PRODUCTO.md)** | The product: problem, idea, scope, risks and the jury's criteria (Spanish) |
| **[CLAUDE.md](CLAUDE.md)** | Soroban, Blend and drand gotchas learned the hard way |
| [GAPS.md](GAPS.md) / [EVM-GAPS.md](EVM-GAPS.md) | Why this idea: a survey of 812 ecosystem projects and 50 EVM primitives |
| [IDEAS.md](IDEAS.md) | The 44 other ideas that were discarded |
| [SETUP.md](SETUP.md) | Toolchain |

The first commits of this repo were a different product, a rotating savings
circle (`contracts/ronda`, still served at `/ronda`). Zorrito is the pool.
