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
