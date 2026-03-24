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
});
