# Dohrnii (DHN)

Fixed-supply ERC-20 token for Ethereum mainnet, deployed behind a UUPS proxy, with an
address blacklist as its only transfer restriction. Storage uses the ERC-7201 namespaced layout so
features deferred from this build (tax, burn, pause, …) can be added later through the upgrade path
without a storage-layout migration on the live token.

| | |
|---|---|
| Name / symbol | Dohrnii / DHN |
| Decimals | 18 |
| Total supply | 372,000,000 DHN — minted once at initialisation, **no mint function** |
| Network | Ethereum mainnet (ERC-20) |
| Proxy | ERC-1967 + UUPS (`@openzeppelin/contracts-upgradeable` v5) |
| Storage | ERC-7201 namespace `dohrnii.storage.DohrniiToken` |
| Solidity | 0.8.36, optimizer on (200 runs) |

## Design assumptions

Two properties of this token are deliberate architecture, agreed at kickoff and specified in
writing: **the address blacklist** and **UUPS upgradeability**. Neither is a defect, and a review
should treat them as the design's trust assumptions rather than as findings to be closed.

Stated plainly, so nothing is hidden: the owner wallet can freeze any address, and can replace the
contract's code entirely — including with code that adds powers this build deliberately lacks, such
as minting or seizing. The token's security therefore rests on the custody of that wallet, not on
the absence of those powers, and that is where review effort belongs — key custody, multisig
thresholds, and the operator procedures in [docs/RUNBOOK.md](docs/RUNBOOK.md).

Everything outside those two decisions — fixed supply, access control, storage layout, transfer
logic — is meant to hold on its own merits. A finding there is a real finding.

## Contracts

- [contracts/DohrniiToken.sol](contracts/DohrniiToken.sol) — the token. The only production contract.


## Feature set

| Feature | State at launch | Control |
|---|---|---|
| Blacklist (freeze addresses) | Active, blocks sending, receiving and spending allowances | `BLACKLIST_MANAGER_ROLE` / `FEATURE_MANAGER_ROLE` |
| UUPS upgradeability | Active, two-step with a 1-day delay | `UPGRADER_ROLE` |
| Fixed supply, no mint | Active | — (not changeable) |
| ERC-7201 namespaced storage | Active | — |
| Tax / burn / pause | Deferred by design | added later by upgrade |

### Blacklist

A blacklisted address can neither send nor receive DHN, nor spend an allowance someone granted it:
`_update` rejects the transfer if either party is on the list, and `_spendAllowance` rejects it if
the spender is. `isBlacklisted(account)` reads the list; `setBlacklisted` / `setBlacklistedBatch`
maintain it.

The spender check is what makes the list useful against a compromised integration. A contract that
holds allowances but no balance — a router, a bridge, `Permit2` — is neither `from` nor `to`, so
without it, listing such a contract would not stop it draining every account that had approved it,
and the alternatives are impracticable: blacklisting the receivers requires seeing the transaction
before it lands, which a private mempool prevents, and blacklisting the victims can exceed the block
gas limit while also punishing the wrong party. The consequence to hold in mind is that listing a
shared piece of infrastructure now stops it for **every** holder, so [docs/RUNBOOK.md](docs/RUNBOOK.md)
makes checking for that a step rather than a footnote.

Approvals themselves are never blocked. `approve` stays open in both directions — a blacklisted
holder can still sign one, and a holder can still set an allowance to a blacklisted spender. That is
deliberate: gating `approve` would stop an exposed holder from calling `approve(spender, 0)`, which
is exactly the action such a holder needs to take. Nothing settles either way while the list bites.

`blacklistEnabled()` is the kill switch: `FEATURE_MANAGER_ROLE` can call
`setBlacklistEnabled(false)` to stop all enforcement without clearing the list, and switch it back
on later. It is on at launch.

#### Freezing immobilises; it never confiscates

This is a deliberate property of the design, not an omission. Blacklisting an address stops its
balance from moving; it does not move, take or destroy that balance. There is no mint, no burn, no
seize and no token-rescue function anywhere in this build, and no role can reach one — which is the
point: a holder reading the contract on Etherscan can see that no admin power exists to take their
tokens or dilute them. The trade-off, accepted knowingly, is that the same guarantee applies to
tokens you might *want* to recover.

Three consequences follow, and they are worth stating plainly before launch:

- **Freezing is containment, not recovery.** Blacklisting an address holding stolen DHN stops the
  thief spending or bridging it, and stops any exchange crediting a deposit from it. It does not
  return the tokens to you. Recovery, if it ever happens, is an off-chain matter — a negotiation, or
  law enforcement — and blacklisting is what buys the time for it.
- **Frozen balances still count towards `totalSupply()`.** Supply is fixed at 372,000,000 DHN
  forever, whatever is frozen. Circulating supply is therefore an off-chain calculation: take
  `totalSupply()` and subtract the balances of the treasury, unissued-reward and frozen addresses.
  Anything reporting `totalSupply()` as circulating supply — an explorer, a market-data feed, a
  listing form — will overstate it. Publish the frozen addresses you rely on so the figure can be
  reproduced.
- **The freeze itself is fully reversible.** `setBlacklisted(addr, false)` restores the address
  completely, with its balance and any approvals it signed earlier intact, and
  `setBlacklistEnabled(false)` lifts every freeze at once. Nothing about a freeze decays or expires
  on its own, so an address stays frozen until someone with `BLACKLIST_MANAGER_ROLE` clears it. Keep
  a record of why each address was listed; the contract stores only the flag, and the
  `BlacklistUpdated` event log is the only history there is.

Adding a burn, a claw-back or a rescue function would each mean a new implementation, a fresh audit
and an upgrade — see the deferred-feature rules under [Upgrades](#upgrades). Each one also removes a
guarantee holders currently have, so it is a decision to take on its merits rather than a gap to
fill.

### Roles

| Role | Powers |
|---|---|
| `DEFAULT_ADMIN_ROLE` | grant/revoke every other role; reported as `owner()` (ERC-5313) |
| `BLACKLIST_MANAGER_ROLE` | `setBlacklisted`, `setBlacklistedBatch` |
| `FEATURE_MANAGER_ROLE` | `setBlacklistEnabled` |
| `UPGRADER_ROLE` | `scheduleUpgrade`, `upgradeToAndCall`, `cancelScheduledUpgrade` |

`initialize` grants all four to the owner wallet, so the single wallet you control operates the
token out of the box and can delegate any individual power later without giving up ownership.

Ownership itself moves in two steps (`AccessControlDefaultAdminRules`): the current owner calls
`beginDefaultAdminTransfer`, and the nominee calls `acceptDefaultAdminTransfer` from its own wallet.
`grantRole(DEFAULT_ADMIN_ROLE, …)` is rejected outright, so ownership can never be handed to a wrong
or unreachable address in a single transaction — the Ownable2Step guarantee, with granular roles on
top.

Three things are worth stating precisely, because they depend on configuration or on behaviour the
base contract does not provide:

- **The cancellation window is exactly `defaultAdminDelay()`, whatever was set at deployment.** For
  its duration `acceptDefaultAdminTransfer` reverts and the current owner can call
  `cancelDefaultAdminTransfer`. With a delay of `0` there is no window at all: the nominee can
  accept in the next block, and only the explicit-acceptance guarantee remains. A non-zero delay is
  what buys time to react to a wrong or compromised nominee — pick it deliberately.
- **A nomination expires `ADMIN_ACCEPT_WINDOW` (30 days) after it becomes acceptable.** The base
  contract puts no deadline on acceptance, so a nomination left un-cancelled stays a live claim on
  `DEFAULT_ADMIN_ROLE` indefinitely — someone who was nominated and forgotten about could accept a
  year later. `acceptDefaultAdminTransfer` is overridden to reject acceptance past
  `defaultAdminTransferDeadline()`, with `DohrniiAdminTransferExpired`. Expiry disarms the claim but
  does not clear the record: the entry stays visible in `pendingDefaultAdmin()` until it is
  cancelled or replaced, and a nomination that is still wanted is simply started again. Renouncing
  ownership (a transfer to the zero address, then `renounceRole`) is deliberately *not* bounded by
  this window, since only the admin itself can exercise that schedule.
- **Every admin delay is capped at `MAX_ADMIN_DELAY` (7 days)** — both `_initialAdminDelay` and any
  later `changeDefaultAdminDelay`. Reducing a delay costs exactly the amount removed, so an
  over-long value would lock ownership rotation for that whole period with no way to shorten it;
  `259200000` (milliseconds by mistake) would mean 8 years. A later increase is not exempt: it takes
  effect after at most `defaultAdminDelayIncreaseWait()` (5 days) and is just as binding afterwards,
  so `changeDefaultAdminDelay` is overridden to enforce the same bound. Values above the cap are
  rejected with `DohrniiAdminDelayTooLong`. `0` is accepted — see above for what it costs.

### Upgrade delay

`UPGRADER_ROLE` can replace the implementation with anything, which makes it at least as powerful as
`DEFAULT_ADMIN_ROLE` — and the admin role only moves through a delayed, two-step transfer. Upgrades
therefore follow the same shape:

1. `scheduleUpgrade(newImplementation, data)` commits to an implementation **and** to
   `keccak256(data)`, so the migration call is fixed at scheduling time rather than chosen at
   execution. `pendingUpgrade()` reports the commitment and its window; `UpgradeScheduled` announces
   it. Scheduling again replaces an earlier commitment.
2. After `UPGRADE_DELAY` (1 day) and before `UPGRADE_WINDOW` (30 days) closes,
   `upgradeToAndCall(newImplementation, data)` executes exactly what was committed to and consumes
   the commitment, so the same upgrade cannot be replayed.
3. `cancelScheduledUpgrade()` aborts it. Open to `UPGRADER_ROLE` **and** to the default admin — a
   delay ownership cannot act on would be decoration.

**Why 24 hours.** The delay is a notice period, not a governance timelock. It has to be long enough
that a scheduled upgrade is visible before it can take effect — the implementation is deployed and
verified at scheduling time, so anyone can read the code that is coming, and both the default admin
and the role holder can cancel within the window. It also has to be short enough not to become the
reason an incident is handled badly: the immediate levers are `setBlacklisted` /
`setBlacklistedBatch` and `setBlacklistEnabled`, which stay instant, and an upgrade is never the fast
path. A day satisfies both; a week would only widen the gap between noticing a problem and being able
to ship code for it.

**Why granting the role stays immediate.** A newly granted `UPGRADER_ROLE` still cannot act for 24
hours, and whatever it schedules is public for that whole period, so the protection lives in the
delay rather than in how the role is handed over. Wrapping `grantRole` in its own two-step flow would
add moving parts without changing what an attacker holding the admin key could ultimately do.

### ERC-7201 storage

All state this contract introduces lives in one struct at
`keccak256(abi.encode(uint256(keccak256("dohrnii.storage.DohrniiToken")) - 1)) & ~0xff` =
`0x87ac003d6a2ee51f32caee697ee53c130d83b78375b3cf089e3649b4e0aec000`.

Inherited OpenZeppelin v5 modules use their own ERC-7201 namespaces. Nothing occupies sequential
slots 0, 1, 2 …, so a future upgrade adds state by declaring a **new** namespace — never by
appending to an existing struct — and no storage-layout migration is needed.
[test/DohrniiToken.test.ts](test/DohrniiToken.test.ts) asserts the live slot values, and
[test/Upgrade.test.ts](test/Upgrade.test.ts) asserts the V1 namespace is untouched after an upgrade
that adds a V2 namespace.

## Getting started

```bash
npm ci
cp .env.example .env    # fill in RPC URLs, keys and addresses
npm run build           # compile
npm test                # 85 unit tests
npm run coverage        # tests + coverage report (coverage/html)
npm run lint            # solhint, zero warnings tolerated
npm run typecheck       # tsc --noEmit
npm run slither         # static analysis (needs: pip install slither-analyzer solc-select)
```

Mainnet-fork sanity check (needs `MAINNET_RPC_URL`):

```bash
npx hardhat test mocha --network mainnetFork
```

## Deployment

```bash
OWNER_ADDRESS=0x… SUPPLY_RECIPIENT_ADDRESS=0x… \
  npx hardhat run scripts/deploy.ts --network sepolia
```

The deployer wallet pays gas only: `initialize` assigns every role to `OWNER_ADDRESS`, so there is
no separate handover transaction and no window in which the deployer controls the token. Verify
afterwards with `npx hardhat verify --network <network> <proxy address>`.

`.openzeppelin/<network>.json` is written on every deployment and upgrade — **commit it.** The
upgrade plugin needs it to validate storage-layout compatibility later.

## Upgrades

```bash
# step 1 — validate the layout, deploy the implementation, commit to it
PROXY_ADDRESS=0x… NEW_IMPLEMENTATION_CONTRACT=DohrniiTokenV2 \
  npx hardhat run scripts/upgrade.ts --network mainnet

# step 2 — after UPGRADE_DELAY, execute the commitment
PROXY_ADDRESS=0x… EXECUTE=true npx hardhat run scripts/upgrade.ts --network mainnet
```

Step 1 refuses to send anything if the new layout is incompatible with the deployed one, and
verifies the implementation on Etherscan immediately, so its sources are public for the whole delay.
Pass `UPGRADE_CALLDATA=0x…` when the V2 needs a `reinitializer`; it must be byte-identical in both
steps, since the commitment covers its hash. With `PREPARE_ONLY=true` the script deploys and
validates the implementation and prints both calls for the upgrader wallet to execute — the mode to
use when a multisig or hardware wallet holds `UPGRADER_ROLE`.

Rules for a future V2:

1. Never change, reorder or remove fields in `DohrniiTokenStorage`; declare a new
   `@custom:storage-location erc7201:dohrnii.storage.<Name>` struct instead. Namespaces are also
   never deleted — keep every past struct declared, even if a version stops using it.
2. Add new state through a `reinitializer(n)` function; do not re-run parent initialisers.
3. Gate any new behaviour behind its own flag and role, so it can be switched off without an upgrade.
4. Keep `_authorizeUpgrade` gated by `UPGRADER_ROLE`, or the token loses upgradeability, and keep
   the `scheduleUpgrade` commitment enforced in `upgradeToAndCall` — a V2 that reaches
   `_authorizeUpgrade` by any other path silently removes the upgrade delay.
5. Each upgrade is new code: fresh tests, fresh review, re-verification on Etherscan.

If a transfer tax is ever added, note that it only works with Uniswap-V2-style pools;
V3/V4/Algebra concentrated-liquidity pools revert on fee-on-transfer tokens and would trade
untaxed.

## Operations

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for the operator runbook: every owner function, what it
does, and how to run blacklist operations.
