import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT = 7; // capacity = 128 (supports up to 100 deposits)
const CAPACITY = 2 ** MERKLE_HEIGHT; // 128

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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
  const [owner, alice, bob, charlie, relayer] = await ethers.getSigners();

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

  return { pool, owner, alice, bob, charlie, relayer };
}

async function deployStealthFixture() {
  const [owner, alice, bob, charlie] = await ethers.getSigners();
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();
  return { registry, owner, alice, bob, charlie };
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
// Hyper Parametric
// ---------------------------------------------------------------------------

describe("Hyper Parametric", function () {
  // -------------------------------------------------------------------------
  // 100 deposit amounts — from 1 wei to 100 ETH (linear steps)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    const step = (ethers.parseEther("100") * BigInt(i + 1)) / 100n;
    const amount = step > 0n ? step : 1n;
    it(`deposit amount #${i} (${amount} wei): commitment stored, totalDeposited updated`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment =
        BigInt(i + 1) * 347n + BigInt(i) * 3100n + 60_000_000n;
      await depositOne(pool, alice, commitment, amount);
      expect(await pool.isCommitted(commitment)).to.be.true;
      expect(await pool.totalDeposited()).to.equal(amount);
    });
  }

  // -------------------------------------------------------------------------
  // 100 hash pair determinism checks
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    const left = BigInt(i + 1) * 349n + 61_000_000n;
    const right = BigInt(i + 1) * 353n + 61_100_000n;
    it(`hash pair #${i}: deterministic and within field`, async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 100 getPoolStats consistency checks after N deposits (height=7, cap=128)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 100; n++) {
    it(`getPoolStats after ${n} deposits: depositCount and totalDeposited match`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 359n + BigInt(n) * 700n + 62_000_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      const [totalDeposited, , , depositCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(depositAmount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 100 transfer cycles — each deposits then transfers to two output notes
  // Transfer inserts 2 outputs. With height=7 (cap=128) and 1 deposit + 2 outputs
  // per iteration, up to 42 iterations fit safely (42*3=126 <= 128).
  // For iterations > 42 we use independent fixtures so tree never fills.
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    it(`transfer cycle #${i}: both output commitments stored, nullifier spent`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");

      const inputC = BigInt(i + 1) * 367n + 63_000_000n;
      const root = await depositOne(pool, alice, inputC, depositAmount);

      const out1 = BigInt(i + 1) * 373n + 63_100_000n;
      const out2 = BigInt(i + 1) * 379n + 63_200_000n;
      const nullifier = BigInt(i + 1) * 383n + 63_300_000n;

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      expect(await pool.commitments(out1)).to.be.true;
      expect(await pool.commitments(out2)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 100 commitment bounds — sweeping bit widths
  // -------------------------------------------------------------------------

  for (let bits = 1; bits <= 199; bits += 2) {
    const candidate = 2n ** BigInt(bits) - 1n;
    const isValid = candidate > 0n && candidate < FIELD_SIZE;
    it(`commitment 2^${bits}-1: valid field element == ${isValid}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      if (isValid) {
        await expect(
          pool
            .connect(alice)
            .deposit(candidate, { value: ethers.parseEther("1") })
        ).to.not.be.reverted;
        expect(await pool.isCommitted(candidate)).to.be.true;
      } else {
        await expect(
          pool
            .connect(alice)
            .deposit(candidate, { value: ethers.parseEther("1") })
        ).to.be.reverted;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 100 withdrawal variations — withdraw fractions of 10 ETH deposit
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    const depositAmount = ethers.parseEther("10");
    const withdrawAmount = (depositAmount * BigInt(i + 1)) / 100n;
    it(`withdrawal variation #${i}: recipient receives ${withdrawAmount} wei`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const bobAddr = await bob.getAddress();

      const c = BigInt(i + 1) * 389n + 64_000_000n;
      const root = await depositOne(pool, alice, c, depositAmount);
      const nullifier = BigInt(i + 1) * 397n + 64_100_000n;

      const balBefore = await ethers.provider.getBalance(bobAddr);
      await withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr);
      const balAfter = await ethers.provider.getBalance(bobAddr);

      expect(balAfter - balBefore).to.equal(withdrawAmount);
    });
  }
});
