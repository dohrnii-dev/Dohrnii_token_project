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

/** `DohrniiToken.ADMIN_ACCEPT_WINDOW` — how long a scheduled ownership transfer stays claimable. */
export const ADMIN_ACCEPT_WINDOW = 30n * 24n * 60n * 60n; // 30 days

/** `DohrniiToken.UPGRADE_DELAY` — wait between scheduling an upgrade and executing it. */
export const UPGRADE_DELAY = 24n * 60n * 60n; // 1 day

/** `DohrniiToken.UPGRADE_WINDOW` — how long a scheduled upgrade stays executable. */
export const UPGRADE_WINDOW = 30n * 24n * 60n * 60n; // 30 days

/** The signer type produced by the shared connection. */
export type TestSigner = Awaited<
  ReturnType<Awaited<ReturnType<typeof connect>>["ethers"]["getSigners"]>
>[number];

/** The shared connection, as returned by {@link connect}. */
export type TestContext = Awaited<ReturnType<typeof connect>>;

/**
 * Loose contract handle. `ethers.getContractAt` is typed as returning `BaseContract`, which loses
 * the generated method names as soon as `.connect(signer)` is chained, so tests go through
 * {@link contractAt} and get this instead.
 */
export type AnyContract = {
  getAddress(): Promise<string>;
  connect(runner: TestSigner): AnyContract;
  // Named explicitly: the chai matchers require it, and an index signature does not satisfy a
  // required property.
  interface: any;
  [member: string]: any;
};

/** `ethers.getContractAt`, typed so generated methods survive a `.connect()` chain. */
export async function contractAt(
  ctx: TestContext,
  name: string,
  address: string,
): Promise<AnyContract> {
  return (await ctx.ethers.getContractAt(name, address)) as unknown as AnyContract;
}

/**
 * Runs the full upgrade path: validate the layout, deploy the implementation, commit to it, wait
 * out `UPGRADE_DELAY` and execute. Returns the proxy bound to `contractName`'s ABI.
 *
 * Every upgrade needs the two-step flow, so tests go through this rather than through
 * `upgrades.upgradeProxy`, which sends `upgradeToAndCall` on its own with nothing scheduled.
 */
export async function performUpgrade(
  ctx: TestContext,
  proxyAddress: string,
  contractName: string,
  upgrader: TestSigner,
  data = "0x",
) {
  const { networkHelpers } = ctx;
  const implementation = await deployImplementationFor(ctx, proxyAddress, contractName, upgrader);

  const proxy = await contractAt(ctx, contractName, proxyAddress);
  await proxy.connect(upgrader).scheduleUpgrade(implementation, data);
  await networkHelpers.time.increase(UPGRADE_DELAY);
  await proxy.connect(upgrader).upgradeToAndCall(implementation, data);

  return proxy;
}

/** Validates `contractName` against the live layout and deploys it as an upgrade candidate. */
export async function deployImplementationFor(
  ctx: TestContext,
  proxyAddress: string,
  contractName: string,
  deployer?: TestSigner,
): Promise<string> {
  const { ethers, upgrades } = ctx;
  const Factory = await ethers.getContractFactory(contractName, deployer);
  await upgrades.validateUpgrade(proxyAddress, Factory, { kind: "uups" });

  return (await upgrades.deployImplementation(Factory, { kind: "uups" })) as string;
}
