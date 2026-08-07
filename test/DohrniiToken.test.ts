import { expect } from "chai";
import { connect, TOTAL_SUPPLY, ADMIN_DELAY } from "./helpers.js";

describe("DohrniiToken", () => {
  async function deployFixture() {
    const { ethers, upgrades } = await connect();
    const [deployer, owner, treasury, alice, bob, carol] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("DohrniiToken");
    const token = await upgrades.deployProxy(
      Factory,
      [owner.address, treasury.address, ADMIN_DELAY],
      { kind: "uups" },
    );
    await token.waitForDeployment();

    // Give Alice a working balance for transfer tests.
    await token.connect(treasury).transfer(alice.address, ethers.parseEther("1000"));

    return { ethers, upgrades, token, deployer, owner, treasury, alice, bob, carol };
  }

  async function fixture() {
    const { networkHelpers } = await connect();
    return networkHelpers.loadFixture(deployFixture);
  }

  describe("initialisation", () => {
    it("has the specified token basics", async () => {
      const { token } = await fixture();
      expect(await token.name()).to.equal("Dohrnii");
      expect(await token.symbol()).to.equal("DHN");
      expect(await token.decimals()).to.equal(18n);
      expect(await token.version()).to.equal("1.0.0");
    });

    it("mints the full fixed supply to the nominated recipient", async () => {
      const { token, treasury, ethers } = await fixture();
      expect(await token.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      expect(await token.balanceOf(treasury.address)).to.equal(
        TOTAL_SUPPLY - ethers.parseEther("1000"),
      );
    });

    it("exposes no mint, burn or pause entry point", async () => {
      const { token } = await fixture();
      const names: string[] = [];
      token.interface.forEachFunction((fn) => names.push(fn.name));
      for (const forbidden of ["mint", "burn", "burnFrom", "pause", "unpause"]) {
        expect(names).to.not.include(forbidden);
      }
    });

    it("hands the owner wallet the default admin plus every operational role", async () => {
      const { token, owner, deployer } = await fixture();
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.defaultAdmin()).to.equal(owner.address);
      expect(await token.defaultAdminDelay()).to.equal(ADMIN_DELAY);

      const roles = [
        await token.DEFAULT_ADMIN_ROLE(),
        await token.BLACKLIST_MANAGER_ROLE(),
        await token.FEATURE_MANAGER_ROLE(),
        await token.UPGRADER_ROLE(),
      ];
      for (const role of roles) {
        expect(await token.hasRole(role, owner.address)).to.equal(true);
        expect(await token.hasRole(role, deployer.address)).to.equal(false);
      }
    });

    it("enforces the blacklist from the start", async () => {
      const { token } = await fixture();
      expect(await token.blacklistEnabled()).to.equal(true);
    });

    it("cannot be initialised twice", async () => {
      const { token, owner, treasury } = await fixture();
      await expect(
        token.initialize(owner.address, treasury.address, ADMIN_DELAY),
      ).to.be.revertedWithCustomError(token, "InvalidInitialization");
    });

    it("rejects a zero owner or zero supply recipient", async () => {
      const { ethers, upgrades } = await connect();
      const [, owner] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("DohrniiToken");

      await expect(
        upgrades.deployProxy(Factory, [ethers.ZeroAddress, owner.address, ADMIN_DELAY], {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(Factory, "DohrniiZeroAddress");

      await expect(
        upgrades.deployProxy(Factory, [owner.address, ethers.ZeroAddress, ADMIN_DELAY], {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(Factory, "DohrniiZeroAddress");
    });

    it("leaves the implementation contract uninitialisable", async () => {
      const { ethers, upgrades, token, owner, treasury } = await fixture();
      const implAddress = await upgrades.erc1967.getImplementationAddress(await token.getAddress());
      const impl = await ethers.getContractAt("DohrniiToken", implAddress);
      await expect(
        impl.initialize(owner.address, treasury.address, ADMIN_DELAY),
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  describe("initial admin delay bounds", () => {
    const CAP = 7n * 24n * 60n * 60n; // MAX_ADMIN_DELAY

    /** Deploys a fresh proxy with an arbitrary initial admin delay. */
    async function deployWithDelay(delay: bigint) {
      const { ethers, upgrades } = await connect();
      const [, owner, treasury] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("DohrniiToken");
      const deploy = () =>
        upgrades.deployProxy(Factory, [owner.address, treasury.address, delay], { kind: "uups" });
      return { ethers, Factory, owner, deploy };
    }

    it("caps the initial delay at one week", async () => {
      const { token } = await fixture();
      expect(await token.MAX_ADMIN_DELAY()).to.equal(CAP);
    });

    it("accepts a delay exactly at the cap", async () => {
      const { deploy } = await deployWithDelay(CAP);
      const token = await deploy();
      expect(await token.defaultAdminDelay()).to.equal(CAP);
    });

    it("rejects a delay one second above the cap", async () => {
      const { Factory, deploy } = await deployWithDelay(CAP + 1n);
      await expect(deploy())
        .to.be.revertedWithCustomError(Factory, "DohrniiAdminDelayTooLong")
        .withArgs(CAP + 1n, CAP);
    });

    it("rejects type(uint48).max, which would overflow the transfer schedule", async () => {
      const maxUint48 = 2n ** 48n - 1n;
      const { Factory, deploy } = await deployWithDelay(maxUint48);
      await expect(deploy())
        .to.be.revertedWithCustomError(Factory, "DohrniiAdminDelayTooLong")
        .withArgs(maxUint48, CAP);
    });

    it("rejects milliseconds passed where seconds were meant", async () => {
      // 3 days in milliseconds. Unbounded, this would freeze ownership rotation for ~8 years.
      const msTypo = 259_200_000n;
      const { Factory, deploy } = await deployWithDelay(msTypo);
      await expect(deploy())
        .to.be.revertedWithCustomError(Factory, "DohrniiAdminDelayTooLong")
        .withArgs(msTypo, CAP);
    });

    it("still accepts zero, which removes the cancellation window entirely", async () => {
      const { ethers, owner, deploy } = await deployWithDelay(0n);
      const { networkHelpers } = await connect();
      const [, , , alice] = await ethers.getSigners();
      const token = await deploy();
      expect(await token.defaultAdminDelay()).to.equal(0n);

      // Documented consequence: the nominee can take ownership in the very next block.
      await token.connect(owner).beginDefaultAdminTransfer(alice.address);
      await networkHelpers.time.increase(1);
      await token.connect(alice).acceptDefaultAdminTransfer();
      expect(await token.owner()).to.equal(alice.address);
    });
  });

  describe("ERC-20 behaviour", () => {
    it("transfers between holders", async () => {
      const { ethers, token, alice, bob } = await fixture();
      const amount = ethers.parseEther("100");
      await expect(token.connect(alice).transfer(bob.address, amount))
        .to.emit(token, "Transfer")
        .withArgs(alice.address, bob.address, amount);
      expect(await token.balanceOf(bob.address)).to.equal(amount);
    });

    it("supports approve / transferFrom", async () => {
      const { ethers, token, alice, bob, carol } = await fixture();
      const amount = ethers.parseEther("50");
      await token.connect(alice).approve(bob.address, amount);
      await token.connect(bob).transferFrom(alice.address, carol.address, amount);
      expect(await token.balanceOf(carol.address)).to.equal(amount);
      expect(await token.allowance(alice.address, bob.address)).to.equal(0n);
    });
  });

  describe("blacklist", () => {
    it("blocks a blacklisted sender", async () => {
      const { ethers, token, owner, alice, bob } = await fixture();
      await token.connect(owner).setBlacklisted(alice.address, true);
      expect(await token.isBlacklisted(alice.address)).to.equal(true);

      await expect(token.connect(alice).transfer(bob.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(token, "DohrniiBlacklistedAddress")
        .withArgs(alice.address);
    });

    it("blocks a blacklisted recipient", async () => {
      const { ethers, token, owner, alice, bob } = await fixture();
      await token.connect(owner).setBlacklisted(bob.address, true);

      await expect(token.connect(alice).transfer(bob.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(token, "DohrniiBlacklistedAddress")
        .withArgs(bob.address);
    });

    it("blocks a blacklisted holder pulled through transferFrom", async () => {
      const { ethers, token, owner, alice, bob, carol } = await fixture();
      const amount = ethers.parseEther("10");
      await token.connect(alice).approve(bob.address, amount);
      await token.connect(owner).setBlacklisted(alice.address, true);

      await expect(token.connect(bob).transferFrom(alice.address, carol.address, amount))
        .to.be.revertedWithCustomError(token, "DohrniiBlacklistedAddress")
        .withArgs(alice.address);
    });

    it("still allows approvals by a blacklisted holder (no balance moves)", async () => {
      const { ethers, token, owner, alice, bob } = await fixture();
      await token.connect(owner).setBlacklisted(alice.address, true);
      await expect(token.connect(alice).approve(bob.address, ethers.parseEther("1"))).to.not.revert(ethers);
    });

    it("un-blacklisting restores transfers", async () => {
      const { ethers, token, owner, alice, bob } = await fixture();
      await token.connect(owner).setBlacklisted(alice.address, true);
      await token.connect(owner).setBlacklisted(alice.address, false);
      await expect(token.connect(alice).transfer(bob.address, ethers.parseEther("1"))).to.not.revert(ethers);
    });

    it("emits BlacklistUpdated only on an actual change", async () => {
      const { token, owner, alice } = await fixture();
      await expect(token.connect(owner).setBlacklisted(alice.address, true))
        .to.emit(token, "BlacklistUpdated")
        .withArgs(alice.address, true);
      await expect(token.connect(owner).setBlacklisted(alice.address, true)).to.not.emit(
        token,
        "BlacklistUpdated",
      );
    });

    it("applies a batch update", async () => {
      const { token, owner, alice, bob, carol } = await fixture();
      await token.connect(owner).setBlacklistedBatch([alice.address, bob.address], true);
      expect(await token.isBlacklisted(alice.address)).to.equal(true);
      expect(await token.isBlacklisted(bob.address)).to.equal(true);
      expect(await token.isBlacklisted(carol.address)).to.equal(false);

      await token.connect(owner).setBlacklistedBatch([alice.address, bob.address], false);
      expect(await token.isBlacklisted(alice.address)).to.equal(false);
      expect(await token.isBlacklisted(bob.address)).to.equal(false);
    });

    it("rejects the zero address", async () => {
      const { ethers, token, owner } = await fixture();
      await expect(
        token.connect(owner).setBlacklisted(ethers.ZeroAddress, true),
      ).to.be.revertedWithCustomError(token, "DohrniiZeroAddress");
      await expect(
        token.connect(owner).setBlacklistedBatch([ethers.ZeroAddress], true),
      ).to.be.revertedWithCustomError(token, "DohrniiZeroAddress");
    });

    it("is restricted to BLACKLIST_MANAGER_ROLE", async () => {
      const { token, alice, bob } = await fixture();
      const role = await token.BLACKLIST_MANAGER_ROLE();
      await expect(token.connect(alice).setBlacklisted(bob.address, true))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, role);
      await expect(token.connect(alice).setBlacklistedBatch([bob.address], true))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, role);
    });

    it("works after the role is delegated to an operator", async () => {
      const { token, owner, alice, bob } = await fixture();
      const role = await token.BLACKLIST_MANAGER_ROLE();
      await token.connect(owner).grantRole(role, alice.address);
      await expect(token.connect(alice).setBlacklisted(bob.address, true)).to.emit(
        token,
        "BlacklistUpdated",
      );
      await token.connect(owner).revokeRole(role, alice.address);
      await expect(token.connect(alice).setBlacklisted(bob.address, false)).to.be
        .revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("blacklist switch", () => {
    it("disabling enforcement keeps the list but lets transfers through", async () => {
      const { ethers, token, owner, alice, bob } = await fixture();
      await token.connect(owner).setBlacklisted(alice.address, true);

      await expect(token.connect(owner).setBlacklistEnabled(false))
        .to.emit(token, "BlacklistEnabledUpdated")
        .withArgs(false);

      expect(await token.blacklistEnabled()).to.equal(false);
      expect(await token.isBlacklisted(alice.address)).to.equal(true);
      await expect(token.connect(alice).transfer(bob.address, ethers.parseEther("1"))).to.not.revert(ethers);

      await token.connect(owner).setBlacklistEnabled(true);
      await expect(
        token.connect(alice).transfer(bob.address, ethers.parseEther("1")),
      ).to.be.revertedWithCustomError(token, "DohrniiBlacklistedAddress");
    });

    it("does not emit when already in the requested state", async () => {
      const { token, owner } = await fixture();
      await expect(token.connect(owner).setBlacklistEnabled(true)).to.not.emit(
        token,
        "BlacklistEnabledUpdated",
      );
    });

    it("is restricted to FEATURE_MANAGER_ROLE", async () => {
      const { token, alice } = await fixture();
      await expect(token.connect(alice).setBlacklistEnabled(false))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, await token.FEATURE_MANAGER_ROLE());
    });
  });

  describe("ownership and roles", () => {
    it("only the default admin can grant or revoke roles", async () => {
      const { token, alice, bob } = await fixture();
      const role = await token.FEATURE_MANAGER_ROLE();
      await expect(token.connect(alice).grantRole(role, bob.address))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, await token.DEFAULT_ADMIN_ROLE());
    });

    it("refuses to grant the default admin role directly", async () => {
      const { token, owner, alice } = await fixture();
      await expect(
        token.connect(owner).grantRole(await token.DEFAULT_ADMIN_ROLE(), alice.address),
      ).to.be.revertedWithCustomError(token, "AccessControlEnforcedDefaultAdminRules");
    });

    it("transfers ownership in two steps, after the delay", async () => {
      const { ethers, token, owner, alice } = await fixture();
      const { networkHelpers } = await connect();

      await token.connect(owner).beginDefaultAdminTransfer(alice.address);
      const [pendingAdmin] = await token.pendingDefaultAdmin();
      expect(pendingAdmin).to.equal(alice.address);

      await expect(
        token.connect(alice).acceptDefaultAdminTransfer(),
      ).to.be.revertedWithCustomError(token, "AccessControlEnforcedDefaultAdminDelay");

      await networkHelpers.time.increase(ADMIN_DELAY);
      await token.connect(alice).acceptDefaultAdminTransfer();

      expect(await token.owner()).to.equal(alice.address);
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(false);

      // The old owner keeps only what was granted separately, and can be stripped by the new admin.
      const blacklistRole = await token.BLACKLIST_MANAGER_ROLE();
      expect(await token.hasRole(blacklistRole, owner.address)).to.equal(true);
      await token.connect(alice).revokeRole(blacklistRole, owner.address);
      expect(await token.hasRole(blacklistRole, owner.address)).to.equal(false);
      expect(ethers.isAddress(alice.address)).to.equal(true);
    });

    it("lets the pending transfer be cancelled", async () => {
      const { ethers, token, owner, alice } = await fixture();
      await token.connect(owner).beginDefaultAdminTransfer(alice.address);
      await token.connect(owner).cancelDefaultAdminTransfer();
      const [pendingAdmin] = await token.pendingDefaultAdmin();
      expect(pendingAdmin).to.equal(ethers.ZeroAddress);
    });

    it("gives the owner a unilateral veto for the whole window", async () => {
      const { token, owner, alice, bob } = await fixture();
      await token.connect(owner).beginDefaultAdminTransfer(alice.address);

      // Inside the window the nominee cannot outrun a cancellation...
      await expect(
        token.connect(alice).acceptDefaultAdminTransfer(),
      ).to.be.revertedWithCustomError(token, "AccessControlEnforcedDefaultAdminDelay");
      // ...and nobody else can accept on its behalf.
      await expect(token.connect(bob).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(token, "AccessControlInvalidDefaultAdmin")
        .withArgs(bob.address);

      expect(await token.owner()).to.equal(owner.address);
    });

    it("lets the owner cancel even after the window has elapsed", async () => {
      const { ethers, token, owner, alice } = await fixture();
      const { networkHelpers } = await connect();

      await token.connect(owner).beginDefaultAdminTransfer(alice.address);
      await networkHelpers.time.increase(ADMIN_DELAY + 1n);

      // cancelDefaultAdminTransfer carries no deadline: past the window it is a race, not a right.
      await token.connect(owner).cancelDefaultAdminTransfer();
      await expect(token.connect(alice).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(token, "AccessControlInvalidDefaultAdmin")
        .withArgs(alice.address);
      expect(await token.owner()).to.equal(owner.address);
      const [pendingAdmin] = await token.pendingDefaultAdmin();
      expect(pendingAdmin).to.equal(ethers.ZeroAddress);
    });

    it("never moves ownership on its own once the window expires", async () => {
      const { token, owner, alice } = await fixture();
      const { networkHelpers } = await connect();

      await token.connect(owner).beginDefaultAdminTransfer(alice.address);
      await networkHelpers.time.increase(ADMIN_DELAY * 100n);

      // Expiry only lifts the ban on accepting; the nominee must still send the transaction.
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(true);
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), alice.address)).to.equal(false);
      const [pendingAdmin] = await token.pendingDefaultAdmin();
      expect(pendingAdmin).to.equal(alice.address);
    });

    it("re-nominating replaces the candidate and restarts the window", async () => {
      const { token, owner, alice, bob } = await fixture();
      await token.connect(owner).beginDefaultAdminTransfer(alice.address);
      await token.connect(owner).beginDefaultAdminTransfer(bob.address);

      const [pendingAdmin] = await token.pendingDefaultAdmin();
      expect(pendingAdmin).to.equal(bob.address);
      await expect(token.connect(alice).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(token, "AccessControlInvalidDefaultAdmin")
        .withArgs(alice.address);
    });

    it("caps post-deployment delay changes at MAX_ADMIN_DELAY", async () => {
      const { token, owner } = await fixture();
      const cap = await token.MAX_ADMIN_DELAY();

      // An uncapped increase becomes effective after defaultAdminDelayIncreaseWait() and then
      // takes about its own length to unwind, locking admin rotation for years.
      const overLong = 10n ** 12n;
      await expect(token.connect(owner).changeDefaultAdminDelay(overLong))
        .to.be.revertedWithCustomError(token, "DohrniiAdminDelayTooLong")
        .withArgs(overLong, cap);

      await expect(token.connect(owner).changeDefaultAdminDelay(cap + 1n))
        .to.be.revertedWithCustomError(token, "DohrniiAdminDelayTooLong")
        .withArgs(cap + 1n, cap);

      const [untouched] = await token.pendingDefaultAdminDelay();
      expect(untouched).to.equal(0n);
      expect(await token.defaultAdminDelay()).to.equal(ADMIN_DELAY);
    });

    it("schedules a change at the cap and still allows rolling it back", async () => {
      const { token, owner } = await fixture();
      const cap = await token.MAX_ADMIN_DELAY();

      await token.connect(owner).changeDefaultAdminDelay(cap);
      expect(await token.defaultAdminDelay()).to.equal(ADMIN_DELAY);
      const [pendingDelay] = await token.pendingDefaultAdminDelay();
      expect(pendingDelay).to.equal(cap);

      await token.connect(owner).rollbackDefaultAdminDelay();
      const [afterRollback] = await token.pendingDefaultAdminDelay();
      expect(afterRollback).to.equal(0n);
      expect(await token.defaultAdminDelay()).to.equal(ADMIN_DELAY);
    });

    it("keeps the cap enforced through the proxy after the delay actually takes effect", async () => {
      const { token, owner } = await fixture();
      const { networkHelpers } = await connect();
      const cap = await token.MAX_ADMIN_DELAY();

      await token.connect(owner).changeDefaultAdminDelay(cap);
      const [, effectSchedule] = await token.pendingDefaultAdminDelay();
      await networkHelpers.time.increaseTo(effectSchedule + 1n);
      expect(await token.defaultAdminDelay()).to.equal(cap);

      // Still bounded once the larger value is live; lowering it back remains permitted.
      await expect(token.connect(owner).changeDefaultAdminDelay(cap + 1n)).to.be.revertedWithCustomError(
        token,
        "DohrniiAdminDelayTooLong",
      );
      await token.connect(owner).changeDefaultAdminDelay(ADMIN_DELAY);
      const [lowered] = await token.pendingDefaultAdminDelay();
      expect(lowered).to.equal(ADMIN_DELAY);
    });

    it("still restricts delay changes to the default admin", async () => {
      const { token, alice } = await fixture();
      await expect(token.connect(alice).changeDefaultAdminDelay(1n)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("ERC-7201 namespaced storage", () => {
    it("keeps all token state inside the dohrnii.storage.DohrniiToken namespace", async () => {
      const { ethers, token, owner, alice } = await fixture();
      const proxy = await token.getAddress();

      // keccak256(abi.encode(uint256(keccak256(NAMESPACE)) - 1)) & ~0xff
      const namespace = "dohrnii.storage.DohrniiToken";
      const base =
        BigInt(
          ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["uint256"],
              [BigInt(ethers.keccak256(ethers.toUtf8Bytes(namespace))) - 1n],
            ),
          ),
        ) & ~0xffn;

      const slotValue = async (slot: bigint) =>
        BigInt(await ethers.provider.getStorage(proxy, slot));

      // Slot 0 of the struct: blacklistEnabled. Slot 1: blacklist mapping.
      expect(await slotValue(base)).to.equal(1n);

      await token.connect(owner).setBlacklisted(alice.address, true);
      const entrySlot = BigInt(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "uint256"],
            [alice.address, base + 1n],
          ),
        ),
      );
      expect(await slotValue(entrySlot)).to.equal(1n);

      // Nothing landed in the legacy sequential slots 0..2 of the proxy.
      for (const slot of [0n, 1n, 2n] as const) {
        expect(await slotValue(slot)).to.equal(0n);
      }
    });
  });
});
