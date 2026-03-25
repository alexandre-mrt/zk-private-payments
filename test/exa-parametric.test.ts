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

async function deployExaPoolFixture() {
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
  pool: Awaited<ReturnType<typeof deployExaPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployExaPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function withdrawOne(
  pool: Awaited<ReturnType<typeof deployExaPoolFixture>>["pool"],
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
// Exa Parametric
// Primes/offsets: 641n, 643n, 647n, 653n, 659n, 661n / bases 100_000_000n+
// Distinct from all prior suites (highest prior: 98_000_000n in peta)
// ---------------------------------------------------------------------------

describe("Exa Parametric", function () {
  // -------------------------------------------------------------------------
  // 300 deposit tests — commitment tracked after deposit
  // Base offset: 100_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    it(`deposit #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployExaPoolFixture);
      const amount = ethers.parseEther("1");
      const commitment =
        BigInt(i + 1) * 641n + BigInt(i) * 6_200n + 100_000_000n;

      await depositOne(pool, alice, commitment, amount);

      expect(await pool.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 300 transfer tests — nullifier spent after transfer
  // Base offset: 101_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    it(`transfer #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployExaPoolFixture);
      const amount = ethers.parseEther("1");

      const inputCommitment =
        BigInt(i + 1) * 643n + BigInt(i) * 5_800n + 101_000_000n;
      const root = await depositOne(pool, alice, inputCommitment, amount);

      const nullifier = BigInt(i + 1) * 647n + 101_100_000n;
      const out1 = BigInt(i + 1) * 653n + 101_200_000n;
      const out2 = BigInt(i + 1) * 659n + 101_300_000n;

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
  // 300 hash tests — on-chain Poseidon determinism + in-field
  // Base offset: 102_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    const left = BigInt(i + 1) * 661n + 102_000_000n;
    const right = BigInt(i + 1) * 673n + 102_100_000n;
    it(`hash #${i}`, async function () {
      const { pool } = await loadFixture(deployExaPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 300 stats tests — deposit count and total deposited match
  // Base offset: 103_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    it(`stats #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployExaPoolFixture);
      const amount = ethers.parseEther("1");
      const n = (i % 5) + 1; // 1–5 deposits to keep tests fast

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 677n + BigInt(i) * 4_100n + 103_000_000n;
        await depositOne(pool, alice, c, amount);
      }

      const [totalDeposited, , , depositCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(amount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 300 bound tests — valid field elements accepted
  // Base offset: 104_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    const commitment = BigInt(i + 1) * 683n + BigInt(i) * 4_300n + 104_000_000n;
    it(`bound #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployExaPoolFixture);
      const amount = ethers.parseEther("1");

      await depositOne(pool, alice, commitment, amount);

      expect(await pool.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 300 withdrawal tests — recipient balance increases by withdrawn amount
  // Base offset: 105_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    it(`withdrawal #${i}`, async function () {
      const { pool, alice, charlie } = await loadFixture(deployExaPoolFixture);
      const amount = ethers.parseEther("1");

      const commitment =
        BigInt(i + 1) * 691n + BigInt(i) * 4_500n + 105_000_000n;
      const root = await depositOne(pool, alice, commitment, amount);

      const nullifier = BigInt(i + 1) * 701n + 105_100_000n;
      const recipientAddr = await charlie.getAddress();

      const balBefore = await ethers.provider.getBalance(recipientAddr);
      await withdrawOne(pool, root, nullifier, amount, recipientAddr);
      const balAfter = await ethers.provider.getBalance(recipientAddr);

      expect(balAfter - balBefore).to.equal(amount);
    });
  }
});
