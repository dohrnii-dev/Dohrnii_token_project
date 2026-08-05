# DHN operator runbook

Everything below is executed against the **proxy** address — never the implementation. The
implementation has no state and its `initialize` is permanently disabled.

## Who can do what

| Function | Required role | Effect |
|---|---|---|
| `setBlacklisted(account, bool)` | `BLACKLIST_MANAGER_ROLE` | freezes / unfreezes one address |
| `setBlacklistedBatch(accounts[], bool)` | `BLACKLIST_MANAGER_ROLE` | same, for a list |
| `setBlacklistEnabled(bool)` | `FEATURE_MANAGER_ROLE` | turns blacklist enforcement on / off |
| `grantRole(role, account)` | `DEFAULT_ADMIN_ROLE` | delegates a power |
| `revokeRole(role, account)` | `DEFAULT_ADMIN_ROLE` | takes it back |
| `beginDefaultAdminTransfer(newOwner)` | `DEFAULT_ADMIN_ROLE` | starts ownership transfer |
| `cancelDefaultAdminTransfer()` | `DEFAULT_ADMIN_ROLE` | aborts it |
| `acceptDefaultAdminTransfer()` | pending owner, after the delay | completes it |
| `changeDefaultAdminDelay(uint48)` | `DEFAULT_ADMIN_ROLE` | changes the delay (itself delayed) |
| `upgradeToAndCall(impl, data)` | `UPGRADER_ROLE` | points the proxy at new code |

There is **no** mint, burn, pause or token-rescue function. Supply is fixed at 372,000,000 DHN.

## Reading state

| Call | Returns |
|---|---|
| `isBlacklisted(account)` | whether the address is on the list |
| `blacklistEnabled()` | whether the blacklist is currently enforced |
| `owner()` / `defaultAdmin()` | the owner wallet |
| `pendingDefaultAdmin()` | `(newAdmin, acceptSchedule)` during a transfer |
| `defaultAdminDelay()` | delay applied to ownership transfers |
| `version()` | implementation version string |

## Blacklist operations

**Freeze one address**

```
setBlacklisted(0xBad…, true)
```

Takes effect on the next transfer: the address can neither send nor receive, and any transfer
involving it reverts with `DohrniiBlacklistedAddress(account)`. Its existing balance stays where it
is — nothing is seized or moved.

**Unfreeze**

```
setBlacklisted(0xBad…, false)
```

**Freeze a list** — one transaction, cheaper than N calls. Keep batches to a few hundred addresses
to stay well inside the block gas limit; the zero address is rejected, and the whole batch reverts
if it appears.

```
setBlacklistedBatch([0xA…, 0xB…, 0xC…], true)
```

**Suspend enforcement without clearing the list**

```
setBlacklistEnabled(false)   // every transfer flows again, list preserved
setBlacklistEnabled(true)    // back on, list unchanged
```

Use this when the blacklist itself is causing a problem and you need transfers flowing again in one
transaction, rather than unfreezing addresses one by one.

### Before you freeze an address

- A frozen address cannot move its tokens by any route, including `transferFrom` by a spender it
  approved earlier.
- Freezing a Uniswap pool address stops trading in that pool. Check the address is not a pool,
  bridge or exchange deposit contract unless that is exactly the intent.
- Nothing can freeze the whole token in this build — there is no pause. Freezing every address is
  not a substitute and should not be attempted.

## Delegating powers

Give an operations wallet the ability to freeze addresses without giving it ownership:

```
grantRole(BLACKLIST_MANAGER_ROLE, 0xOps…)   // 0x7762e3c7410e371c31b8f32144041a9e686f3a7ebfa83a4629ba3ae114cba5cd
revokeRole(BLACKLIST_MANAGER_ROLE, 0xOps…)
```

Role ids (`keccak256` of the label):

| Role | id |
|---|---|
| `DEFAULT_ADMIN_ROLE` | `0x0000…0000` |
| `BLACKLIST_MANAGER_ROLE` | `0x7762e3c7410e371c31b8f32144041a9e686f3a7ebfa83a4629ba3ae114cba5cd` |
| `FEATURE_MANAGER_ROLE` | `0xd7c9a6b26533fb0d37a529271a4cd7cc22d3cb66badb021ca480ae4090aa16f2` |
| `UPGRADER_ROLE` | `0x1234b90a20e9ca9bd824694761790c31b071105beae3a1e00c2f83d6867f36b1` |

Read them from the contract (`BLACKLIST_MANAGER_ROLE()` etc.) rather than pasting these by hand.

Recommended posture for mainnet: `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE` on a multisig or hardware
wallet; `BLACKLIST_MANAGER_ROLE` on a hot operations wallet, since freezing is time-critical and
reversible; `FEATURE_MANAGER_ROLE` with the admin, since switching enforcement off affects every
address at once.

## Transferring ownership

1. Current owner: `beginDefaultAdminTransfer(0xNew…)`
2. Wait out `defaultAdminDelay()` (3 days by default). `pendingDefaultAdmin()` shows the nominee and
   the earliest acceptance timestamp.
3. **The new owner** calls `acceptDefaultAdminTransfer()` from its own wallet.

Until step 3 the old owner keeps admin, and `cancelDefaultAdminTransfer()` aborts. The transfer only
moves `DEFAULT_ADMIN_ROLE`; the operational roles the old owner holds must be revoked and re-granted
separately by the new admin.

Verify the nominee can sign before starting: an address that never accepts leaves ownership where it
is, but an accepted transfer to an unreachable wallet is unrecoverable.

## Upgrading

1. Write the V2 with a new ERC-7201 namespace (see the rules in [../README.md](../README.md)).
2. `PROXY_ADDRESS=… NEW_IMPLEMENTATION_CONTRACT=… PREPARE_ONLY=true npx hardhat run scripts/upgrade.ts --network mainnet`
   — deploys and validates the implementation, prints the call to execute.
3. Execute `upgradeToAndCall(newImpl, "0x")` from the `UPGRADER_ROLE` wallet (or `"0x"` replaced by
   the encoded `reinitializer` call if the V2 needs one, so code and new state land atomically).
4. Verify the new implementation on Etherscan and re-check `version()`, `totalSupply()`, `owner()`
   and a couple of balances.
5. Commit the updated `.openzeppelin/<network>.json`.

Rehearse every upgrade on Sepolia, then on a mainnet fork, before touching mainnet.

## Incident checklist

| Situation | Action |
|---|---|
| Stolen tokens sitting in a known address | `setBlacklisted(addr, true)` — stops it moving, does not recover funds |
| Suspicious inbound spam to a treasury wallet | `setBlacklisted(source, true)` on the sending address |
| Blacklist causing unintended damage | `setBlacklistEnabled(false)` — suspends all enforcement immediately |
| Owner wallet compromised | Nothing in-contract can help: the admin can revoke roles and upgrade. Assume worst case and coordinate with exchanges |
| Need a pause / tax / burn | Not in this build; requires a new implementation and an upgrade |
