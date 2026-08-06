// Hardhat 3 does not read .env by itself, and this config is loaded before any script runs, so
// loading it here populates process.env for both `configVariable(...)` below and scripts/*.ts.
import dotenv from "dotenv";

dotenv.config({ quiet: true });

import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";

import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatUpgrades from "@openzeppelin/hardhat-upgrades";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxMochaEthers, hardhatUpgrades],

  // The two profiles must stay byte-for-byte identical: `run` and `test` build with `default`,
  // while `verify` always builds with `production`. Any difference (optimizer runs, evmVersion,
  // metadata) makes verification fail with a bytecode mismatch on an otherwise correct deployment.
  solidity: {
    profiles: {
      default: {
        version: "0.8.36",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
        },
      },
      production: {
        version: "0.8.36",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
        },
      },
    },
  },

  networks: {
    // In-process EVM used by the unit tests.
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Mainnet fork for sanity checks: `npx hardhat test mocha --network mainnetFork`
    // or `npx hardhat console --network mainnetFork`.
    mainnetFork: {
      type: "edr-simulated",
      chainType: "l1",
      forking: {
        url: configVariable("MAINNET_RPC_URL"),
      },
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    mainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("MAINNET_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },

  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
    // Etherscan is the deliverable; flip either of these to `true` to publish sources there too.
    blockscout: { enabled: false },
    sourcify: { enabled: false },
  },
};

export default config;
