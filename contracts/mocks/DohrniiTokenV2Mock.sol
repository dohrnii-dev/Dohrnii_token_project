// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {DohrniiToken} from "../DohrniiToken.sol";

/**
 * @title DohrniiTokenV2Mock
 * @notice Test-only upgrade that proves a deferred feature (here: pause) can be added on top of
 *         the live token through the UUPS path, using its own ERC-7201 namespace and therefore
 *         requiring no storage-layout migration.
 * @dev Not for production. It exists so the upgrade tests exercise a realistic V2 shape:
 *      a new namespace, a new role, and an extended `_update` hook.
 *
 *      It is only ever deployed as an upgrade of an already-initialised proxy: the V1 state is in
 *      place and `initialize` is inherited, so it defines a `reinitializer` for the new state
 *      instead of a fresh initializer — hence the skipped missing-initializer check.
 * @custom:oz-upgrades-unsafe-allow missing-initializer
 */
contract DohrniiTokenV2Mock is DohrniiToken {
    /// @notice Can pause and unpause transfers.
    bytes32 public constant PAUSER_ROLE = keccak256("DHN_PAUSER_ROLE");

    /// @custom:storage-location erc7201:dohrnii.storage.DohrniiTokenV2Mock
    struct DohrniiTokenV2Storage {
        bool paused;
    }

    // keccak256(abi.encode(uint256(keccak256("dohrnii.storage.DohrniiTokenV2Mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant _DOHRNII_TOKEN_V2_STORAGE_LOCATION =
        0x18e122a75ad311607ff39e03fda78de2b881a7661f275d11ff1d4ef7e2ccc000;

    /**
     * @notice Emitted when the pause flag changes.
     * @param paused The new pause state.
     */
    event PausedUpdated(bool paused);

    /// @dev Transfers are paused.
    error DohrniiTransfersPaused();

    function _getDohrniiTokenV2Storage() private pure returns (DohrniiTokenV2Storage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := _DOHRNII_TOKEN_V2_STORAGE_LOCATION
        }
    }

    /// @notice Post-upgrade initialiser: grants the new role to the default admin.
    /// @dev A `reinitializer`, not an initializer: the parent state is already set on the live
    ///      proxy, so parent initialisers must not run again.
    /// @param pauser Address granted {PAUSER_ROLE}.
    function initializeV2(address pauser) external reinitializer(2) onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @notice Implementation version, for operators and block explorers.
    function version() external pure virtual override returns (string memory) {
        return "2.0.0-mock";
    }

    /// @notice Whether transfers are currently paused.
    function paused() public view returns (bool) {
        return _getDohrniiTokenV2Storage().paused;
    }

    /**
     * @notice Pauses or unpauses all transfers.
     * @param value True to pause, false to resume.
     */
    function setPaused(bool value) external onlyRole(PAUSER_ROLE) {
        DohrniiTokenV2Storage storage $ = _getDohrniiTokenV2Storage();
        if ($.paused != value) {
            $.paused = value;
            emit PausedUpdated(value);
        }
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (paused()) revert DohrniiTransfersPaused();
        super._update(from, to, value);
    }
}
