/**
 * Deploys the DHN token behind a UUPS proxy.
 *
 *   npx hardhat run scripts/deploy.ts --network sepolia
 *
 * Required environment / configuration variables:
 *   OWNER_ADDRESS             wallet that becomes default admin (`owner()`) and holds every role
 *   SUPPLY_RECIPIENT_ADDRESS  wallet that receives the full 372,000,000 DHN (defaults to OWNER_ADDRESS)
 *   ADMIN_DELAY_SECONDS       delay on a later ownership transfer (default 259200 = 3 days)
 *
 * The deployer wallet pays gas and holds no privileges afterwards: `initialize` assigns every
 * role to OWNER_ADDRESS, so no handover transaction is needed.
 */
import hre from "hardhat";
import { upgrades as upgradesFactory } from "@openzeppelin/hardhat-upgrades";
import { isAddress } from "ethers";

const DEFAULT_ADMIN_DELAY_SECONDS = 3n * 24n * 60n * 60n;

function requireAddress(name: string, value: string | undefined): string {
  if (value === undefined || !isAddress(value)) {
    throw new Error(`${name} is missing or not a valid address: ${value ?? "<unset>"}`);
  }
  return value;
}

async function main() {
  const connection = await hre.network.getOrCreate();
  const { ethers } = connection;
  const upgrades = await upgradesFactory(hre, connection);

  const owner = requireAddress("OWNER_ADDRESS", process.env.OWNER_ADDRESS);
  const supplyRecipient = requireAddress(
    "SUPPLY_RECIPIENT_ADDRESS",
    process.env.SUPPLY_RECIPIENT_ADDRESS ?? owner,
  );
  const adminDelay = process.env.ADMIN_DELAY_SECONDS
    ? BigInt(process.env.ADMIN_DELAY_SECONDS)
    : DEFAULT_ADMIN_DELAY_SECONDS;

  const [deployer] = await ethers.getSigners();
  console.log(`network:          ${hre.globalOptions.network ?? "default"}`);
  console.log(`deployer:         ${deployer.address}`);
  console.log(`owner:            ${owner}`);
  console.log(`supply recipient: ${supplyRecipient}`);
  console.log(`admin delay:      ${adminDelay}s`);

  const Factory = await ethers.getContractFactory("DohrniiToken");
  const token = await upgrades.deployProxy(Factory, [owner, supplyRecipient, adminDelay], {
    kind: "uups",
  });
  await token.waitForDeployment();

  const proxyAddress = await token.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log("");
  console.log(`proxy:            ${proxyAddress}`);
  console.log(`implementation:   ${implementationAddress}`);
  console.log(`total supply:     ${ethers.formatEther(await token.totalSupply())} DHN`);
  console.log(`owner() reports:  ${await token.owner()}`);
  console.log("");
  console.log("Verify with:");
  console.log(`  npx hardhat verify --network <network> ${proxyAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
