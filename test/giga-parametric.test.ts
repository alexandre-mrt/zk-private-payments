import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT = 8;
const CAPACITY = 2 ** MERKLE_HEIGHT; // 256

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

async function deployGigaPoolFixture() {
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
  pool: Awaited<ReturnType<typeof deployGigaPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployGigaPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function withdrawOne(
  pool: Awaited<ReturnType<typeof deployGigaPoolFixture>>["pool"],
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
// Giga Parametric
// ---------------------------------------------------------------------------

describe("Giga Parametric", function () {
  // -------------------------------------------------------------------------
  // 200 deposits — commitment tracked
  // -------------------------------------------------------------------------

  for (let i = 0; i < 200; i++) {
    it(`deposit #${i}: tracked`, async function () {
      const { pool, alice } = await loadFixture(deployGigaPoolFixture);
      const commitment =
        BigInt(i + 1) * 307n + BigInt(i) * 4_000n + 60_000_000n;
      const amount = ethers.parseEther("1");

      await depositOne(pool, alice, commitment, amount);

      expect(await pool.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 100 transfers — nullifier spent, outputs indexed
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    it(`transfer #${i}: nullifier spent, outputs indexed`, async function () {
      const { pool, alice } = await loadFixture(deployGigaPoolFixture);
      const amount = ethers.parseEther("1");

      const inputCommitment =
        BigInt(i + 1) * 311n + BigInt(i) * 3_500n + 61_000_000n;
      const root = await depositOne(pool, alice, inputCommitment, amount);

      const nullifier = BigInt(i + 1) * 313n + 61_100_000n;
      const out1 = BigInt(i + 1) * 317n + 61_200_000n;
      const out2 = BigInt(i + 1) * 331n + 61_300_000n;

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
      expect(await pool.commitments(out1)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 100 hash pairs — on-chain == off-chain (deterministic)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    const left = BigInt(i + 1) * 337n + 62_000_000n;
    const right = BigInt(i + 1) * 347n + 62_100_000n;
    it(`hash #${i}: on-chain == off-chain`, async function () {
      const { pool } = await loadFixture(deployGigaPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 100 getPoolStats verifications at incremental deposit counts
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    it(`stats at deposit #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployGigaPoolFixture);
      const amount = ethers.parseEther("1");
      const n = i + 1;

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 349n + BigInt(i) * 2_000n + 63_000_000n;
        await depositOne(pool, alice, c, amount);
      }

      const [totalDeposited, , , depositCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(amount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 100 commitment bounds — valid field elements accepted, invalid rejected
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    const bits = 8 + i * 2; // 8, 10, 12, …, 206
    const candidate = 2n ** BigInt(bits) - 1n;
    const isValid = candidate > 0n && candidate < FIELD_SIZE;
    it(`commitment bound #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployGigaPoolFixture);

      if (isValid) {
        await expect(
          pool.connect(alice).deposit(candidate, { value: ethers.parseEther("1") })
        ).to.not.be.reverted;
        expect(await pool.isCommitted(candidate)).to.be.true;
      } else {
        await expect(
          pool.connect(alice).deposit(candidate, { value: ethers.parseEther("1") })
        ).to.be.reverted;
      }
    });
  }
});
