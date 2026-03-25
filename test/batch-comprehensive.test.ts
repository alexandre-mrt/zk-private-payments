import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_ETH = ethers.parseEther("1");
const HALF_ETH = ethers.parseEther("0.5");
const MAX_BATCH_SIZE = 10;
const ONE_DAY = 86_400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

function makeCommitments(n: number): bigint[] {
  return Array.from({ length: n }, () => randomCommitment());
}

function makeAmounts(n: number, amount: bigint = ONE_ETH): bigint[] {
  return Array.from({ length: n }, () => amount);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie] = await ethers.getSigners();

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

  return { pool, owner, alice, bob, charlie };
}

async function deployPoolWithReceiptFixture() {
  const base = await deployPoolFixture();

  const DepositReceipt = await ethers.getContractFactory("DepositReceipt");
  const receipt = await DepositReceipt.deploy(await base.pool.getAddress());
  await base.pool.connect(base.owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];

async function timelockExecute(pool: Pool, hash: string): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Batch Operations Comprehensive", function () {
  // -------------------------------------------------------------------------
  // Basic batch
  // -------------------------------------------------------------------------

  describe("Basic batch", function () {
    it("batchDeposit(1) is equivalent to single deposit", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const cSingle = randomCommitment();
      await pool.connect(alice).deposit(cSingle, { value: ONE_ETH });

      const cBatch = randomCommitment();
      await pool.connect(bob).batchDeposit([cBatch], [ONE_ETH], { value: ONE_ETH });

      expect(await pool.commitments(cSingle)).to.be.true;
      expect(await pool.commitments(cBatch)).to.be.true;
      expect(await pool.nextIndex()).to.equal(2n);
      expect(await pool.depositsPerAddress(alice.address)).to.equal(1n);
      expect(await pool.depositsPerAddress(bob.address)).to.equal(1n);
    });

    it("batchDeposit(3) creates 3 commitments in insertion order", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitments = makeCommitments(3);
      const amounts = makeAmounts(3);
      const total = ONE_ETH * 3n;

      await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

      expect(await pool.nextIndex()).to.equal(3n);
      for (let i = 0; i < 3; i++) {
        expect(await pool.commitments(commitments[i])).to.be.true;
        expect(await pool.commitmentIndex(commitments[i])).to.equal(BigInt(i));
      }
    });

    it("batchDeposit(10) at max batch size succeeds", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitments = makeCommitments(MAX_BATCH_SIZE);
      const perDeposit = ethers.parseEther("0.1");
      const amounts = makeAmounts(MAX_BATCH_SIZE, perDeposit);
      const total = perDeposit * BigInt(MAX_BATCH_SIZE);

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.not.be.reverted;

      expect(await pool.nextIndex()).to.equal(10n);
    });

    it("batchDeposit(11) exceeds max and reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitments = makeCommitments(MAX_BATCH_SIZE + 1);
      const perDeposit = ethers.parseEther("0.1");
      const amounts = makeAmounts(MAX_BATCH_SIZE + 1, perDeposit);
      const total = perDeposit * BigInt(MAX_BATCH_SIZE + 1);

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.be.revertedWith("ConfidentialPool: batch too large");
    });
  });

  // -------------------------------------------------------------------------
  // Batch + stats
  // -------------------------------------------------------------------------

  describe("Batch + stats", function () {
    it("batchDeposit updates totalDeposited by the sum of all amounts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const amounts = [ONE_ETH, ethers.parseEther("2"), ethers.parseEther("3")];
      const total = amounts.reduce((a, b) => a + b, 0n);
      const commitments = makeCommitments(3);

      const [depositedBefore] = await pool.getPoolStats();
      await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });
      const [depositedAfter] = await pool.getPoolStats();

      expect(depositedAfter - depositedBefore).to.equal(total);
    });

    it("batchDeposit increments uniqueDepositorCount only once per address", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await pool
        .connect(alice)
        .batchDeposit(makeCommitments(3), makeAmounts(3), { value: ONE_ETH * 3n });

      expect(await pool.uniqueDepositorCount()).to.equal(1n);

      // Second batch from same address must not increment the counter
      await pool
        .connect(alice)
        .batchDeposit(makeCommitments(2), makeAmounts(2), { value: ONE_ETH * 2n });

      expect(await pool.uniqueDepositorCount()).to.equal(1n);
    });

    it("batchDeposit from 2 different addresses counts 2 unique depositors", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      await pool
        .connect(alice)
        .batchDeposit(makeCommitments(2), makeAmounts(2), { value: ONE_ETH * 2n });

      expect(await pool.uniqueDepositorCount()).to.equal(1n);

      await pool
        .connect(bob)
        .batchDeposit(makeCommitments(2), makeAmounts(2), { value: ONE_ETH * 2n });

      expect(await pool.uniqueDepositorCount()).to.equal(2n);
    });
  });

  // -------------------------------------------------------------------------
  // Batch + denominations
  // -------------------------------------------------------------------------

  describe("Batch + denominations", function () {
    it("batchDeposit with all allowed denominations succeeds", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const denom1 = ONE_ETH;
      const denom2 = ethers.parseEther("2");

      await timelockExecute(pool, timelockHash("addDenomination", denom1));
      await pool.addDenomination(denom1);
      await timelockExecute(pool, timelockHash("addDenomination", denom2));
      await pool.addDenomination(denom2);

      const commitments = makeCommitments(4);
      const amounts = [denom1, denom2, denom1, denom2];
      const total = denom1 * 2n + denom2 * 2n;

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.not.be.reverted;

      expect(await pool.depositsPerAddress(alice.address)).to.equal(4n);
    });

    it("batchDeposit fails and reverts entirely if any single amount is non-allowed", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await timelockExecute(pool, timelockHash("addDenomination", ONE_ETH));
      await pool.addDenomination(ONE_ETH);

      const commitments = makeCommitments(3);
      // Third amount is not an allowed denomination
      const amounts = [ONE_ETH, ONE_ETH, HALF_ETH];
      const total = ONE_ETH * 2n + HALF_ETH;

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");

      // No state change should have occurred
      expect(await pool.depositsPerAddress(alice.address)).to.equal(0n);
      expect(await pool.nextIndex()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Batch + receipts
  // -------------------------------------------------------------------------

  describe("Batch + receipts", function () {
    it("batchDeposit mints N receipt NFTs with sequential token IDs", async function () {
      const { pool, alice, receipt } = await loadFixture(deployPoolWithReceiptFixture);

      const n = 4;
      const commitments = makeCommitments(n);
      const amounts = makeAmounts(n);
      const total = ONE_ETH * BigInt(n);

      await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

      for (let i = 0; i < n; i++) {
        expect(await receipt.ownerOf(BigInt(i))).to.equal(alice.address);
      }
      // Token ID n should not exist yet
      await expect(receipt.ownerOf(BigInt(n))).to.be.reverted;
    });

    it("each batch receipt carries the correct commitment and amount", async function () {
      const { pool, alice, receipt } = await loadFixture(deployPoolWithReceiptFixture);

      const commitments = makeCommitments(3);
      const amounts = [ONE_ETH, ethers.parseEther("2"), ethers.parseEther("3")];
      const total = amounts.reduce((a, b) => a + b, 0n);

      await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

      for (let i = 0; i < 3; i++) {
        const tokenId = BigInt(i);
        expect(await receipt.tokenCommitment(tokenId)).to.equal(commitments[i]);
        expect(await receipt.tokenAmount(tokenId)).to.equal(amounts[i]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Batch + per-address deposit limit
  // -------------------------------------------------------------------------

  describe("Batch + limits", function () {
    it("batchDeposit respects per-address deposit limit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await timelockExecute(pool, timelockHash("setMaxDepositsPerAddress", 5n));
      await pool.connect(owner).setMaxDepositsPerAddress(5n);

      const commitments = makeCommitments(5);
      const amounts = makeAmounts(5);
      const total = ONE_ETH * 5n;

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.not.be.reverted;

      expect(await pool.depositsPerAddress(alice.address)).to.equal(5n);
    });

    it("batch of 4 reverts when per-address limit is 3 (even if 3 would be ok)", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await timelockExecute(pool, timelockHash("setMaxDepositsPerAddress", 3n));
      await pool.connect(owner).setMaxDepositsPerAddress(3n);

      const commitments = makeCommitments(4);
      const amounts = makeAmounts(4);
      const total = ONE_ETH * 4n;

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");

      // No partial state — nothing was deposited
      expect(await pool.depositsPerAddress(alice.address)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Batch + cooldown
  // -------------------------------------------------------------------------

  describe("Batch + cooldown", function () {
    it("batchDeposit resets lastDepositTime to the current block timestamp", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitments = makeCommitments(2);
      const amounts = makeAmounts(2);
      const total = ONE_ETH * 2n;

      const blockBefore = await ethers.provider.getBlock("latest");
      await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

      const lastTime = await pool.lastDepositTime(alice.address);
      expect(lastTime).to.be.greaterThan(BigInt(blockBefore!.timestamp));
    });

    it("batch after cooldown succeeds; immediate second batch fails", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const cooldown = 3_600n; // 1 hour
      await timelockExecute(pool, timelockHash("setDepositCooldown", cooldown));
      await pool.connect(owner).setDepositCooldown(cooldown);

      // First batch — starts the cooldown
      await pool
        .connect(alice)
        .batchDeposit(makeCommitments(2), makeAmounts(2), { value: ONE_ETH * 2n });

      // Immediate second batch must be blocked
      await expect(
        pool
          .connect(alice)
          .batchDeposit(makeCommitments(2), makeAmounts(2), { value: ONE_ETH * 2n })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");

      // After cooldown expires the batch is accepted
      await time.increase(Number(cooldown) + 1);

      await expect(
        pool
          .connect(alice)
          .batchDeposit(makeCommitments(2), makeAmounts(2), { value: ONE_ETH * 2n })
      ).to.not.be.reverted;

      expect(await pool.depositsPerAddress(alice.address)).to.equal(4n);
    });
  });
});
