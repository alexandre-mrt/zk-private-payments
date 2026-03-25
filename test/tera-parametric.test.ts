import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT = 5; // capacity = 32
const CAPACITY = 2 ** MERKLE_HEIGHT; // 32

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
// Fixture
// ---------------------------------------------------------------------------

async function deployTeraPoolFixture() {
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
  pool: Awaited<ReturnType<typeof deployTeraPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployTeraPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function withdrawOne(
  pool: Awaited<ReturnType<typeof deployTeraPoolFixture>>["pool"],
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string
): Promise<void> {
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient as `0x${string}`,
    0n,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

// ---------------------------------------------------------------------------
// Tera Parametric
// ---------------------------------------------------------------------------

describe("Tera Parametric", function () {
  // -------------------------------------------------------------------------
  // 5 deposits — commitment tracked (tree height 5, capacity 32)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    it(`deposit #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployTeraPoolFixture);
      const amount = ethers.parseEther("1");
      // Use distinct primes per-suite to avoid collision with other test files
      const commitment =
        BigInt(i + 1) * 419n + BigInt(i) * 5_000n + 80_000_000n;

      await depositOne(pool, alice, commitment, amount);

      expect(await pool.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 5 transfers — nullifier spent
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    it(`transfer #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployTeraPoolFixture);
      const amount = ethers.parseEther("1");

      const inputCommitment =
        BigInt(i + 1) * 421n + BigInt(i) * 4_700n + 81_000_000n;
      const root = await depositOne(pool, alice, inputCommitment, amount);

      const nullifier = BigInt(i + 1) * 431n + 81_100_000n;
      const out1 = BigInt(i + 1) * 433n + 81_200_000n;
      const out2 = BigInt(i + 1) * 439n + 81_300_000n;

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      expect(await pool.nullifiers(nullifier)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 5 hash pairs — on-chain Poseidon determinism
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    const left = BigInt(i + 1) * 443n + 82_000_000n;
    const right = BigInt(i + 1) * 449n + 82_100_000n;
    it(`hash #${i}`, async function () {
      const { pool } = await loadFixture(deployTeraPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 5 getPoolStats — deposit count and total deposited match
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    it(`stats #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployTeraPoolFixture);
      const amount = ethers.parseEther("1");
      const n = (i % 5) + 1; // 1-5 deposits to keep tests fast

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 457n + BigInt(i) * 3_000n + 83_000_000n;
        await depositOne(pool, alice, c, amount);
      }

      const [totalDeposited, , , depositCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(amount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 5 commitment bounds — field element validation
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    // Stay within uint256: bits 4..203 (increment 1 per iteration)
    const bits = 4 + i; // 4, 5, 6, …, 203 — all < 256
    const candidate = 2n ** BigInt(bits) - 1n;
    const isValid = candidate > 0n && candidate < FIELD_SIZE;
    it(`bound #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployTeraPoolFixture);

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
  // 5 withdrawal amounts — correct ETH sent to recipient
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    it(`withdraw #${i}`, async function () {
      const { pool, alice, bob } = await loadFixture(deployTeraPoolFixture);
      const depositAmount = ethers.parseEther("10");
      const withdrawAmount =
        (depositAmount * BigInt(i + 1)) / 100n;
      const bobAddr = await bob.getAddress();

      const commitment =
        BigInt(i + 1) * 461n + BigInt(i) * 3_200n + 84_000_000n;
      const root = await depositOne(pool, alice, commitment, depositAmount);
      const nullifier = BigInt(i + 1) * 463n + 84_100_000n;

      const balBefore = await ethers.provider.getBalance(bobAddr);
      await withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr);
      const balAfter = await ethers.provider.getBalance(bobAddr);

      expect(balAfter - balBefore).to.equal(withdrawAmount);
    });
  }
});
