import hre from "hardhat";
import { upgrades as upgradesFactory } from "@openzeppelin/hardhat-upgrades";

/**
 * A single network connection shared by every test, with the OpenZeppelin upgrades API bound to
 * it. Hardhat 3 exposes `ethers` and `networkHelpers` per connection, and the upgrades plugin
 * asks for one connection to be reused across operations rather than created per call.
 */
export async function connect() {
  const connection = await hre.network.getOrCreate();
  const upgrades = await upgradesFactory(hre, connection);
  return {
    ethers: connection.ethers,
    networkHelpers: connection.networkHelpers,
    upgrades,
  };
}

/** 372,000,000 DHN in wei. */
export const TOTAL_SUPPLY = 372_000_000n * 10n ** 18n;

/** Delay used for the default-admin (owner) two-step transfer in tests. Matches the deploy default. */
export const ADMIN_DELAY = 3n * 60n * 60n; // 3 hours
