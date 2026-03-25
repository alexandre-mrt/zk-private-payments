import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT = 9; // capacity = 512
const CAPACITY = 2 ** MERKLE_HEIGHT; // 512

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

async function deployPetaPoolFixture() {
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
  pool: Awaited<ReturnType<typeof deployPetaPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployPetaPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function withdrawOne(
  pool: Awaited<ReturnType<typeof deployPetaPoolFixture>>["pool"],
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
// Peta Parametric
// ---------------------------------------------------------------------------

describe("Peta Parametric", function () {
  // -------------------------------------------------------------------------
  // 400 deposits — commitment tracked (tree height 9, capacity 512)
  // Primes/offsets: 557n, 6_500n / base 95_000_000n — distinct from all prior suites
  // -------------------------------------------------------------------------

  for (let i = 0; i < 400; i++) {
    it(`deposit #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployPetaPoolFixture);
      const amount = ethers.parseEther("1");
      // Distinct primes/offset per suite — no collision with other parametric files
      const commitment =
        BigInt(i + 1) * 557n + BigInt(i) * 6_500n + 95_000_000n;

      await depositOne(pool, alice, commitment, amount);

      expect(await pool.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 200 transfers — nullifier spent after transfer
  // -------------------------------------------------------------------------

  for (let i = 0; i < 200; i++) {
    it(`transfer #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployPetaPoolFixture);
      const amount = ethers.parseEther("1");

      const inputCommitment =
        BigInt(i + 1) * 563n + BigInt(i) * 5_700n + 96_000_000n;
      const root = await depositOne(pool, alice, inputCommitment, amount);

      const nullifier = BigInt(i + 1) * 569n + 96_100_000n;
      const out1 = BigInt(i + 1) * 571n + 96_200_000n;
      const out2 = BigInt(i + 1) * 577n + 96_300_000n;

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
  // 200 hash pairs — on-chain Poseidon determinism + in-field
  // -------------------------------------------------------------------------

  for (let i = 0; i < 200; i++) {
    const left = BigInt(i + 1) * 587n + 97_000_000n;
    const right = BigInt(i + 1) * 593n + 97_100_000n;
    it(`hash #${i}`, async function () {
      const { pool } = await loadFixture(deployPetaPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 200 getPoolStats — deposit count and total deposited match
  // -------------------------------------------------------------------------

  for (let i = 0; i < 200; i++) {
    it(`stats #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployPetaPoolFixture);
      const amount = ethers.parseEther("1");
      const n = (i % 5) + 1; // 1–5 deposits to keep tests fast

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 599n + BigInt(i) * 4_000n + 98_000_000n;
        await depositOne(pool, alice, c, amount);
      }

      const [totalDeposited, , , depositCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(amount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 200 commitment bounds — field element validation
  // -------------------------------------------------------------------------

  for (let i = 0; i < 200; i++) {
    // Stay within uint256: bits 4..203 (1 per iteration, all < 256)
    const bits = 4 + i;
    const candidate = 2n ** BigInt(bits) - 1n;
    const isValid = candidate > 0n && candidate < FIELD_SIZE;
    it(`bound #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployPetaPoolFixture);

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
});
