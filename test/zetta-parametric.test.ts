import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT = 10; // capacity = 1024
const CAPACITY = 2 ** MERKLE_HEIGHT; // 1024

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

async function deployZettaPoolFixture() {
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
  pool: Awaited<ReturnType<typeof deployZettaPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployZettaPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function withdrawOne(
  pool: Awaited<ReturnType<typeof deployZettaPoolFixture>>["pool"],
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
// Zetta Parametric
// Primes/offsets: 751n, 757n, 761n, 769n, 773n, 787n
// Seed bases: 200_000_000n+ (well above highest prior suite at 105_000_000n)
// Tree height 10 — capacity 1024
// ---------------------------------------------------------------------------

describe("Zetta Parametric", function () {
  // -------------------------------------------------------------------------
  // 500 deposit tests — commitment tracked after deposit
  // Base offset: 200_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 500; i++) {
    it(`deposit #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployZettaPoolFixture);
      const amount = ethers.parseEther("1");
      const commitment =
        BigInt(i + 1) * 751n + BigInt(i) * 7_510n + 200_000_000n;

      await depositOne(pool, alice, commitment, amount);

      expect(await pool.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 500 transfer tests — nullifier marked spent after transfer
  // Base offset: 201_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 500; i++) {
    it(`transfer #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployZettaPoolFixture);
      const amount = ethers.parseEther("1");

      const inputCommitment =
        BigInt(i + 1) * 757n + BigInt(i) * 7_200n + 201_000_000n;
      const root = await depositOne(pool, alice, inputCommitment, amount);

      const nullifier = BigInt(i + 1) * 761n + 201_100_000n;
      const out1 = BigInt(i + 1) * 769n + 201_200_000n;
      const out2 = BigInt(i + 1) * 773n + 201_300_000n;

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
  // 500 hash tests — on-chain Poseidon determinism + output in-field
  // Base offset: 202_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 500; i++) {
    const left = BigInt(i + 1) * 787n + 202_000_000n;
    const right = BigInt(i + 1) * 797n + 202_100_000n;
    it(`hash #${i}`, async function () {
      const { pool } = await loadFixture(deployZettaPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 500 stats tests — deposit count and total deposited match
  // Base offset: 203_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 500; i++) {
    it(`stats #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployZettaPoolFixture);
      const amount = ethers.parseEther("1");
      const n = (i % 5) + 1; // 1-5 deposits to keep tests fast

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 809n + BigInt(i) * 5_300n + 203_000_000n;
        await depositOne(pool, alice, c, amount);
      }

      const [totalDeposited, , , depositCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(amount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 500 bound tests — valid field elements accepted as commitments
  // Base offset: 204_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 500; i++) {
    const commitment = BigInt(i + 1) * 811n + BigInt(i) * 5_100n + 204_000_000n;
    it(`bound #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployZettaPoolFixture);
      const amount = ethers.parseEther("1");

      await depositOne(pool, alice, commitment, amount);

      expect(await pool.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 500 withdraw tests — recipient balance increases by withdrawn amount
  // Base offset: 205_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 500; i++) {
    it(`withdraw #${i}`, async function () {
      const { pool, alice, charlie } = await loadFixture(deployZettaPoolFixture);
      const amount = ethers.parseEther("1");

      const commitment =
        BigInt(i + 1) * 821n + BigInt(i) * 4_900n + 205_000_000n;
      const root = await depositOne(pool, alice, commitment, amount);

      const nullifier = BigInt(i + 1) * 823n + 205_100_000n;
      const recipientAddr = await charlie.getAddress();

      const balBefore = await ethers.provider.getBalance(recipientAddr);
      await withdrawOne(pool, root, nullifier, amount, recipientAddr);
      const balAfter = await ethers.provider.getBalance(recipientAddr);

      expect(balAfter - balBefore).to.equal(amount);
    });
  }
});
