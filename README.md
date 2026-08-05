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

## Contracts

- [contracts/DohrniiToken.sol](contracts/DohrniiToken.sol) — the token. The only production contract.
- [contracts/mocks/DohrniiTokenV2Mock.sol](contracts/mocks/DohrniiTokenV2Mock.sol) — **test only.**
  A sample V2 that adds a pause feature in its own ERC-7201 namespace, so the upgrade tests prove
  the deferred-feature path on a live proxy.

## Feature set

| Feature | State at launch | Control |
|---|---|---|
| Blacklist (freeze addresses) | Active, blocks sending and receiving | `BLACKLIST_MANAGER_ROLE` / `FEATURE_MANAGER_ROLE` |
| UUPS upgradeability | Active | `UPGRADER_ROLE` |
| Fixed supply, no mint | Active | — (not changeable) |
| ERC-7201 namespaced storage | Active | — |
| Tax / burn / pause | Deferred by design | added later by upgrade |

### Blacklist

A blacklisted address can neither send nor receive DHN: `_update` rejects the transfer if either
party is on the list. `isBlacklisted(account)` reads the list; `setBlacklisted` /
`setBlacklistedBatch` maintain it.

Approvals are never blocked; only balance movements are, so a blacklisted holder can still sign an
`approve` but no transfer will settle.

`blacklistEnabled()` is the kill switch: `FEATURE_MANAGER_ROLE` can call
`setBlacklistEnabled(false)` to stop all enforcement without clearing the list, and switch it back
on later. It is on at launch.

### Roles

| Role | Powers |
|---|---|
| `DEFAULT_ADMIN_ROLE` | grant/revoke every other role; reported as `owner()` (ERC-5313) |
| `BLACKLIST_MANAGER_ROLE` | `setBlacklisted`, `setBlacklistedBatch` |
| `FEATURE_MANAGER_ROLE` | `setBlacklistEnabled` |
| `UPGRADER_ROLE` | `upgradeToAndCall` |

`initialize` grants all four to the owner wallet, so the single wallet you control operates the
token out of the box and can delegate any individual power later without giving up ownership.

Ownership itself moves in two steps with a delay (`AccessControlDefaultAdminRules`): the current
owner calls `beginDefaultAdminTransfer`, and after `defaultAdminDelay()` the nominee calls
`acceptDefaultAdminTransfer`. `grantRole(DEFAULT_ADMIN_ROLE, …)` is rejected outright, so ownership
can never be handed to a wrong or unreachable address in one transaction — the Ownable2Step
guarantee, with granular roles on top.

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
npm test                # 34 unit tests
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
PROXY_ADDRESS=0x… NEW_IMPLEMENTATION_CONTRACT=DohrniiTokenV2 \
  npx hardhat run scripts/upgrade.ts --network mainnet
```

The script validates the new layout against the deployed one before sending anything on chain.
With `PREPARE_ONLY=true` it deploys and validates the implementation and prints the
`upgradeToAndCall` call for the upgrader wallet to execute — the mode to use when a multisig or
hardware wallet holds `UPGRADER_ROLE`.

Rules for a future V2:

1. Never change, reorder or remove fields in `DohrniiTokenStorage`; declare a new
   `@custom:storage-location erc7201:dohrnii.storage.<Name>` struct instead. Namespaces are also
   never deleted — keep every past struct declared, even if a version stops using it.
2. Add new state through a `reinitializer(n)` function; do not re-run parent initialisers.
3. Gate any new behaviour behind its own flag and role, so it can be switched off without an upgrade.
4. Keep `_authorizeUpgrade` gated by `UPGRADER_ROLE`, or the token loses upgradeability.
5. Each upgrade is new code: fresh tests, fresh review, re-verification on Etherscan.

If a transfer tax is ever added, note that it only works with Uniswap-V2-style pools;
V3/V4/Algebra concentrated-liquidity pools revert on fee-on-transfer tokens and would trade
untaxed.

## Operations

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for the operator runbook: every owner function, what it
does, and how to run blacklist operations.
