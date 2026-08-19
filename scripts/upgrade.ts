/**
 * Drives the two-step upgrade of an existing DHN proxy.
 *
 * Upgrades are time-delayed on chain: `scheduleUpgrade(impl, data)` commits to an implementation
 * and to the exact call data it will be executed with, and `upgradeToAndCall(impl, data)` becomes
 * possible only after UPGRADE_DELAY and only until UPGRADE_WINDOW closes. This script covers both
 * steps, plus a prepare-only mode for when a multisig or hardware wallet holds UPGRADER_ROLE.
 *
 *   # step 1 — deploy the implementation and commit to it
 *   PROXY_ADDRESS=0x... NEW_IMPLEMENTATION_CONTRACT=DohrniiTokenV2 \
 *     npx hardhat run scripts/upgrade.ts --network sepolia
 *
 *   # step 2 — once the delay has passed, execute what was committed to
 *   PROXY_ADDRESS=0x... EXECUTE=true \
 *     npx hardhat run scripts/upgrade.ts --network sepolia
 *
 * UPGRADE_CALLDATA sets the `data` for both steps and must be identical in each; leave it unset
 * for a plain code swap. PREPARE_ONLY=true deploys and validates the implementation, prints both
 * calls and touches nothing on the proxy. SKIP_VERIFY=true skips Etherscan verification.
 *
 * The signer must hold UPGRADER_ROLE on the proxy for the on-chain steps.
 */
import hre from "hardhat";
import { upgrades as upgradesFactory } from "@openzeppelin/hardhat-upgrades";
import { isAddress, isHexString, keccak256 } from "ethers";

import { verifyDeployment } from "./verify.js";

async function main() {
  const connection = await hre.network.getOrCreate();
  const { ethers } = connection;
  const upgrades = await upgradesFactory(hre, connection);

  const proxyAddress = process.env.PROXY_ADDRESS;
  const contractName = process.env.NEW_IMPLEMENTATION_CONTRACT;
  const prepareOnly = process.env.PREPARE_ONLY === "true";
  const execute = process.env.EXECUTE === "true";
  const callData = process.env.UPGRADE_CALLDATA ?? "0x";

  if (proxyAddress === undefined || !isAddress(proxyAddress)) {
    throw new Error(`PROXY_ADDRESS is missing or invalid: ${proxyAddress ?? "<unset>"}`);
  }
  if (!isHexString(callData)) {
    throw new Error(`UPGRADE_CALLDATA must be a hex string, got: ${callData}`);
  }

  const [signer] = await ethers.getSigners();
  const proxy = await ethers.getContractAt("DohrniiToken", proxyAddress, signer);
  const { chainId } = await ethers.provider.getNetwork();

  // ---------------------------------------------------------------- step 2: execute
  if (execute) {
    const [implementation, committedHash, executableAt, expiresAt] = await proxy.pendingUpgrade();
    if (implementation === ethers.ZeroAddress) {
      throw new Error(`no upgrade is scheduled on ${proxyAddress}`);
    }
    if (keccak256(callData) !== committedHash) {
      throw new Error(
        `UPGRADE_CALLDATA does not match the commitment: expected hash ${committedHash as string}, ` +
          `got ${keccak256(callData)}. Pass the same data that was scheduled.`,
      );
    }

    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    if (now < executableAt) {
      throw new Error(
        `too early: executable at ${executableAt as bigint} (in ${(executableAt as bigint) - now}s)`,
      );
    }
    if (now > expiresAt) {
      throw new Error(`commitment expired at ${expiresAt as bigint}; schedule the upgrade again`);
    }

    const tx = await proxy.upgradeToAndCall(implementation, callData);
    await tx.wait();

    console.log(`proxy:          ${proxyAddress}`);
    console.log(
      `implementation: ${await upgrades.erc1967.getImplementationAddress(proxyAddress)}`,
    );
    console.log(`version():      ${await proxy.getFunction("version")()}`);

    // Verifying the proxy re-runs verification for whatever implementation it now points at.
    await verifyDeployment(hre, chainId, proxyAddress, tx);
    return;
  }

  // ---------------------------------------------------------------- step 1: deploy and commit
  if (contractName === undefined) {
    throw new Error("NEW_IMPLEMENTATION_CONTRACT is required (e.g. DohrniiTokenV2)");
  }

  const Factory = await ethers.getContractFactory(contractName, signer);

  // Fails loudly on any storage-layout incompatibility before anything is sent on chain.
  await upgrades.validateUpgrade(proxyAddress, Factory, { kind: "uups" });
  console.log(`storage layout of ${contractName} is compatible with ${proxyAddress}`);

  const implementation = (await upgrades.deployImplementation(Factory, { kind: "uups" })) as string;
  console.log(`new implementation deployed: ${implementation}`);

  // Verify now, so the sources are public for the whole delay rather than only afterwards.
  await verifyDeployment(hre, chainId, implementation, null);

  if (prepareOnly) {
    console.log("Execute from the upgrader wallet, in this order:");
    console.log(`  1. proxy.scheduleUpgrade("${implementation}", "${callData}")`);
    console.log(`  2. after UPGRADE_DELAY: proxy.upgradeToAndCall("${implementation}", "${callData}")`);
    return;
  }

  const tx = await proxy.scheduleUpgrade(implementation, callData);
  await tx.wait();

  const [, , executableAt, expiresAt] = await proxy.pendingUpgrade();
  console.log(`scheduled ${implementation} on ${proxyAddress}`);
  console.log(`  executable from: ${new Date(Number(executableAt) * 1000).toISOString()}`);
  console.log(`  expires at:      ${new Date(Number(expiresAt) * 1000).toISOString()}`);
  console.log("Then run the same command again with EXECUTE=true (and the same UPGRADE_CALLDATA).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
