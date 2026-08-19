// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title AllowanceSpenderMock
 * @notice Test-only stand-in for a router: a contract that holds allowances but never a balance,
 *         and moves other accounts' tokens with `transferFrom`.
 * @dev This is the shape the blacklist has to reach to be useful in the compromised-integration
 *      scenario. Blacklisting such a contract has no effect through `_update`, because it is
 *      neither `from` nor `to` — only the spender check in `_spendAllowance` stops it.
 */
contract AllowanceSpenderMock {
    /// @notice The token this mock pulls.
    IERC20 public immutable TOKEN;

    /// @notice Binds the mock to a token.
    /// @param token The token to pull with `transferFrom`.
    constructor(IERC20 token) {
        TOKEN = token;
    }

    /**
     * @notice Pulls an approved amount, as a compromised router would.
     * @param from Account that approved this contract.
     * @param to Where the tokens go.
     * @param value Amount to pull.
     */
    function pull(address from, address to, uint256 value) external {
        TOKEN.transferFrom(from, to, value);
    }
}
