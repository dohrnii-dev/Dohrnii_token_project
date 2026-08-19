// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {AccessControlDefaultAdminRulesUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title Dohrnii (DHN)
 * @notice Fixed-supply ERC-20 token behind a UUPS proxy.
 *
 * Design notes
 * ------------
 * - Fixed supply: {TOTAL_SUPPLY} DHN is minted once, during {initialize}, to the nominated
 *   supply recipient. There is no mint function and none can be reached by any role.
 * - Blacklist: the only transfer restriction in this build. A blacklisted address can neither
 *   send nor receive DHN, nor spend an allowance another account granted it.
 *   {FEATURE_MANAGER_ROLE} can switch the whole check off without clearing the list.
 * - Storage: all state introduced by this contract lives in a single ERC-7201 namespaced
 *   struct, so a future upgrade can add its own namespace without any storage-layout
 *   migration on the live token.
 * - Access control: {AccessControlDefaultAdminRulesUpgradeable} gives a single owner wallet
 *   (the default admin, also exposed as {owner} per ERC-5313) plus two-step, time-delayed
 *   transfer of that admin — the Ownable2Step guarantee — while still allowing granular roles.
 *   That transfer also expires: see {ADMIN_ACCEPT_WINDOW}.
 * - Upgrades: {UPGRADER_ROLE} can replace the implementation, but only through the same shape of
 *   flow — {scheduleUpgrade} commits to an implementation and its call data, {upgradeToAndCall}
 *   executes it once {UPGRADE_DELAY} has passed and before {UPGRADE_WINDOW} closes. The pending
 *   code is therefore public before it can take effect, and either the role holder or the default
 *   admin can cancel it in the meantime.
 */
contract DohrniiToken is ERC20Upgradeable, AccessControlDefaultAdminRulesUpgradeable, UUPSUpgradeable {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Full, immutable supply of DHN, minted once at initialisation.
    uint256 public constant TOTAL_SUPPLY = 372_000_000e18;

    /// @notice Can add and remove addresses from the blacklist.
    bytes32 public constant BLACKLIST_MANAGER_ROLE = keccak256("DHN_BLACKLIST_MANAGER_ROLE");

    /// @notice Can switch the blacklist check on and off.
    bytes32 public constant FEATURE_MANAGER_ROLE = keccak256("DHN_FEATURE_MANAGER_ROLE");

    /// @notice Can upgrade the implementation behind the proxy.
    bytes32 public constant UPGRADER_ROLE = keccak256("DHN_UPGRADER_ROLE");

    /**
     * @notice Upper bound on the ownership-transfer delay, enforced at initialisation and on every
     *         later change through {changeDefaultAdminDelay}.
     * @dev Lowering the delay costs exactly the amount being removed, so an over-long value is
     *      self-locking: ownership can then neither be rotated nor the delay repaired for as long
     *      as it takes to unwind. A week keeps every value reachable within a week, and puts a
     *      fat-fingered `259200000` (milliseconds instead of seconds) out of range rather than
     *      freezing ownership rotation for 8 years.
     *
     *      An increase scheduled through {changeDefaultAdminDelay} only waits
     *      `defaultAdminDelayIncreaseWait()` (5 days) before taking effect and can be undone in
     *      that window with `rollbackDefaultAdminDelay`, but once it has taken effect it is as
     *      binding as the initial value — hence the same cap applies to both.
     */
    uint48 public constant MAX_ADMIN_DELAY = 7 days;

    /**
     * @notice How long a scheduled ownership transfer stays claimable once its delay has elapsed.
     * @dev The base contract puts no deadline on acceptance, so a nomination that is abandoned
     *      rather than cancelled leaves a claim on {DEFAULT_ADMIN_ROLE} that can be exercised
     *      years later. Bounding the window lets an abandoned nomination expire on its own; one
     *      that is still wanted is renewed with another `beginDefaultAdminTransfer`.
     */
    uint48 public constant ADMIN_ACCEPT_WINDOW = 30 days;

    /**
     * @notice Delay between committing to an upgrade and being able to execute it.
     * @dev {UPGRADER_ROLE} can replace the whole implementation and is therefore at least as
     *      powerful as the default admin, which moves only through a delayed two-step transfer.
     *      The delay puts the pending implementation and its call data on chain ahead of time, so
     *      holders can exit and the default admin can revoke the role or cancel the commitment
     *      before it takes effect. It is deliberately short: the immediate levers in an incident
     *      are {setBlacklisted} and {setBlacklistEnabled}, never an upgrade.
     */
    uint48 public constant UPGRADE_DELAY = 1 days;

    /**
     * @notice How long a scheduled upgrade stays executable once {UPGRADE_DELAY} has elapsed.
     * @dev Same reasoning as {ADMIN_ACCEPT_WINDOW}: a commitment nobody executes expires instead
     *      of staying live indefinitely.
     */
    uint48 public constant UPGRADE_WINDOW = 30 days;

    // -------------------------------------------------------------------------
    // ERC-7201 namespaced storage
    // -------------------------------------------------------------------------

    /// @custom:storage-location erc7201:dohrnii.storage.DohrniiToken
    struct DohrniiTokenStorage {
        // Slot 0: the flag read on every transfer, packed with the two upgrade fields that are
        // only touched by {scheduleUpgrade}. Slot 1: the blacklist mapping. Slot 2: the call hash.
        /// @dev Whether the blacklist is enforced on transfers.
        bool blacklistEnabled;
        /// @dev Implementation committed to by {scheduleUpgrade}. Zero when nothing is scheduled.
        address pendingImplementation;
        /// @dev Timestamp from which the scheduled upgrade may be executed. Zero when none is.
        uint48 upgradeSchedule;
        /// @dev Blacklisted addresses.
        mapping(address account => bool blacklisted) blacklist;
        /// @dev keccak256 of the `data` the scheduled upgrade must be executed with.
        bytes32 pendingUpgradeCallHash;
    }

    // keccak256(abi.encode(uint256(keccak256("dohrnii.storage.DohrniiToken")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant _DOHRNII_TOKEN_STORAGE_LOCATION =
        0x87ac003d6a2ee51f32caee697ee53c130d83b78375b3cf089e3649b4e0aec000;

    function _getDohrniiTokenStorage() private pure returns (DohrniiTokenStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := _DOHRNII_TOKEN_STORAGE_LOCATION
        }
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * @notice Emitted when an address is added to or removed from the blacklist.
     * @param account The affected address.
     * @param blacklisted Its new blacklist status.
     */
    event BlacklistUpdated(address indexed account, bool blacklisted);

    /**
     * @notice Emitted when blacklist enforcement is switched on or off.
     * @param enabled Whether the blacklist is now enforced.
     */
    event BlacklistEnabledUpdated(bool enabled);

    /**
     * @notice Emitted when an upgrade is committed to, replacing any earlier commitment.
     * @param implementation The implementation the upgrade is committed to.
     * @param callDataHash keccak256 of the `data` the upgrade must be executed with.
     * @param executableAt Timestamp from which the upgrade may be executed.
     * @param expiresAt Timestamp after which the commitment can no longer be executed.
     */
    event UpgradeScheduled(
        address indexed implementation, bytes32 callDataHash, uint48 executableAt, uint48 expiresAt
    );

    /**
     * @notice Emitted when a scheduled upgrade is cancelled before execution.
     * @param implementation The implementation that had been committed to.
     */
    event UpgradeCancelled(address indexed implementation);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    /// @dev A party to the transfer is blacklisted.
    error DohrniiBlacklistedAddress(address account);

    /// @dev The zero address is not a valid argument here.
    error DohrniiZeroAddress();

    /// @dev The requested ownership-transfer delay exceeds {MAX_ADMIN_DELAY}.
    error DohrniiAdminDelayTooLong(uint48 delay, uint48 maxDelay);

    /// @dev The pending ownership transfer is past its {ADMIN_ACCEPT_WINDOW} deadline.
    error DohrniiAdminTransferExpired(uint48 schedule, uint48 deadline);

    /// @dev No upgrade is currently scheduled.
    error DohrniiNoScheduledUpgrade();

    /// @dev The implementation and call data do not match the scheduled commitment.
    error DohrniiUpgradeNotScheduled(address implementation, bytes32 callDataHash);

    /// @dev The scheduled upgrade cannot be executed until {UPGRADE_DELAY} has elapsed.
    error DohrniiUpgradeNotReady(uint48 executableAt);

    /// @dev The scheduled upgrade is past its {UPGRADE_WINDOW} deadline.
    error DohrniiUpgradeExpired(uint48 expiresAt);

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialises the token: mints the full supply and hands every role to `_owner`.
     * @param _owner The owner wallet. Becomes default admin (and `owner()`) and holds the
     *        blacklist, feature and upgrader roles so it can operate the token unaided or
     *        delegate any of them later.
     * @param _supplyRecipient Wallet that receives the entire {TOTAL_SUPPLY}.
     * @param _initialAdminDelay Delay enforced on a later transfer of the default admin role, in
     *        seconds. Must not exceed {MAX_ADMIN_DELAY}, as must any later change through
     *        {changeDefaultAdminDelay}.
     */
    function initialize(address _owner, address _supplyRecipient, uint48 _initialAdminDelay) external initializer {
        if (_owner == address(0) || _supplyRecipient == address(0)) revert DohrniiZeroAddress();
        _checkAdminDelay(_initialAdminDelay);

        __ERC20_init("Dohrnii", "DHN");
        __AccessControlDefaultAdminRules_init(_initialAdminDelay, _owner);

        _grantRole(BLACKLIST_MANAGER_ROLE, _owner);
        _grantRole(FEATURE_MANAGER_ROLE, _owner);
        _grantRole(UPGRADER_ROLE, _owner);

        _getDohrniiTokenStorage().blacklistEnabled = true;
        emit BlacklistEnabledUpdated(true);

        _mint(_supplyRecipient, TOTAL_SUPPLY);
    }

    /// @notice Implementation version, for operators and block explorers.
    function version() external pure virtual returns (string memory) {
        return "1.0.0";
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /**
     * @notice Whether `account` is blacklisted. Only enforced while {blacklistEnabled} is true.
     * @param account Address to look up.
     */
    function isBlacklisted(address account) public view returns (bool) {
        return _getDohrniiTokenStorage().blacklist[account];
    }

    /// @notice Whether the blacklist is currently enforced on transfers.
    function blacklistEnabled() public view returns (bool) {
        return _getDohrniiTokenStorage().blacklistEnabled;
    }

    /**
     * @notice The upgrade currently committed to, if any.
     * @return implementation Committed implementation. Zero when nothing is scheduled.
     * @return callDataHash keccak256 of the `data` the upgrade must be executed with.
     * @return executableAt Timestamp from which it may be executed.
     * @return expiresAt Timestamp after which it can no longer be executed.
     */
    function pendingUpgrade()
        public
        view
        returns (address implementation, bytes32 callDataHash, uint48 executableAt, uint48 expiresAt)
    {
        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();
        executableAt = $.upgradeSchedule;

        return (
            $.pendingImplementation,
            $.pendingUpgradeCallHash,
            executableAt,
            executableAt == 0 ? 0 : executableAt + UPGRADE_WINDOW
        );
    }

    /**
     * @notice Last timestamp at which a pending ownership transfer can still be accepted.
     * @return deadline The deadline, or zero when no transfer is pending.
     */
    function defaultAdminTransferDeadline() public view returns (uint48 deadline) {
        (, uint48 schedule) = pendingDefaultAdmin();

        return schedule == 0 ? 0 : schedule + ADMIN_ACCEPT_WINDOW;
    }

    // -------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------

    /**
     * @notice Adds or removes a single address from the blacklist.
     * @dev Emits {BlacklistUpdated} only when the stored value actually changes.
     * @param account Address to update. Must not be the zero address.
     * @param blacklisted True to blacklist, false to clear.
     */
    function setBlacklisted(address account, bool blacklisted) external onlyRole(BLACKLIST_MANAGER_ROLE) {
        _setBlacklisted(account, blacklisted);
    }

    /**
     * @notice Batch form of {setBlacklisted}, applying the same status to every address.
     * @param accounts Addresses to update. None may be the zero address.
     * @param blacklisted True to blacklist, false to clear.
     */
    function setBlacklistedBatch(address[] calldata accounts, bool blacklisted)
        external
        onlyRole(BLACKLIST_MANAGER_ROLE)
    {
        for (uint256 i = 0; i < accounts.length; ++i) {
            _setBlacklisted(accounts[i], blacklisted);
        }
    }

    /**
     * @notice Schedules a new ownership-transfer delay, capped at {MAX_ADMIN_DELAY}.
     * @dev Adds the {MAX_ADMIN_DELAY} bound the base contract does not apply. Without it the
     *      default admin could schedule an arbitrarily large delay, which becomes effective after
     *      at most `defaultAdminDelayIncreaseWait()` and then takes roughly its own length to
     *      unwind, locking admin rotation for months or years. Everything else — who may call,
     *      when the value takes effect, and the `rollbackDefaultAdminDelay` escape hatch — is
     *      unchanged and handled by the parent.
     * @param newDelay New delay in seconds. Must not exceed {MAX_ADMIN_DELAY}.
     */
    function changeDefaultAdminDelay(uint48 newDelay) public virtual override {
        _checkAdminDelay(newDelay);
        super.changeDefaultAdminDelay(newDelay);
    }

    /**
     * @notice Switches blacklist enforcement on or off, leaving the list itself untouched.
     * @param enabled True to enforce the blacklist, false to let every transfer through.
     */
    function setBlacklistEnabled(bool enabled) external onlyRole(FEATURE_MANAGER_ROLE) {
        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();
        if ($.blacklistEnabled != enabled) {
            $.blacklistEnabled = enabled;
            emit BlacklistEnabledUpdated(enabled);
        }
    }

    /**
     * @notice Accepts a pending ownership transfer, within {ADMIN_ACCEPT_WINDOW} of its schedule.
     * @dev Adds the deadline the base contract does not apply. Without it an abandoned nomination
     *      leaves a claim on {DEFAULT_ADMIN_ROLE} that stays exercisable for as long as nobody
     *      cancels it. Everything else — who may call, and the delay before acceptance opens — is
     *      unchanged and handled by the parent.
     *
     *      An expired nomination stays visible in `pendingDefaultAdmin()` until it is cancelled or
     *      replaced; it simply can no longer be accepted. A nomination that is still wanted after
     *      expiry is renewed by calling `beginDefaultAdminTransfer` again.
     */
    function acceptDefaultAdminTransfer() public virtual override {
        (, uint48 schedule) = pendingDefaultAdmin();

        // schedule == 0 means nothing is pending, which is the parent's error to raise, not ours.
        if (schedule != 0) {
            uint48 deadline = schedule + ADMIN_ACCEPT_WINDOW;
            if (block.timestamp > deadline) revert DohrniiAdminTransferExpired(schedule, deadline);
        }

        super.acceptDefaultAdminTransfer();
    }

    /**
     * @notice Commits to an upgrade, executable after {UPGRADE_DELAY} and before
     *         {UPGRADE_WINDOW} closes. Replaces any earlier commitment.
     * @dev The call data is committed to by hash, so a `reinitializer` and its arguments are fixed
     *      at scheduling time rather than chosen at execution: the delay would otherwise only
     *      cover which code runs, not what it is told to do.
     * @param newImplementation Implementation to upgrade to. Must not be the zero address.
     * @param data Call data to run on the new implementation, empty for none. Whatever is passed
     *        to {upgradeToAndCall} must hash to the same value.
     */
    function scheduleUpgrade(address newImplementation, bytes calldata data) external onlyRole(UPGRADER_ROLE) {
        if (newImplementation == address(0)) revert DohrniiZeroAddress();

        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();
        uint48 executableAt = uint48(block.timestamp) + UPGRADE_DELAY;
        bytes32 callDataHash = keccak256(data);

        $.pendingImplementation = newImplementation;
        $.pendingUpgradeCallHash = callDataHash;
        $.upgradeSchedule = executableAt;

        emit UpgradeScheduled(newImplementation, callDataHash, executableAt, executableAt + UPGRADE_WINDOW);
    }

    /**
     * @notice Cancels the scheduled upgrade.
     * @dev Open to {UPGRADER_ROLE} and to the default admin: the delay is only worth something if
     *      ownership can veto an upgrade it does not want while the delay is running. The revert
     *      names {UPGRADER_ROLE} for an unauthorised caller, as the role the call is about.
     */
    function cancelScheduledUpgrade() external {
        if (!hasRole(UPGRADER_ROLE, _msgSender()) && !hasRole(DEFAULT_ADMIN_ROLE, _msgSender())) {
            revert AccessControlUnauthorizedAccount(_msgSender(), UPGRADER_ROLE);
        }

        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();
        address implementation = $.pendingImplementation;
        if (implementation == address(0)) revert DohrniiNoScheduledUpgrade();

        _clearScheduledUpgrade();

        emit UpgradeCancelled(implementation);
    }

    /**
     * @notice Upgrades the proxy to the implementation committed to by {scheduleUpgrade}.
     * @dev The role check runs first so an unauthorised caller always gets
     *      `AccessControlUnauthorizedAccount` rather than a complaint about the commitment, and
     *      `onlyProxy` is restated so a direct call on the implementation still fails on that
     *      before any storage is read. The commitment is cleared before control passes to the new
     *      implementation, so nothing in this namespace is written after that point.
     * @param newImplementation Must equal the scheduled implementation.
     * @param data Must hash to the scheduled call data.
     */
    function upgradeToAndCall(address newImplementation, bytes memory data)
        public
        payable
        virtual
        override
        onlyProxy
    {
        _checkRole(UPGRADER_ROLE);

        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();

        uint48 executableAt = $.upgradeSchedule;
        if (executableAt == 0) revert DohrniiNoScheduledUpgrade();

        bytes32 callDataHash = keccak256(data);
        if (newImplementation != $.pendingImplementation || callDataHash != $.pendingUpgradeCallHash) {
            revert DohrniiUpgradeNotScheduled(newImplementation, callDataHash);
        }

        if (block.timestamp < executableAt) revert DohrniiUpgradeNotReady(executableAt);

        uint48 expiresAt = executableAt + UPGRADE_WINDOW;
        if (block.timestamp > expiresAt) revert DohrniiUpgradeExpired(expiresAt);

        _clearScheduledUpgrade();

        super.upgradeToAndCall(newImplementation, data);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @dev Rejects transfers involving a blacklisted address, then performs the balance update.
    function _update(address from, address to, uint256 value) internal virtual override {
        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();

        if ($.blacklistEnabled) {
            if ($.blacklist[from]) revert DohrniiBlacklistedAddress(from);
            if ($.blacklist[to]) revert DohrniiBlacklistedAddress(to);
        }

        super._update(from, to, value);
    }

    /**
     * @dev Rejects an allowance spend by a blacklisted spender. Only reached from `transferFrom`,
     *      so a plain `transfer` is still governed by {_update} alone.
     *
     *      Two deliberate details. The check sits before the parent call because the parent
     *      short-circuits on an infinite allowance, and a check placed after it would be skipped
     *      by every `approve(spender, type(uint256).max)`. And `_approve` is left unguarded, so a
     *      holder can always revoke an allowance it granted to an address that was blacklisted
     *      afterwards — the one action such a holder needs to be able to take.
     */
    function _spendAllowance(address holder, address spender, uint256 value) internal virtual override {
        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();

        if ($.blacklistEnabled && $.blacklist[spender]) revert DohrniiBlacklistedAddress(spender);

        super._spendAllowance(holder, spender, value);
    }

    /// @dev Rejects an ownership-transfer delay that could not be undone in reasonable time.
    function _checkAdminDelay(uint48 delay) private pure {
        if (delay > MAX_ADMIN_DELAY) revert DohrniiAdminDelayTooLong(delay, MAX_ADMIN_DELAY);
    }

    function _setBlacklisted(address account, bool blacklisted) private {
        if (account == address(0)) revert DohrniiZeroAddress();

        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();
        if ($.blacklist[account] != blacklisted) {
            $.blacklist[account] = blacklisted;
            emit BlacklistUpdated(account, blacklisted);
        }
    }

    /// @notice Clears the pending upgrade commitment.
    function _clearScheduledUpgrade() private {
        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();

        delete $.pendingImplementation;
        delete $.upgradeSchedule;
        delete $.pendingUpgradeCallHash;
    }

    /// @dev Only {UPGRADER_ROLE} may point the proxy at a new implementation. Timing and the
    ///      commitment itself are enforced in {upgradeToAndCall}, the only path that reaches here.
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal virtual override onlyRole(UPGRADER_ROLE) {}
}
