import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  );

  return { pool, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Security Tests — Pausable + Ownable
// ---------------------------------------------------------------------------

describe("ConfidentialPool — Security", function () {
  // -------------------------------------------------------------------------
  // Ownable
  // -------------------------------------------------------------------------

  describe("Ownable", function () {
    it("sets the deployer as owner", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      expect(await pool.owner()).to.equal(owner.address);
    });

    it("non-owner cannot pause", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(alice).pause()).to.be.revertedWithCustomError(
        pool,
        "OwnableUnauthorizedAccount"
      );
    });

    it("non-owner cannot unpause", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();
      await expect(pool.connect(alice).unpause()).to.be.revertedWithCustomError(
        pool,
        "OwnableUnauthorizedAccount"
      );
    });

    it("owner can pause and unpause", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();
      expect(await pool.paused()).to.be.true;
      await pool.connect(owner).unpause();
      expect(await pool.paused()).to.be.false;
    });
  });

  // -------------------------------------------------------------------------
  // Pausable — deposit
  // -------------------------------------------------------------------------

  describe("Pausable — deposit", function () {
    it("reverts deposit when paused", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();

      await expect(
        pool
          .connect(alice)
          .deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("allows deposit after unpause", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();
      await pool.connect(owner).unpause();

      await expect(
        pool
          .connect(alice)
          .deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Pausable — transfer
  // -------------------------------------------------------------------------

  describe("Pausable — transfer", function () {
    it("reverts transfer when paused", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      // deposit first to get a valid root
      const commitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();

      await pool.connect(owner).pause();

      await expect(
        pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          randomCommitment(),
          randomCommitment()
        )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("allows transfer after unpause", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const commitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();

      await pool.connect(owner).pause();
      await pool.connect(owner).unpause();

      await expect(
        pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          randomCommitment(),
          randomCommitment()
        )
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Max withdrawal amount
  // -------------------------------------------------------------------------

  describe("Max withdrawal amount", function () {
    it("owner can set maxWithdrawAmount", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const cap = ethers.parseEther("2");
      await expect(pool.connect(owner).setMaxWithdrawAmount(cap))
        .to.emit(pool, "MaxWithdrawAmountUpdated")
        .withArgs(cap);
      expect(await pool.maxWithdrawAmount()).to.equal(cap);
    });

    it("non-owner cannot set maxWithdrawAmount", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setMaxWithdrawAmount(ethers.parseEther("2"))
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("withdraw reverts when amount exceeds max", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const cap = ethers.parseEther("0.5");
      await pool.connect(owner).setMaxWithdrawAmount(cap);

      const commitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: amount exceeds withdrawal limit");
    });

    it("withdraw succeeds at exactly max", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const cap = ethers.parseEther("1");
      await pool.connect(owner).setMaxWithdrawAmount(cap);

      const commitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(commitment, { value: cap });
      const root = await pool.getLastRoot();

      // Amount equals the cap exactly — the limit check must not revert.
      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          cap,
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Emergency drain
  // -------------------------------------------------------------------------

  describe("Emergency drain", function () {
    it("owner can drain when paused", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const depositAmount = ethers.parseEther("3");
      await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
      await pool.connect(owner).pause();

      await expect(pool.connect(owner).emergencyDrain(owner.address))
        .to.emit(pool, "EmergencyDrain")
        .withArgs(owner.address, depositAmount);
    });

    it("emergency drain reverts when not paused", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });

      await expect(
        pool.connect(owner).emergencyDrain(owner.address)
      ).to.be.revertedWithCustomError(pool, "ExpectedPause");
    });

    it("non-owner cannot emergency drain", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      await pool.connect(owner).pause();

      await expect(
        pool.connect(alice).emergencyDrain(alice.address)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("emergency drain sends full balance to recipient", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

      const depositAmount = ethers.parseEther("5");
      await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
      await pool.connect(owner).pause();

      const bobBefore = await ethers.provider.getBalance(bob.address);
      await pool.connect(owner).emergencyDrain(bob.address);
      const bobAfter = await ethers.provider.getBalance(bob.address);

      expect(bobAfter - bobBefore).to.equal(depositAmount);
      expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Pausable — withdraw
  // -------------------------------------------------------------------------

  describe("Pausable — withdraw", function () {
    it("reverts withdraw when paused", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const commitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();

      await pool.connect(owner).pause();

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("allows withdraw after unpause", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const commitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();

      await pool.connect(owner).pause();
      await pool.connect(owner).unpause();

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist
  // -------------------------------------------------------------------------

  describe("Allowlist", function () {
    it("allowlist is disabled by default", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.allowlistEnabled()).to.be.false;
    });

    it("deposit succeeds for any address when allowlist is disabled", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.not.be.reverted;
    });

    it("deposit reverts for non-allowlisted address when allowlist is enabled", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });

    it("deposit succeeds for allowlisted address when allowlist is enabled", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.not.be.reverted;
    });

    it("batchDeposit reverts for non-allowlisted address when allowlist is enabled", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, {
          value: ethers.parseEther("2"),
        })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });

    it("batchDeposit succeeds for allowlisted address when allowlist is enabled", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, {
          value: ethers.parseEther("2"),
        })
      ).to.not.be.reverted;
    });

    it("batchSetAllowlisted grants access to multiple addresses", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).batchSetAllowlisted([alice.address, bob.address], true);
      expect(await pool.allowlisted(alice.address)).to.be.true;
      expect(await pool.allowlisted(bob.address)).to.be.true;
    });

    it("batchSetAllowlisted revokes access from multiple addresses", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).batchSetAllowlisted([alice.address, bob.address], true);
      await pool.connect(owner).batchSetAllowlisted([alice.address, bob.address], false);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
      await expect(
        pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });

    it("disabling allowlist allows anyone to deposit again", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
      await pool.connect(owner).setAllowlistEnabled(false);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.not.be.reverted;
    });

    it("only owner can enable allowlist", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setAllowlistEnabled(true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("only owner can set individual allowlist entry", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setAllowlisted(bob.address, true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("only owner can batch set allowlist", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).batchSetAllowlisted([bob.address], true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setAllowlistEnabled emits AllowlistToggled event", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setAllowlistEnabled(true))
        .to.emit(pool, "AllowlistToggled")
        .withArgs(true);
      await expect(pool.connect(owner).setAllowlistEnabled(false))
        .to.emit(pool, "AllowlistToggled")
        .withArgs(false);
    });

    it("setAllowlisted emits AllowlistUpdated event", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setAllowlisted(alice.address, true))
        .to.emit(pool, "AllowlistUpdated")
        .withArgs(alice.address, true);
    });

    it("batchSetAllowlisted emits AllowlistUpdated for each account", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      const tx = await pool.connect(owner).batchSetAllowlisted([alice.address, bob.address], true);
      await expect(tx).to.emit(pool, "AllowlistUpdated").withArgs(alice.address, true);
      await expect(tx).to.emit(pool, "AllowlistUpdated").withArgs(bob.address, true);
    });
  });
});
