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
 *   send nor receive DHN. {FEATURE_MANAGER_ROLE} can switch the whole check off without
 *   clearing the list.
 * - Storage: all state introduced by this contract lives in a single ERC-7201 namespaced
 *   struct, so a future upgrade can add its own namespace without any storage-layout
 *   migration on the live token.
 * - Access control: {AccessControlDefaultAdminRulesUpgradeable} gives a single owner wallet
 *   (the default admin, also exposed as {owner} per ERC-5313) plus two-step, time-delayed
 *   transfer of that admin — the Ownable2Step guarantee — while still allowing granular roles.
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

    // -------------------------------------------------------------------------
    // ERC-7201 namespaced storage
    // -------------------------------------------------------------------------

    /// @custom:storage-location erc7201:dohrnii.storage.DohrniiToken
    struct DohrniiTokenStorage {
        /// @dev Whether the blacklist is enforced on transfers.
        bool blacklistEnabled;
        /// @dev Blacklisted addresses.
        mapping(address account => bool blacklisted) blacklist;
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

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    /// @dev A party to the transfer is blacklisted.
    error DohrniiBlacklistedAddress(address account);

    /// @dev The zero address is not a valid argument here.
    error DohrniiZeroAddress();

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
     * @param _initialAdminDelay Delay enforced on a later transfer of the default admin role.
     */
    function initialize(address _owner, address _supplyRecipient, uint48 _initialAdminDelay) external initializer {
        if (_owner == address(0) || _supplyRecipient == address(0)) revert DohrniiZeroAddress();

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

    function _setBlacklisted(address account, bool blacklisted) private {
        if (account == address(0)) revert DohrniiZeroAddress();

        DohrniiTokenStorage storage $ = _getDohrniiTokenStorage();
        if ($.blacklist[account] != blacklisted) {
            $.blacklist[account] = blacklisted;
            emit BlacklistUpdated(account, blacklisted);
        }
    }

    /// @dev Only {UPGRADER_ROLE} may point the proxy at a new implementation.
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal virtual override onlyRole(UPGRADER_ROLE) {}
}
