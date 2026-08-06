/**
 * Post-deployment source verification, shared by the deploy and upgrade scripts.
 *
 * Verification is deliberately non-fatal: by the time it runs, the deployment or upgrade has
 * already succeeded on chain, so a rate-limited or not-yet-indexed explorer must not make the
 * script look like it failed. On failure the manual command is printed instead.
 */
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { ContractTransactionResponse } from "ethers";

/** Chain ids with no public explorer: the in-process and standalone Hardhat networks. */
const LOCAL_CHAIN_IDS = new Set([31337n, 1337n]);

const DEFAULT_CONFIRMATIONS = 5;

/**
 * Waits for the deployment to settle, then verifies it on the configured explorers.
 *
 * @param hre Hardhat runtime environment.
 * @param chainId Chain the contract was deployed to.
 * @param address Address to verify. Pass the **proxy**: `@openzeppelin/hardhat-upgrades`
 *        overrides the `verify` task so that verifying a proxy also verifies its implementation
 *        and links the two on the explorer.
 * @param deploymentTx Transaction to wait for confirmations on, or `null` to verify immediately.
 */
export async function verifyDeployment(
  hre: HardhatRuntimeEnvironment,
  chainId: bigint,
  address: string,
  deploymentTx: ContractTransactionResponse | null,
): Promise<void> {
  console.log("");

  if (process.env.SKIP_VERIFY === "true") {
    console.log("verification:     skipped (SKIP_VERIFY=true)");
    return;
  }
  if (LOCAL_CHAIN_IDS.has(chainId)) {
    console.log(`verification:     skipped (local network, chain ${chainId})`);
    return;
  }

  const confirmations = Number(process.env.VERIFY_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS);
  if (deploymentTx !== null && confirmations > 0) {
    console.log(`verification:     waiting for ${confirmations} confirmations...`);
    await deploymentTx.wait(confirmations);
  }

  // The verify task reports per-provider failures by setting a non-zero exit code rather than
  // throwing, so both paths have to be handled to keep a failed verification non-fatal.
  const previousExitCode = process.exitCode;
  try {
    await hre.tasks.getTask("verify").run({ address });
    if (process.exitCode === 1) {
      process.exitCode = previousExitCode ?? 0;
      printManualHint(hre, address);
    }
  } catch (error) {
    process.exitCode = previousExitCode ?? 0;
    console.warn(`\nverification failed: ${error instanceof Error ? error.message : String(error)}`);
    printManualHint(hre, address);
  }
}

function printManualHint(hre: HardhatRuntimeEnvironment, address: string): void {
  const network = hre.globalOptions.network ?? "<network>";
  console.warn("The deployment itself succeeded. Retry verification with:");
  console.warn(`  npx hardhat verify --network ${network} ${address}`);
}
