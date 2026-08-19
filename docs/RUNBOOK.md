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
| `acceptDefaultAdminTransfer()` | pending owner, after the delay and within `ADMIN_ACCEPT_WINDOW` | completes it |
| `changeDefaultAdminDelay(uint48)` | `DEFAULT_ADMIN_ROLE` | changes the delay (itself delayed); capped at `MAX_ADMIN_DELAY` |
| `rollbackDefaultAdminDelay()` | `DEFAULT_ADMIN_ROLE` | cancels a delay change that has not taken effect yet |
| `scheduleUpgrade(impl, data)` | `UPGRADER_ROLE` | commits to an upgrade, executable after `UPGRADE_DELAY` |
| `upgradeToAndCall(impl, data)` | `UPGRADER_ROLE` | executes the commitment, points the proxy at new code |
| `cancelScheduledUpgrade()` | `UPGRADER_ROLE` **or** `DEFAULT_ADMIN_ROLE` | aborts a scheduled upgrade |

There is **no** mint, burn, pause or token-rescue function. Supply is fixed at 372,000,000 DHN.

## Reading state

| Call | Returns |
|---|---|
| `isBlacklisted(account)` | whether the address is on the list |
| `blacklistEnabled()` | whether the blacklist is currently enforced |
| `owner()` / `defaultAdmin()` | the owner wallet |
| `pendingDefaultAdmin()` | `(newAdmin, acceptSchedule)` during a transfer |
| `defaultAdminTransferDeadline()` | last timestamp at which that transfer can be accepted, `0` if none |
| `defaultAdminDelay()` | delay applied to ownership transfers |
| `pendingUpgrade()` | `(implementation, callDataHash, executableAt, expiresAt)`, all zero if none |
| `version()` | implementation version string |

## Blacklist operations

**Freeze one address**

```
setBlacklisted(0xBad…, true)
```

Takes effect on the next transfer: the address can neither send, nor receive, nor spend an allowance
another account granted it, and any transfer involving it reverts with
`DohrniiBlacklistedAddress(account)`. Its existing balance stays where it is — nothing is seized or
moved.

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
- A frozen address also cannot **spend** an allowance someone granted it. This is what stops a
  compromised router or bridge from draining the accounts that approved it, and it is the step to
  take first in that scenario — before trying to chase the receiving addresses, which a private
  mempool hides from you, or the approving accounts, which can be too many to fit in a block.
- **Check whether the address is shared infrastructure.** Freezing a Uniswap pool stops trading in
  that pool; freezing a router, `Permit2`, a bridge or an account-abstraction entry point stops
  every holder who reaches DHN through it, not just the counterparty you had in mind. Contracts that
  hold no DHN balance are the ones to be careful with: they were unaffected by a freeze before the
  spender check existed, and are fully disabled by one now. Confirm the address is not a pool,
  router, bridge or exchange deposit contract unless that is exactly the intent, and expect to have
  to explain it publicly if it is.
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
2. Wait out `defaultAdminDelay()` (3 hours if deployed with the default). `pendingDefaultAdmin()`
   shows the nominee and the earliest acceptance timestamp. Accepting before that timestamp reverts
   with `AccessControlEnforcedDefaultAdminDelay`.
3. **The new owner** calls `acceptDefaultAdminTransfer()` from its own wallet.

Until step 3 the old owner keeps admin, and `cancelDefaultAdminTransfer()` aborts — with no time
limit, so it works during the delay *and* after it, right up until the nominee accepts. The transfer
only moves `DEFAULT_ADMIN_ROLE`; the operational roles the old owner holds must be revoked and
re-granted separately by the new admin.

Nothing happens automatically when the delay expires: the nominee must send
`acceptDefaultAdminTransfer()` itself. Until it does, the nomination is a **live claim on ownership**
— not a harmless idle state. Anyone holding that nominated key can take `DEFAULT_ADMIN_ROLE` at any
moment inside the acceptance window, whatever else has changed in the meantime.

The window is bounded: acceptance is rejected after `defaultAdminTransferDeadline()`, which is
`ADMIN_ACCEPT_WINDOW` (30 days) past the acceptance schedule, with `DohrniiAdminTransferExpired`.
That is a backstop, not the procedure.

**Cancelling an abandoned nomination is mandatory, not optional.** If a transfer is not going to
complete — the nominee cannot sign, the plan changed, the wrong address was entered — call
`cancelDefaultAdminTransfer()` in the same session in which you decide that, and check
`pendingDefaultAdmin()` returns the zero address afterwards. Expiry disarms an abandoned nomination
but does not clear it: the entry stays visible until it is cancelled or replaced, so a stale record
is also a reporting problem. If the nomination is still wanted after it expired, start it again with
`beginDefaultAdminTransfer`.

Verify the nominee can sign before starting: an accepted transfer to an unreachable wallet is
unrecoverable.

To renounce ownership entirely, call `beginDefaultAdminTransfer(0x0)`, wait out
`defaultAdminDelay()`, then `renounceRole(DEFAULT_ADMIN_ROLE, <current owner>)`. That path is
deliberately not bounded by `ADMIN_ACCEPT_WINDOW`, since only the current admin can exercise it.
It is irreversible: no role can be granted or revoked afterwards, ever.

## Upgrading

Upgrades are time-delayed: nothing can be swapped in the same transaction it is proposed in.

1. Write the V2 with a new ERC-7201 namespace (see the rules in [../README.md](../README.md)).
2. `PROXY_ADDRESS=… NEW_IMPLEMENTATION_CONTRACT=… PREPARE_ONLY=true npx hardhat run scripts/upgrade.ts --network mainnet`
   — deploys and validates the implementation, verifies it on Etherscan, prints both calls to
   execute. Drop `PREPARE_ONLY` to have the script send `scheduleUpgrade` itself.
3. Execute `scheduleUpgrade(newImpl, data)` from the `UPGRADER_ROLE` wallet. `data` is `"0x"` for a
   plain code swap, or the encoded `reinitializer` call if the V2 needs one, so code and new state
   land atomically. The commitment covers `keccak256(data)`, so keep the exact bytes — step 5 fails
   without them.
4. Check `pendingUpgrade()` and announce the window. `executableAt` is `UPGRADE_DELAY` (1 day)
   after scheduling, `expiresAt` is `UPGRADE_WINDOW` (30 days) after that. The implementation is
   already deployed and verified at this point, so anyone can read the code that is coming.
5. After `executableAt`, execute `upgradeToAndCall(newImpl, data)` — same arguments, byte for byte —
   or `PROXY_ADDRESS=… EXECUTE=true UPGRADE_CALLDATA=… npx hardhat run scripts/upgrade.ts`. The
   commitment is consumed, so a repeat execution reverts with `DohrniiNoScheduledUpgrade`.
6. Verify the new implementation on Etherscan and re-check `version()`, `totalSupply()`, `owner()`
   and a couple of balances.
7. Commit the updated `.openzeppelin/<network>.json`.

To abort between steps 3 and 5, call `cancelScheduledUpgrade()` — available to the `UPGRADER_ROLE`
wallet and to the owner wallet, which is how ownership vetoes an upgrade it did not want. Scheduling
again simply replaces an earlier commitment; a commitment left past `expiresAt` is dead and must be
scheduled afresh.

Rehearse every upgrade on Sepolia, then on a mainnet fork, before touching mainnet.

## Incident checklist

| Situation | Action |
|---|---|
| Stolen tokens sitting in a known address | `setBlacklisted(addr, true)` — stops it moving, does not recover funds |
| Suspicious inbound spam to a treasury wallet | `setBlacklisted(source, true)` on the sending address |
| Blacklist causing unintended damage | `setBlacklistEnabled(false)` — suspends all enforcement immediately |
| A contract holding user allowances is compromised | `setBlacklisted(spender, true)` — the spender check stops it pulling any further approved balance. Read the warning above first: if it is shared infrastructure, this stops every holder using it |
| Upgrader key compromised, upgrade scheduled | `cancelScheduledUpgrade()` from the owner wallet, then `revokeRole(UPGRADER_ROLE, …)`. The 1-day delay is the window this exists for; check `pendingUpgrade()` |
| Owner wallet compromised | Nothing in-contract can help: the admin can revoke roles and upgrade. Assume worst case and coordinate with exchanges |
| Need a pause / tax / burn | Not in this build; requires a new implementation and an upgrade |
