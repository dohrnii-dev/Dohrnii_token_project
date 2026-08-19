import { expect } from "chai";
import {
  connect,
  deployImplementationFor,
  performUpgrade,
  ADMIN_DELAY,
  TOTAL_SUPPLY,
  UPGRADE_DELAY,
  UPGRADE_WINDOW,
  contractAt,
  type TestContext,
  type TestSigner,
} from "./helpers.js";

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

    return { token, owner, treasury, alice, bob };
  }

  async function fixture() {
    const ctx = await connect();
    return { ctx, ...(await ctx.networkHelpers.loadFixture(deployFixture)) };
  }

  /** Deploys a V2 implementation and commits to it, returning the address and the schedule. */
  async function schedule(
    ctx: TestContext,
    token: { getAddress(): Promise<string> },
    upgrader: TestSigner,
    data = "0x",
  ) {
    const proxyAddress = await token.getAddress();
    const implementation = await deployImplementationFor(
      ctx,
      proxyAddress,
      "DohrniiTokenV2Mock",
      upgrader,
    );
    const proxy = await contractAt(ctx, "DohrniiToken", proxyAddress);
    await proxy.connect(upgrader).scheduleUpgrade(implementation, data);
    const [, , executableAt, expiresAt] = await proxy.pendingUpgrade();

    return { proxy, implementation, executableAt, expiresAt };
  }

  describe("layout and state", () => {
    it("passes the storage-layout compatibility check", async () => {
      const { ctx, token } = await fixture();
      const FactoryV2 = await ctx.ethers.getContractFactory("DohrniiTokenV2Mock");
      await ctx.upgrades.validateUpgrade(await token.getAddress(), FactoryV2, { kind: "uups" });
    });

    it("upgrades and preserves balances, blacklist and roles", async () => {
      const { ctx, token, owner, treasury, alice, bob } = await fixture();
      const { ethers, upgrades } = ctx;
      const proxyAddress = await token.getAddress();
      const implBefore = await upgrades.erc1967.getImplementationAddress(proxyAddress);

      const tokenV2 = await performUpgrade(ctx, proxyAddress, "DohrniiTokenV2Mock", owner);

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

    it("adds a new feature in its own ERC-7201 namespace without touching the V1 namespace", async () => {
      const { ctx, token, owner, treasury, alice } = await fixture();
      const { ethers } = ctx;
      const proxyAddress = await token.getAddress();

      const tokenV2 = await performUpgrade(ctx, proxyAddress, "DohrniiTokenV2Mock", owner);

      await tokenV2.connect(owner).initializeV2(owner.address);
      expect(await tokenV2.hasRole(await tokenV2.PAUSER_ROLE(), owner.address)).to.equal(true);

      // New state lives in the V2 namespace...
      await tokenV2.connect(owner).setPaused(true);
      expect(await tokenV2.paused()).to.equal(true);
      await expect(tokenV2.connect(alice).transfer(treasury.address, 1n)).to.be.revertedWithCustomError(
        tokenV2,
        "DohrniiTransfersPaused",
      );

      // ...while the V1 namespace is byte-for-byte where it was: the pending-upgrade fields share
      // slot 0 with blacklistEnabled and were cleared when the upgrade executed.
      const base = namespaceSlot(ethers, "dohrnii.storage.DohrniiToken");
      const v2Base = namespaceSlot(ethers, "dohrnii.storage.DohrniiTokenV2Mock");
      expect(BigInt(await ethers.provider.getStorage(proxyAddress, base))).to.equal(1n);
      expect(BigInt(await ethers.provider.getStorage(proxyAddress, v2Base))).to.equal(1n);

      await tokenV2.connect(owner).setPaused(false);
      await expect(tokenV2.connect(alice).transfer(treasury.address, 1n)).to.not.revert(ethers);
    });

    it("runs initializeV2 once, and only for the default admin", async () => {
      const { ctx, token, owner, alice } = await fixture();
      const tokenV2 = await performUpgrade(
        ctx,
        await token.getAddress(),
        "DohrniiTokenV2Mock",
        owner,
      );

      await expect(
        tokenV2.connect(alice).initializeV2(alice.address),
      ).to.be.revertedWithCustomError(tokenV2, "AccessControlUnauthorizedAccount");

      await tokenV2.connect(owner).initializeV2(owner.address);
      await expect(
        tokenV2.connect(owner).initializeV2(owner.address),
      ).to.be.revertedWithCustomError(tokenV2, "InvalidInitialization");
    });

    it("lands the implementation and its reinitializer call atomically", async () => {
      const { ctx, token, owner, alice } = await fixture();
      const { ethers } = ctx;
      const proxyAddress = await token.getAddress();

      const v2Interface = (await ethers.getContractFactory("DohrniiTokenV2Mock")).interface;
      const data = v2Interface.encodeFunctionData("initializeV2", [alice.address]);
      const tokenV2 = await performUpgrade(ctx, proxyAddress, "DohrniiTokenV2Mock", owner, data);

      // One transaction upgraded the code and granted the new role, so there is no window in
      // which the V2 is live but un-initialised.
      expect(await tokenV2.version()).to.equal("2.0.0-mock");
      expect(await tokenV2.hasRole(await tokenV2.PAUSER_ROLE(), alice.address)).to.equal(true);
    });
  });

  describe("scheduling", () => {
    it("matches the timing constants the tests and docs assume", async () => {
      const { token } = await fixture();
      // Guard against the contract and the fixtures drifting apart: every window assertion below
      // is written in terms of these, and a silent change here would weaken them all.
      expect(await token.UPGRADE_DELAY()).to.equal(UPGRADE_DELAY);
      expect(await token.UPGRADE_WINDOW()).to.equal(UPGRADE_WINDOW);
    });

    it("reports nothing pending on a fresh deployment", async () => {
      const { ctx, token } = await fixture();
      const [implementation, callDataHash, executableAt, expiresAt] = await token.pendingUpgrade();

      expect(implementation).to.equal(ctx.ethers.ZeroAddress);
      expect(callDataHash).to.equal(ctx.ethers.ZeroHash);
      expect(executableAt).to.equal(0n);
      expect(expiresAt).to.equal(0n);
    });

    it("records the commitment and announces its window", async () => {
      const { ctx, token, owner } = await fixture();
      const proxyAddress = await token.getAddress();
      const implementation = await deployImplementationFor(
        ctx,
        proxyAddress,
        "DohrniiTokenV2Mock",
        owner,
      );

      // Pin the block this lands in, so the expected window is exact by construction rather
      // than inferred from a timestamp read back afterwards.
      const scheduledAt = BigInt(await ctx.networkHelpers.time.latest()) + 60n;
      await ctx.networkHelpers.time.setNextBlockTimestamp(scheduledAt);

      const tx = await token.connect(owner).scheduleUpgrade(implementation, "0x");
      const executableAt = scheduledAt + UPGRADE_DELAY;

      await expect(tx)
        .to.emit(token, "UpgradeScheduled")
        .withArgs(implementation, ctx.ethers.keccak256("0x"), executableAt, executableAt + UPGRADE_WINDOW);

      const pending = await token.pendingUpgrade();
      expect(pending[0]).to.equal(implementation);
      expect(pending[1]).to.equal(ctx.ethers.keccak256("0x"));
      expect(pending[2]).to.equal(executableAt);
      expect(pending[3]).to.equal(executableAt + UPGRADE_WINDOW);
    });

    it("is restricted to UPGRADER_ROLE", async () => {
      const { ctx, token, owner, alice } = await fixture();
      const implementation = await deployImplementationFor(
        ctx,
        await token.getAddress(),
        "DohrniiTokenV2Mock",
        owner,
      );

      await expect(token.connect(alice).scheduleUpgrade(implementation, "0x"))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, await token.UPGRADER_ROLE());
    });

    it("rejects the zero implementation", async () => {
      const { ctx, token, owner } = await fixture();
      await expect(
        token.connect(owner).scheduleUpgrade(ctx.ethers.ZeroAddress, "0x"),
      ).to.be.revertedWithCustomError(token, "DohrniiZeroAddress");
    });

    it("replaces an earlier commitment", async () => {
      const { ctx, token, owner } = await fixture();
      const proxyAddress = await token.getAddress();
      const first = await deployImplementationFor(ctx, proxyAddress, "DohrniiTokenV2Mock", owner);
      const second = await deployImplementationFor(ctx, proxyAddress, "DohrniiToken", owner);

      await token.connect(owner).scheduleUpgrade(first, "0x");
      await token.connect(owner).scheduleUpgrade(second, "0x");
      expect((await token.pendingUpgrade())[0]).to.equal(second);

      // The replaced implementation can no longer be executed, even once the delay has passed.
      await ctx.networkHelpers.time.increase(UPGRADE_DELAY);
      await expect(token.connect(owner).upgradeToAndCall(first, "0x")).to.be.revertedWithCustomError(
        token,
        "DohrniiUpgradeNotScheduled",
      );
    });
  });

  describe("execution", () => {
    it("rejects an upgrade with nothing scheduled", async () => {
      const { ctx, token, owner } = await fixture();
      const implementation = await deployImplementationFor(
        ctx,
        await token.getAddress(),
        "DohrniiTokenV2Mock",
        owner,
      );

      await expect(
        token.connect(owner).upgradeToAndCall(implementation, "0x"),
      ).to.be.revertedWithCustomError(token, "DohrniiNoScheduledUpgrade");
    });

    it("rejects an implementation other than the one committed to", async () => {
      const { ctx, token, owner } = await fixture();
      const { proxy, executableAt } = await schedule(ctx, token, owner);
      const other = await deployImplementationFor(
        ctx,
        await token.getAddress(),
        "DohrniiToken",
        owner,
      );

      await ctx.networkHelpers.time.increaseTo(executableAt);
      await expect(proxy.connect(owner).upgradeToAndCall(other, "0x"))
        .to.be.revertedWithCustomError(token, "DohrniiUpgradeNotScheduled")
        .withArgs(other, ctx.ethers.keccak256("0x"));
    });

    it("rejects call data other than the data committed to", async () => {
      const { ctx, token, owner, alice } = await fixture();
      const { proxy, implementation, executableAt } = await schedule(ctx, token, owner);

      const v2Interface = (await ctx.ethers.getContractFactory("DohrniiTokenV2Mock")).interface;
      const swapped = v2Interface.encodeFunctionData("initializeV2", [alice.address]);

      await ctx.networkHelpers.time.increaseTo(executableAt);
      await expect(proxy.connect(owner).upgradeToAndCall(implementation, swapped))
        .to.be.revertedWithCustomError(token, "DohrniiUpgradeNotScheduled")
        .withArgs(implementation, ctx.ethers.keccak256(swapped));
    });

    it("rejects execution one second before the delay has elapsed", async () => {
      const { ctx, token, owner } = await fixture();
      const { proxy, implementation, executableAt } = await schedule(ctx, token, owner);

      // setNextBlockTimestamp pins the block this transaction lands in, so the boundary is exact.
      await ctx.networkHelpers.time.setNextBlockTimestamp(executableAt - 1n);
      await expect(proxy.connect(owner).upgradeToAndCall(implementation, "0x"))
        .to.be.revertedWithCustomError(token, "DohrniiUpgradeNotReady")
        .withArgs(executableAt);
    });

    it("executes at exactly the first permitted second", async () => {
      const { ctx, token, owner } = await fixture();
      const { proxy, implementation, executableAt } = await schedule(ctx, token, owner);

      await ctx.networkHelpers.time.setNextBlockTimestamp(executableAt);
      await expect(proxy.connect(owner).upgradeToAndCall(implementation, "0x"))
        .to.emit(token, "Upgraded")
        .withArgs(implementation);
    });

    it("executes at exactly the last permitted second", async () => {
      const { ctx, token, owner } = await fixture();
      const { proxy, implementation, expiresAt } = await schedule(ctx, token, owner);

      await ctx.networkHelpers.time.setNextBlockTimestamp(expiresAt);
      await expect(proxy.connect(owner).upgradeToAndCall(implementation, "0x")).to.emit(
        token,
        "Upgraded",
      );
    });

    it("rejects execution one second after the window closes", async () => {
      const { ctx, token, owner } = await fixture();
      const { proxy, implementation, expiresAt } = await schedule(ctx, token, owner);

      await ctx.networkHelpers.time.setNextBlockTimestamp(expiresAt + 1n);
      await expect(proxy.connect(owner).upgradeToAndCall(implementation, "0x"))
        .to.be.revertedWithCustomError(token, "DohrniiUpgradeExpired")
        .withArgs(expiresAt);
    });

    it("consumes the commitment, so the same upgrade cannot be replayed", async () => {
      const { ctx, token, owner } = await fixture();
      const proxyAddress = await token.getAddress();
      const tokenV2 = await performUpgrade(ctx, proxyAddress, "DohrniiTokenV2Mock", owner);

      const [implementation, , executableAt] = await tokenV2.pendingUpgrade();
      expect(implementation).to.equal(ctx.ethers.ZeroAddress);
      expect(executableAt).to.equal(0n);

      const current = await ctx.upgrades.erc1967.getImplementationAddress(proxyAddress);
      await expect(
        tokenV2.connect(owner).upgradeToAndCall(current, "0x"),
      ).to.be.revertedWithCustomError(tokenV2, "DohrniiNoScheduledUpgrade");
    });

    it("rejects an upgrade from an account without UPGRADER_ROLE, scheduled or not", async () => {
      const { ctx, token, owner, alice } = await fixture();
      const { proxy, implementation, executableAt } = await schedule(ctx, token, owner);

      await ctx.networkHelpers.time.increaseTo(executableAt);
      await expect(proxy.connect(alice).upgradeToAndCall(implementation, "0x"))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, await token.UPGRADER_ROLE());
    });

    it("lets the owner delegate upgrade rights and take them back", async () => {
      const { ctx, token, owner, alice } = await fixture();
      const proxyAddress = await token.getAddress();
      const upgraderRole = await token.UPGRADER_ROLE();

      await token.connect(owner).grantRole(upgraderRole, alice.address);
      const tokenV2 = await performUpgrade(ctx, proxyAddress, "DohrniiTokenV2Mock", alice);
      expect(await tokenV2.version()).to.equal("2.0.0-mock");

      await token.connect(owner).revokeRole(upgraderRole, alice.address);
      const live = await ctx.upgrades.erc1967.getImplementationAddress(proxyAddress);
      await expect(
        token.connect(alice).scheduleUpgrade(live, "0x"),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("cancellation", () => {
    it("lets UPGRADER_ROLE cancel its own commitment", async () => {
      const { ctx, token, owner } = await fixture();
      const { proxy, implementation, executableAt } = await schedule(ctx, token, owner);

      await expect(proxy.connect(owner).cancelScheduledUpgrade())
        .to.emit(token, "UpgradeCancelled")
        .withArgs(implementation);
      expect((await token.pendingUpgrade())[0]).to.equal(ctx.ethers.ZeroAddress);

      await ctx.networkHelpers.time.increaseTo(executableAt);
      await expect(
        proxy.connect(owner).upgradeToAndCall(implementation, "0x"),
      ).to.be.revertedWithCustomError(token, "DohrniiNoScheduledUpgrade");
    });

    it("lets the default admin veto an upgrade scheduled by a delegated upgrader", async () => {
      const { ctx, token, owner, alice } = await fixture();
      const proxyAddress = await token.getAddress();
      await token.connect(owner).grantRole(await token.UPGRADER_ROLE(), alice.address);

      const implementation = await deployImplementationFor(
        ctx,
        proxyAddress,
        "DohrniiTokenV2Mock",
        alice,
      );
      await token.connect(alice).scheduleUpgrade(implementation, "0x");

      // The point of the delay: ownership can stop the upgrade before it takes effect.
      await expect(token.connect(owner).cancelScheduledUpgrade()).to.emit(token, "UpgradeCancelled");
      expect(await token.version()).to.equal("1.0.0");
    });

    it("rejects a cancellation from an account with neither role", async () => {
      const { ctx, token, owner, alice } = await fixture();
      await schedule(ctx, token, owner);

      await expect(token.connect(alice).cancelScheduledUpgrade())
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, await token.UPGRADER_ROLE());
    });

    it("rejects a cancellation when nothing is scheduled", async () => {
      const { token, owner } = await fixture();
      await expect(
        token.connect(owner).cancelScheduledUpgrade(),
      ).to.be.revertedWithCustomError(token, "DohrniiNoScheduledUpgrade");
    });
  });

  describe("proxy guards", () => {
    it("refuses upgradeToAndCall executed directly on the implementation", async () => {
      const { ctx, token, owner } = await fixture();
      const { ethers, upgrades } = ctx;
      const implAddress = await upgrades.erc1967.getImplementationAddress(await token.getAddress());
      const impl = await contractAt(ctx, "DohrniiToken", implAddress);

      // onlyProxy fires before any state is read, so the implementation cannot be walked into a
      // state where it looks like an initialised token.
      await expect(
        impl.connect(owner).upgradeToAndCall(implAddress, "0x"),
      ).to.be.revertedWithCustomError(impl, "UUPSUnauthorizedCallContext");
    });

    it("exposes proxiableUUID on the implementation and refuses it through the proxy", async () => {
      const { ctx, token } = await fixture();
      const { ethers, upgrades } = ctx;
      const proxyAddress = await token.getAddress();
      const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      const impl = await contractAt(ctx, "DohrniiToken", implAddress);

      // ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
      expect(await impl.proxiableUUID()).to.equal(
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      );

      // notDelegated: reading it through the proxy would let a proxy be mistaken for an
      // implementation and be upgraded into.
      await expect(token.proxiableUUID()).to.be.revertedWithCustomError(
        token,
        "UUPSUnauthorizedCallContext",
      );
    });
  });
});

/** ERC-7201 slot for a namespace id. */
function namespaceSlot(ethers: { keccak256: (v: Uint8Array | string) => string; toUtf8Bytes: (v: string) => Uint8Array; AbiCoder: { defaultAbiCoder: () => { encode: (t: string[], v: unknown[]) => string } } }, namespace: string): bigint {
  const inner = BigInt(ethers.keccak256(ethers.toUtf8Bytes(namespace))) - 1n;
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [inner]);
  return BigInt(ethers.keccak256(encoded)) & ~0xffn;
}
