import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const DEPOSIT_AMOUNT = ethers.parseEther("1");

// Thresholds set at ~2x observed gas to catch major regressions without false
// positives from minor EVM or compiler changes.
// Observed (Hardhat local): deposit ~423k, transfer ~560k, withdraw ~506k (with change) /
//   ~255k (no change) / ~515k (with relayer), batchDeposit(10) ~2.46M, batchDeposit(1) ~426k
const MAX_DEPOSIT_GAS = 850_000n;
const MAX_TRANSFER_GAS = 1_200_000n; // inserts 2 commitments
const MAX_WITHDRAW_GAS = 1_100_000n; // covers change + no-change + relayer variants
const MAX_BATCH_DEPOSIT_GAS = 5_000_000n; // 10 items

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob, relayer };
}

// ---------------------------------------------------------------------------
// Gas Snapshots
// ---------------------------------------------------------------------------

describe("Gas Snapshots", function () {
  // -------------------------------------------------------------------------
  // Deposit
  // -------------------------------------------------------------------------

  describe("deposit", function () {
    it("deposit gas is below threshold", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      const c = randomCommitment();
      const tx = await pool.connect(alice).deposit(c, { value: DEPOSIT_AMOUNT });
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Deposit gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_DEPOSIT_GAS,
        `deposit used ${gas} gas, threshold is ${MAX_DEPOSIT_GAS}`
      );
    });

    it("deposit gas stays stable across 10 sequential deposits", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      const gasUsage: bigint[] = [];

      for (let i = 0; i < 10; i++) {
        const c = randomCommitment();
        const tx = await pool
          .connect(alice)
          .deposit(c, { value: DEPOSIT_AMOUNT });
        const receipt = await tx.wait();
        gasUsage.push(receipt!.gasUsed);
      }

      console.log("    Gas per deposit (10 sequential):");
      for (const [i, g] of gasUsage.entries()) {
        console.log(`      Deposit ${i + 1}: ${g}`);
      }

      // All deposits must stay below the threshold individually
      for (const [i, g] of gasUsage.entries()) {
        expect(g).to.be.lessThan(
          MAX_DEPOSIT_GAS,
          `deposit ${i + 1} used ${g} gas, threshold is ${MAX_DEPOSIT_GAS}`
        );
      }

      // All deposits must stay within 35% of the mean.
      // The first deposit writes cold storage slots (uniqueDepositors, lastDepositTime,
      // depositsPerAddress) that are warm on subsequent calls, causing ~31% deviation.
      // A 35% bound catches genuine regressions while tolerating this known cold/warm spread.
      const sum = gasUsage.reduce((a, b) => a + b, 0n);
      const avg = sum / BigInt(gasUsage.length);

      for (const [i, g] of gasUsage.entries()) {
        const diff = g > avg ? g - avg : avg - g;
        expect(diff * 100n / avg).to.be.lessThan(
          35n,
          `deposit ${i + 1} gas ${g} deviates more than 35% from avg ${avg}`
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------

  describe("transfer", function () {
    it("transfer gas is below threshold", async function () {
      const { pool, alice } = await loadFixture(deployFixture);

      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      const root = await pool.getLastRoot();

      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      const tx = await pool.connect(alice).transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Transfer gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_TRANSFER_GAS,
        `transfer used ${gas} gas, threshold is ${MAX_TRANSFER_GAS}`
      );
    });

    it("transfer gas after 10 deposits is below threshold", async function () {
      const { pool, alice } = await loadFixture(deployFixture);

      for (let i = 0; i < 10; i++) {
        await pool
          .connect(alice)
          .deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      }
      const root = await pool.getLastRoot();

      const tx = await pool.connect(alice).transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Transfer (after 10 deposits) gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_TRANSFER_GAS,
        `transfer (after 10 deposits) used ${gas} gas, threshold is ${MAX_TRANSFER_GAS}`
      );
    });
  });

  // -------------------------------------------------------------------------
  // Withdraw
  // -------------------------------------------------------------------------

  describe("withdraw", function () {
    it("withdraw gas is below threshold", async function () {
      const { pool, alice, bob } = await loadFixture(deployFixture);

      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      const root = await pool.getLastRoot();

      const nullifier = randomCommitment();
      const changeCommitment = randomCommitment();

      const tx = await pool.connect(alice).withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        ethers.parseEther("0.5"),
        bob.address,
        changeCommitment,
        ethers.ZeroAddress, // no relayer
        0n // no fee
      );
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Withdraw (with change) gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_WITHDRAW_GAS,
        `withdraw used ${gas} gas, threshold is ${MAX_WITHDRAW_GAS}`
      );
    });

    it("withdraw without change (zero changeCommitment) gas is below threshold", async function () {
      const { pool, alice, bob } = await loadFixture(deployFixture);

      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      const root = await pool.getLastRoot();

      const nullifier = randomCommitment();

      const tx = await pool.connect(alice).withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        DEPOSIT_AMOUNT,
        bob.address,
        0n, // no change commitment
        ethers.ZeroAddress, // no relayer
        0n // no fee
      );
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Withdraw (no change) gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_WITHDRAW_GAS,
        `withdraw (no change) used ${gas} gas, threshold is ${MAX_WITHDRAW_GAS}`
      );
    });

    it("withdraw with relayer fee gas is below threshold", async function () {
      const { pool, alice, bob, relayer } = await loadFixture(deployFixture);

      const depositValue = ethers.parseEther("2");
      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: depositValue });
      const root = await pool.getLastRoot();

      const nullifier = randomCommitment();
      const fee = ethers.parseEther("0.01");
      const withdrawAmount = ethers.parseEther("1");
      const changeCommitment = randomCommitment();

      const tx = await pool.connect(alice).withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        withdrawAmount,
        bob.address,
        changeCommitment,
        relayer.address,
        fee
      );
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    Withdraw (with relayer fee) gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_WITHDRAW_GAS,
        `withdraw with relayer fee used ${gas} gas, threshold is ${MAX_WITHDRAW_GAS}`
      );
    });
  });

  // -------------------------------------------------------------------------
  // Batch deposit
  // -------------------------------------------------------------------------

  describe("batchDeposit", function () {
    it("batchDeposit (10 items) gas is below threshold", async function () {
      const { pool, alice } = await loadFixture(deployFixture);

      const count = 10;
      const commitments: bigint[] = [];
      const amounts: bigint[] = [];
      let totalValue = 0n;
      const perItemAmount = ethers.parseEther("0.1");

      for (let i = 0; i < count; i++) {
        commitments.push(randomCommitment());
        amounts.push(perItemAmount);
        totalValue += perItemAmount;
      }

      const tx = await pool
        .connect(alice)
        .batchDeposit(commitments, amounts, { value: totalValue });
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    batchDeposit (10 items) gas: ${gas}`);
      expect(gas).to.be.lessThan(
        MAX_BATCH_DEPOSIT_GAS,
        `batchDeposit (10 items) used ${gas} gas, threshold is ${MAX_BATCH_DEPOSIT_GAS}`
      );
    });

    it("batchDeposit (1 item) gas is below single deposit threshold", async function () {
      const { pool, alice } = await loadFixture(deployFixture);

      const commitment = randomCommitment();
      const amount = DEPOSIT_AMOUNT;

      const tx = await pool
        .connect(alice)
        .batchDeposit([commitment], [amount], { value: amount });
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(`    batchDeposit (1 item) gas: ${gas}`);
      // A 1-item batch should not be dramatically more expensive than a plain deposit
      expect(gas).to.be.lessThan(
        MAX_DEPOSIT_GAS,
        `batchDeposit (1 item) used ${gas} gas, threshold is ${MAX_DEPOSIT_GAS}`
      );
    });
  });
});
