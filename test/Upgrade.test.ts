import { expect } from "chai";
import { connect, TOTAL_SUPPLY, ADMIN_DELAY } from "./helpers.js";

describe("DohrniiToken — UUPS upgrade path", () => {
  async function deployFixture() {
    const { ethers, upgrades } = await connect();
    const [, owner, treasury, alice, bob] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DohrniiToken");
    const token = await upgrades.deployProxy(
      Factory,
      [owner.address, treasury.address, ADMIN_DELAY],
      { kind: "uups" },
    );
    await token.waitForDeployment();

    // State that must survive the upgrade untouched.
    await token.connect(treasury).transfer(alice.address, ethers.parseEther("1000"));
    await token.connect(owner).setBlacklisted(bob.address, true);

    return { ethers, upgrades, token, owner, treasury, alice, bob };
  }

  async function fixture() {
    const { networkHelpers } = await connect();
    return networkHelpers.loadFixture(deployFixture);
  }

  it("passes the storage-layout compatibility check", async () => {
    const { ethers, upgrades, token } = await fixture();
    const FactoryV2 = await ethers.getContractFactory("DohrniiTokenV2Mock");
    await upgrades.validateUpgrade(await token.getAddress(), FactoryV2, { kind: "uups" });
  });

  it("upgrades and preserves balances, blacklist and roles", async () => {
    const { ethers, upgrades, token, owner, treasury, alice, bob } = await fixture();
    const proxyAddress = await token.getAddress();
    const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    const FactoryV2 = await ethers.getContractFactory("DohrniiTokenV2Mock", owner);
    const tokenV2 = await upgrades.upgradeProxy(proxyAddress, FactoryV2, { kind: "uups" });
    await tokenV2.waitForDeployment();

    expect(await tokenV2.getAddress()).to.equal(proxyAddress);
    expect(await upgrades.erc1967.getImplementationAddress(proxyAddress)).to.not.equal(implBefore);

    expect(await tokenV2.version()).to.equal("2.0.0-mock");
    expect(await tokenV2.name()).to.equal("Dohrnii");
    expect(await tokenV2.symbol()).to.equal("DHN");
    expect(await tokenV2.totalSupply()).to.equal(TOTAL_SUPPLY);
    expect(await tokenV2.balanceOf(alice.address)).to.equal(ethers.parseEther("1000"));
    expect(await tokenV2.balanceOf(treasury.address)).to.equal(
      TOTAL_SUPPLY - ethers.parseEther("1000"),
    );
    expect(await tokenV2.isBlacklisted(bob.address)).to.equal(true);
    expect(await tokenV2.blacklistEnabled()).to.equal(true);
    expect(await tokenV2.owner()).to.equal(owner.address);
    expect(await tokenV2.hasRole(await tokenV2.UPGRADER_ROLE(), owner.address)).to.equal(true);

    // The V1 blacklist still bites after the upgrade.
    await expect(
      tokenV2.connect(bob).transfer(alice.address, 1n),
    ).to.be.revertedWithCustomError(tokenV2, "DohrniiBlacklistedAddress");
  });

  it("rejects an upgrade from an account without UPGRADER_ROLE", async () => {
    const { ethers, upgrades, token, alice } = await fixture();
    const FactoryV2 = await ethers.getContractFactory("DohrniiTokenV2Mock");
    const newImpl = await upgrades.deployImplementation(FactoryV2, { kind: "uups" });

    await expect(token.connect(alice).upgradeToAndCall(newImpl as string, "0x"))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(alice.address, await token.UPGRADER_ROLE());
  });

  it("lets the owner delegate upgrade rights and take them back", async () => {
    const { ethers, upgrades, token, owner, alice } = await fixture();
    const proxyAddress = await token.getAddress();
    const upgraderRole = await token.UPGRADER_ROLE();

    await token.connect(owner).grantRole(upgraderRole, alice.address);
    const FactoryV2 = await ethers.getContractFactory("DohrniiTokenV2Mock", alice);
    await upgrades.upgradeProxy(proxyAddress, FactoryV2, { kind: "uups" });
    expect(await token.version()).to.equal("2.0.0-mock");

    await token.connect(owner).revokeRole(upgraderRole, alice.address);
    const impl = await upgrades.deployImplementation(
      await ethers.getContractFactory("DohrniiToken"),
      { kind: "uups" },
    );
    await expect(
      token.connect(alice).upgradeToAndCall(impl as string, "0x"),
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("adds a new feature in its own ERC-7201 namespace without touching the V1 namespace", async () => {
    const { ethers, upgrades, token, owner, treasury, alice } = await fixture();
    const proxyAddress = await token.getAddress();

    const FactoryV2 = await ethers.getContractFactory("DohrniiTokenV2Mock", owner);
    const tokenV2 = await upgrades.upgradeProxy(proxyAddress, FactoryV2, { kind: "uups" });

    await tokenV2.connect(owner).initializeV2(owner.address);
    expect(await tokenV2.hasRole(await tokenV2.PAUSER_ROLE(), owner.address)).to.equal(true);

    // New state lives in the V2 namespace...
    await tokenV2.connect(owner).setPaused(true);
    expect(await tokenV2.paused()).to.equal(true);
    await expect(tokenV2.connect(alice).transfer(treasury.address, 1n)).to.be.revertedWithCustomError(
      tokenV2,
      "DohrniiTransfersPaused",
    );

    // ...while the V1 namespace is byte-for-byte where it was.
    const base = namespaceSlot(ethers, "dohrnii.storage.DohrniiToken");
    const v2Base = namespaceSlot(ethers, "dohrnii.storage.DohrniiTokenV2Mock");
    expect(BigInt(await ethers.provider.getStorage(proxyAddress, base))).to.equal(1n);
    expect(BigInt(await ethers.provider.getStorage(proxyAddress, v2Base))).to.equal(1n);

    await tokenV2.connect(owner).setPaused(false);
    await expect(tokenV2.connect(alice).transfer(treasury.address, 1n)).to.not.revert(ethers);
  });

  it("runs initializeV2 once, and only for the default admin", async () => {
    const { ethers, upgrades, token, owner, alice } = await fixture();
    const FactoryV2 = await ethers.getContractFactory("DohrniiTokenV2Mock", owner);
    const tokenV2 = await upgrades.upgradeProxy(await token.getAddress(), FactoryV2, {
      kind: "uups",
    });

    await expect(
      tokenV2.connect(alice).initializeV2(alice.address),
    ).to.be.revertedWithCustomError(tokenV2, "AccessControlUnauthorizedAccount");

    await tokenV2.connect(owner).initializeV2(owner.address);
    await expect(
      tokenV2.connect(owner).initializeV2(owner.address),
    ).to.be.revertedWithCustomError(tokenV2, "InvalidInitialization");
  });
});

/** ERC-7201 slot for a namespace id. */
function namespaceSlot(ethers: { keccak256: (v: Uint8Array | string) => string; toUtf8Bytes: (v: string) => Uint8Array; AbiCoder: { defaultAbiCoder: () => { encode: (t: string[], v: unknown[]) => string } } }, namespace: string): bigint {
  const inner = BigInt(ethers.keccak256(ethers.toUtf8Bytes(namespace))) - 1n;
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [inner]);
  return BigInt(ethers.keccak256(encoded)) & ~0xffn;
}
