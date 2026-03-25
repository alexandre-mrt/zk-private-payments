import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
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

const DEFAULT_DEPOSIT = ethers.parseEther("1");

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
    5,
    hasherAddress
  );

  return { pool, owner, alice, bob, relayer };
}

type Pool = Awaited<ReturnType<typeof deployFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof deployFixture>>["alice"];

async function doDeposit(
  pool: Pool,
  signer: Signer,
  commitment?: bigint,
  value: bigint = DEFAULT_DEPOSIT
) {
  const c = commitment ?? randomCommitment();
  await pool.connect(signer).deposit(c, { value });
  return { commitment: c };
}

async function doWithdraw(
  pool: Pool,
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: Signer,
  changeCommitment: bigint = 0n
) {
  return pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient.address as `0x${string}`,
    changeCommitment,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

// ---------------------------------------------------------------------------
// System Invariants
// ---------------------------------------------------------------------------

describe("System Invariants", function () {
  // Invariant 1: pool balance >= sum of all withdrawal amounts
  it("pool balance >= sum of all withdrawal amounts (totalDeposited - totalWithdrawn)", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const depositAmount = ethers.parseEther("1");

    for (let i = 0; i < 5; i++) {
      await doDeposit(pool, alice, undefined, depositAmount);
    }

    const withdrawAmount = ethers.parseEther("0.5");
    for (let i = 0; i < 2; i++) {
      const root = await pool.getLastRoot();
      await doWithdraw(pool, root, randomCommitment(), withdrawAmount, bob);
    }

    const balance = await ethers.provider.getBalance(await pool.getAddress());
    const [totalDep, totalWith] = await pool.getPoolStats();
    expect(balance).to.be.gte(totalDep - totalWith);
  });

  // Invariant 2: nullifier uniqueness — a spent nullifier cannot be used again
  it("no nullifier can be used twice", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await doDeposit(pool, alice);
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const amount = ethers.parseEther("0.5");

    // First withdrawal succeeds
    await doWithdraw(pool, root, nullifier, amount, bob);
    expect(await pool.isSpent(nullifier)).to.be.true;

    // Fund the pool again so balance check passes
    await doDeposit(pool, alice);
    const root2 = await pool.getLastRoot();

    // Second withdrawal with same nullifier must revert
    await expect(
      doWithdraw(pool, root2, nullifier, amount, bob)
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
  });

  // Invariant 3: commitment uniqueness — same commitment cannot be deposited twice
  it("no commitment can be deposited twice", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await doDeposit(pool, alice, commitment);

    await expect(
      doDeposit(pool, alice, commitment)
    ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
  });

  // Invariant 4: nextIndex is monotonically increasing
  it("nextIndex always increases and never decreases", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const indices: bigint[] = [];
    indices.push(await pool.nextIndex());

    for (let i = 0; i < 4; i++) {
      await doDeposit(pool, alice);
      indices.push(await pool.nextIndex());
    }

    // Withdrawal does not decrease nextIndex (no leaves are removed)
    const root = await pool.getLastRoot();
    await doWithdraw(pool, root, randomCommitment(), ethers.parseEther("0.5"), bob);
    indices.push(await pool.nextIndex());

    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).to.be.gte(indices[i - 1], `nextIndex decreased at step ${i}`);
    }

    // After deposits, nextIndex must have strictly grown
    expect(indices[4]).to.be.gt(indices[0]);
  });

  // Invariant 5: totalDeposited >= totalWithdrawn at all times
  it("totalDeposited is always >= totalWithdrawn", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // Before any operations
    {
      const [dep, wit] = await pool.getPoolStats();
      expect(dep).to.be.gte(wit);
    }

    // After 3 deposits
    for (let i = 0; i < 3; i++) {
      await doDeposit(pool, alice);
    }
    {
      const [dep, wit] = await pool.getPoolStats();
      expect(dep).to.be.gte(wit);
    }

    // After 2 withdrawals
    for (let i = 0; i < 2; i++) {
      const root = await pool.getLastRoot();
      await doWithdraw(pool, root, randomCommitment(), ethers.parseEther("0.5"), bob);
    }
    {
      const [dep, wit] = await pool.getPoolStats();
      expect(dep).to.be.gte(wit);
    }
  });

  // Invariant 6: activeNoteCount never goes negative
  it("activeNoteCount never goes negative", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    expect(await pool.getActiveNoteCount()).to.equal(0n);

    for (let i = 0; i < 3; i++) {
      await doDeposit(pool, alice);
      expect(await pool.getActiveNoteCount()).to.be.gte(0n);
    }

    for (let i = 0; i < 3; i++) {
      const root = await pool.getLastRoot();
      await doWithdraw(pool, root, randomCommitment(), ethers.parseEther("0.5"), bob);
      expect(await pool.getActiveNoteCount()).to.be.gte(0n);
    }
  });

  // Invariant 7: every root that was ever current is recognized (within history window)
  it("every root that was ever current is in the history (within window)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const observedRoots: bigint[] = [];
    observedRoots.push(await pool.getLastRoot());

    for (let i = 0; i < 5; i++) {
      await doDeposit(pool, alice);
      observedRoots.push(await pool.getLastRoot());
    }

    for (const root of observedRoots) {
      expect(await pool.isKnownRoot(root)).to.be.true;
    }
  });

  // Invariant 8: 10 random deposits + 5 random withdrawals maintain all invariants
  it("10 random deposits + 5 random withdrawals maintain all invariants", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const depositAmount = ethers.parseEther("1");
    const withdrawAmount = ethers.parseEther("0.5");
    const usedNullifiers = new Set<bigint>();

    for (let i = 0; i < 10; i++) {
      await doDeposit(pool, alice, undefined, depositAmount);
    }

    for (let i = 0; i < 5; i++) {
      const root = await pool.getLastRoot();
      let nullifier: bigint;
      do {
        nullifier = randomCommitment();
      } while (usedNullifiers.has(nullifier));
      usedNullifiers.add(nullifier);

      await doWithdraw(pool, root, nullifier, withdrawAmount, bob);
    }

    const [totalDep, totalWith, , depCount, withCount] = await pool.getPoolStats();

    // Invariant: totalDeposited >= totalWithdrawn
    expect(totalDep).to.be.gte(totalWith);

    // Invariant: pool balance >= totalDeposited - totalWithdrawn
    const balance = await ethers.provider.getBalance(await pool.getAddress());
    expect(balance).to.be.gte(totalDep - totalWith);

    // Invariant: activeNoteCount >= 0
    expect(await pool.getActiveNoteCount()).to.be.gte(0n);

    // Invariant: depositCount == nextIndex
    expect(await pool.nextIndex()).to.equal(depCount);

    // Invariant: withdrawalCount matches number of withdrawals we did
    expect(withCount).to.equal(5n);

    // Invariant: all used nullifiers are marked spent
    for (const nullifier of usedNullifiers) {
      expect(await pool.isSpent(nullifier)).to.be.true;
    }
  });
});
