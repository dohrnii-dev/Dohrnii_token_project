/**
 * Upgrades an existing DHN proxy to a new implementation.
 *
 *   PROXY_ADDRESS=0x... NEW_IMPLEMENTATION_CONTRACT=DohrniiTokenV2 \
 *     npx hardhat run scripts/upgrade.ts --network sepolia
 *
 * The signer must hold UPGRADER_ROLE on the proxy. Set PREPARE_ONLY=true to deploy and validate
 * the new implementation without touching the proxy — the right mode when the upgrade transaction
 * itself is executed from a multisig or hardware wallet.
 *
 * The new implementation is verified on Etherscan at the end of the run, in both modes. Set
 * SKIP_VERIFY=true to skip that step.
 */
import hre from "hardhat";
import { upgrades as upgradesFactory } from "@openzeppelin/hardhat-upgrades";
import { isAddress } from "ethers";

import { verifyDeployment } from "./verify.js";

async function main() {
  const connection = await hre.network.getOrCreate();
  const { ethers } = connection;
  const upgrades = await upgradesFactory(hre, connection);

  const proxyAddress = process.env.PROXY_ADDRESS;
  const contractName = process.env.NEW_IMPLEMENTATION_CONTRACT;
  const prepareOnly = process.env.PREPARE_ONLY === "true";

  if (proxyAddress === undefined || !isAddress(proxyAddress)) {
    throw new Error(`PROXY_ADDRESS is missing or invalid: ${proxyAddress ?? "<unset>"}`);
  }
  if (contractName === undefined) {
    throw new Error("NEW_IMPLEMENTATION_CONTRACT is required (e.g. DohrniiTokenV2)");
  }

  const [signer] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory(contractName, signer);

  // Fails loudly on any storage-layout incompatibility before anything is sent on chain.
  await upgrades.validateUpgrade(proxyAddress, Factory, { kind: "uups" });
  console.log(`storage layout of ${contractName} is compatible with ${proxyAddress}`);

  const { chainId } = await ethers.provider.getNetwork();

  if (prepareOnly) {
    const implementation = await upgrades.prepareUpgrade(proxyAddress, Factory, { kind: "uups" });
    console.log(`new implementation deployed: ${implementation as string}`);
    console.log("Execute from the upgrader wallet:");
    console.log(`  proxy.upgradeToAndCall(${implementation as string}, "0x")`);

    // Verify the implementation now, so the sources are public before the upgrade is executed.
    await verifyDeployment(hre, chainId, implementation as string, null);
    return;
  }

  const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, { kind: "uups" });
  await upgraded.waitForDeployment();

  console.log(`proxy:          ${proxyAddress}`);
  console.log(
    `implementation: ${await upgrades.erc1967.getImplementationAddress(proxyAddress)}`,
  );
  console.log(`version():      ${await upgraded.getFunction("version")()}`);

  // Verifying the proxy re-runs verification for whatever implementation it now points at.
  await verifyDeployment(hre, chainId, proxyAddress, upgraded.deploymentTransaction());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
