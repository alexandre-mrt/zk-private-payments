import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT = 5;
const CAPACITY = 2 ** MERKLE_HEIGHT; // 32

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie, relayer, dave, eve] =
    await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie, relayer, dave, eve };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function depositOne(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function withdrawOne(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment = 0n
): Promise<void> {
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient as `0x${string}`,
    changeCommitment,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

// ---------------------------------------------------------------------------
// Ultra Parametric
// ---------------------------------------------------------------------------

describe("Ultra Parametric", function () {
  // -------------------------------------------------------------------------
  // 40 deposit + verify cycles
  // -------------------------------------------------------------------------

  for (let i = 0; i < 40; i++) {
    it(`deposit cycle #${i}: commitment tracked, balance updated`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const commitment = BigInt(i + 1) * 317n + BigInt(i) * 2200n + 60_000_000n;

      await depositOne(pool, alice, commitment, amount);

      expect(await pool.isCommitted(commitment)).to.be.true;
      expect(await pool.totalDeposited()).to.equal(amount);
    });
  }

  // -------------------------------------------------------------------------
  // 30 transfer + verify cycles
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    it(`transfer cycle #${i}: nullifier spent, 2 outputs indexed`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const inputCommitment = BigInt(i + 1) * 331n + 61_000_000n;
      const root = await depositOne(pool, alice, inputCommitment, depositAmount);

      const out1 = BigInt(i + 1) * 337n + 61_100_000n;
      const out2 = BigInt(i + 1) * 347n + 61_200_000n;
      const nullifier = BigInt(i + 1) * 349n + 61_300_000n;

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      expect(await pool.isSpent(nullifier)).to.be.true;
      expect(await pool.commitments(out1)).to.be.true;
      expect(await pool.commitments(out2)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 30 withdrawal amount variations
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    const depositAmount = ethers.parseEther("10");
    const withdrawAmount = (depositAmount * BigInt(i + 1)) / 30n;
    it(`withdrawal amount variation #${i}: correct ETH sent`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const bobAddr = await bob.getAddress();

      const commitment = BigInt(i + 1) * 353n + 62_000_000n;
      const root = await depositOne(pool, alice, commitment, depositAmount);
      const nullifier = BigInt(i + 1) * 359n + 62_100_000n;

      const balBefore = await ethers.provider.getBalance(bobAddr);
      await withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr);
      const balAfter = await ethers.provider.getBalance(bobAddr);

      expect(balAfter - balBefore).to.equal(withdrawAmount);
    });
  }

  // -------------------------------------------------------------------------
  // 30 getPoolStats after incremental operations
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 30; n++) {
    it(`getPoolStats after ${n} deposits: all fields consistent`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 367n + BigInt(n) * 1100n + 63_000_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      const [totalDeposited, , , depositCount, , , poolBalance] =
        await pool.getPoolStats();

      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(depositAmount * BigInt(n));
      expect(poolBalance).to.equal(depositAmount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 20 batchDeposit size variations (sizes 1-10, x2)
  // -------------------------------------------------------------------------

  for (let size = 1; size <= 10; size++) {
    it(`batchDeposit(${size}): ${size} commitments indexed`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("0.5");
      const commitments: bigint[] = [];
      const amounts: bigint[] = [];

      for (let j = 0; j < size; j++) {
        commitments.push(BigInt(j + 1) * 373n + BigInt(size) * 2000n + 64_000_000n);
        amounts.push(amount);
      }

      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: amount * BigInt(size),
      });

      for (const c of commitments) {
        expect(await pool.commitments(c)).to.be.true;
      }
    });
  }

  for (let size = 1; size <= 10; size++) {
    it(`batchDeposit(${size}): totalDeposited correct`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const commitments: bigint[] = [];
      const amounts: bigint[] = [];

      for (let j = 0; j < size; j++) {
        commitments.push(BigInt(j + 1) * 379n + BigInt(size) * 3000n + 65_000_000n);
        amounts.push(amount);
      }

      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: amount * BigInt(size),
      });

      expect(await pool.totalDeposited()).to.equal(amount * BigInt(size));
    });
  }
});
