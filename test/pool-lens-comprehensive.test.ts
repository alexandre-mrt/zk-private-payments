import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, PoolLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const TREE_CAPACITY = BigInt(2 ** TREE_HEIGHT); // 32
const ONE_DAY = 24 * 60 * 60;

// Both verifiers in the test suite always return true for any input.
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
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

function randomNullifier(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31)) + 1n;
}

function maxWithdrawActionHash(amount: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["setMaxWithdrawAmount", amount])
  );
}

function minDepositAgeActionHash(age: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["setMinDepositAge", age])
  );
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, recipient] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = (await Lens.deploy()) as unknown as PoolLens;

  return { pool, lens, owner, alice, bob, recipient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PoolLens Comprehensive", function () {
  // -------------------------------------------------------------------------
  // Empty pool
  // -------------------------------------------------------------------------

  it("snapshot with empty pool has all zero stats", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);
    const snapshot = await lens.getSnapshot(await pool.getAddress());

    expect(snapshot.totalDeposited).to.equal(0n);
    expect(snapshot.totalWithdrawn).to.equal(0n);
    expect(snapshot.totalTransfers).to.equal(0n);
    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.withdrawalCount).to.equal(0n);
    expect(snapshot.uniqueDepositors).to.equal(0n);
    expect(snapshot.poolBalance).to.equal(0n);
    expect(snapshot.activeNotes).to.equal(0n);
    expect(snapshot.treeCapacity).to.equal(TREE_CAPACITY);
    expect(snapshot.treeUtilization).to.equal(0n);
    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.allowlistEnabled).to.equal(false);
    expect(snapshot.maxWithdrawAmount).to.equal(0n);
    expect(snapshot.minDepositAge).to.equal(0n);
    expect(snapshot.maxDepositsPerAddress).to.equal(0n);
    expect(snapshot.owner).to.equal(owner.address);
    // lastRoot is the initial empty-tree root — must be non-zero
    expect(snapshot.lastRoot).to.not.equal(0n);
  });

  // -------------------------------------------------------------------------
  // After deposit
  // -------------------------------------------------------------------------

  it("snapshot after deposit shows correct totalDeposited", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const depositAmount = ethers.parseEther("1");

    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });

    const snapshot = await lens.getSnapshot(poolAddress);

    // Compare aggregated lens fields against individual contract calls
    const [td, tw, tt, dc, wc, ud, pb] = await pool.getPoolStats();
    expect(snapshot.totalDeposited).to.equal(td);
    expect(snapshot.totalWithdrawn).to.equal(tw);
    expect(snapshot.totalTransfers).to.equal(tt);
    expect(snapshot.depositCount).to.equal(dc);
    expect(snapshot.withdrawalCount).to.equal(wc);
    expect(snapshot.uniqueDepositors).to.equal(ud);
    expect(snapshot.poolBalance).to.equal(pb);

    expect(snapshot.totalDeposited).to.equal(depositAmount);
    expect(snapshot.depositCount).to.equal(1n);
    expect(snapshot.poolBalance).to.equal(depositAmount);
    expect(snapshot.activeNotes).to.equal(1n);
    expect(snapshot.uniqueDepositors).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // After transfer
  // -------------------------------------------------------------------------

  it("snapshot after transfer shows correct totalTransfers", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const depositAmount = ethers.parseEther("1");

    // Insert a commitment to transfer
    const inputCommitment = randomCommitment();
    await pool.connect(alice).deposit(inputCommitment, { value: depositAmount });

    const root = await pool.getLastRoot();
    const nullifier = randomNullifier();
    const outCommitment1 = randomCommitment();
    const outCommitment2 = randomCommitment();

    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      outCommitment1,
      outCommitment2
    );

    const snapshot = await lens.getSnapshot(poolAddress);

    expect(snapshot.totalTransfers).to.equal(1n);
    expect(snapshot.totalTransfers).to.equal(await pool.totalTransfers());
    // A transfer spends 1 nullifier and inserts 2 output notes (net +1 active notes)
    // deposit added 1, transfer added 2 and spent 1 → activeNotes = 1 + 2 - 1 = 2
    expect(snapshot.activeNotes).to.equal(2n);
    expect(snapshot.activeNotes).to.equal(await pool.getActiveNoteCount());
    // Pool balance unchanged by a transfer
    expect(snapshot.poolBalance).to.equal(depositAmount);
    expect(snapshot.totalWithdrawn).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // After withdrawal
  // -------------------------------------------------------------------------

  it("snapshot after withdrawal shows correct totalWithdrawn", async function () {
    const { pool, lens, alice, recipient } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const depositAmount = ethers.parseEther("1");
    const withdrawAmount = ethers.parseEther("0.5");

    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });

    const root = await pool.getLastRoot();
    const nullifier = randomNullifier();

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      withdrawAmount,
      recipient.address as `0x${string}`,
      0n, // no change note
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    const snapshot = await lens.getSnapshot(poolAddress);

    expect(snapshot.totalWithdrawn).to.equal(withdrawAmount);
    expect(snapshot.withdrawalCount).to.equal(1n);
    expect(snapshot.poolBalance).to.equal(depositAmount - withdrawAmount);

    // Cross-check against direct contract calls
    const [td, tw, tt, dc, wc, ud, pb] = await pool.getPoolStats();
    expect(snapshot.totalWithdrawn).to.equal(tw);
    expect(snapshot.withdrawalCount).to.equal(wc);
    expect(snapshot.poolBalance).to.equal(pb);
  });

  // -------------------------------------------------------------------------
  // Unique depositors count
  // -------------------------------------------------------------------------

  it("snapshot reflects uniqueDepositors count", async function () {
    const { pool, lens, alice, bob } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const depositAmount = ethers.parseEther("0.1");

    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
    const snap1 = await lens.getSnapshot(poolAddress);
    expect(snap1.uniqueDepositors).to.equal(1n);

    // Same depositor again — should NOT increment uniqueDepositors
    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
    const snap2 = await lens.getSnapshot(poolAddress);
    expect(snap2.uniqueDepositors).to.equal(1n);

    // New depositor — should increment
    await pool.connect(bob).deposit(randomCommitment(), { value: depositAmount });
    const snap3 = await lens.getSnapshot(poolAddress);
    expect(snap3.uniqueDepositors).to.equal(2n);
    expect(snap3.uniqueDepositors).to.equal(await pool.uniqueDepositorCount());
  });

  // -------------------------------------------------------------------------
  // Allowlist state
  // -------------------------------------------------------------------------

  it("snapshot reflects allowlistEnabled state", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const before = await lens.getSnapshot(poolAddress);
    expect(before.allowlistEnabled).to.equal(false);

    await pool.connect(owner).setAllowlistEnabled(true);
    const after = await lens.getSnapshot(poolAddress);
    expect(after.allowlistEnabled).to.equal(true);
    expect(after.allowlistEnabled).to.equal(await pool.allowlistEnabled());

    await pool.connect(owner).setAllowlistEnabled(false);
    const restored = await lens.getSnapshot(poolAddress);
    expect(restored.allowlistEnabled).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // maxWithdrawAmount after timelock
  // -------------------------------------------------------------------------

  it("snapshot reflects maxWithdrawAmount after timelock", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const newMax = ethers.parseEther("2");
    const actionHash = maxWithdrawActionHash(newMax);
    await pool.connect(owner).queueAction(actionHash);
    await time.increase(ONE_DAY + 1);
    await pool.connect(owner).setMaxWithdrawAmount(newMax);

    const snapshot = await lens.getSnapshot(poolAddress);

    expect(snapshot.maxWithdrawAmount).to.equal(newMax);
    expect(snapshot.maxWithdrawAmount).to.equal(await pool.maxWithdrawAmount());
  });

  // -------------------------------------------------------------------------
  // minDepositAge after timelock
  // -------------------------------------------------------------------------

  it("snapshot reflects minDepositAge after timelock", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const newAge = 10n;
    const actionHash = minDepositAgeActionHash(newAge);
    await pool.connect(owner).queueAction(actionHash);
    await time.increase(ONE_DAY + 1);
    await pool.connect(owner).setMinDepositAge(newAge);

    const snapshot = await lens.getSnapshot(poolAddress);

    expect(snapshot.minDepositAge).to.equal(newAge);
    expect(snapshot.minDepositAge).to.equal(await pool.minDepositAge());
  });

  // -------------------------------------------------------------------------
  // Version field
  // -------------------------------------------------------------------------

  it("snapshot version field is '1.0.0'", async function () {
    const { pool, lens } = await loadFixture(deployFixture);
    const snapshot = await lens.getSnapshot(await pool.getAddress());

    expect(snapshot.version).to.equal("1.0.0");
    expect(snapshot.version).to.equal(await pool.getVersion());
  });

  // -------------------------------------------------------------------------
  // activeNotes tracking through operations
  // -------------------------------------------------------------------------

  it("snapshot activeNotes tracks correctly through operations", async function () {
    const { pool, lens, alice, recipient } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const depositAmount = ethers.parseEther("1");

    // Start: 0 active notes
    expect((await lens.getSnapshot(poolAddress)).activeNotes).to.equal(0n);

    // Deposit → 1 note inserted, 0 spent → 1 active
    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
    expect((await lens.getSnapshot(poolAddress)).activeNotes).to.equal(1n);

    // Transfer → 1 note spent, 2 inserted → net +1 → 2 active
    const root1 = await pool.getLastRoot();
    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root1,
      randomNullifier(),
      randomCommitment(),
      randomCommitment()
    );
    expect((await lens.getSnapshot(poolAddress)).activeNotes).to.equal(2n);

    // Withdraw (no change) → 1 note spent → 1 active
    const root2 = await pool.getLastRoot();
    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root2,
      randomNullifier(),
      ethers.parseEther("0.1"),
      recipient.address as `0x${string}`,
      0n,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );
    expect((await lens.getSnapshot(poolAddress)).activeNotes).to.equal(1n);
    expect((await lens.getSnapshot(poolAddress)).activeNotes).to.equal(await pool.getActiveNoteCount());
  });

  // -------------------------------------------------------------------------
  // Tree utilization
  // -------------------------------------------------------------------------

  it("snapshot treeUtilization increases with insertions", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const snap0 = await lens.getSnapshot(poolAddress);
    expect(snap0.treeUtilization).to.equal(0n);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("0.5") });
    const snap1 = await lens.getSnapshot(poolAddress);
    expect(snap1.treeUtilization).to.be.gt(0n);
    expect(snap1.treeUtilization).to.equal((1n * 100n) / TREE_CAPACITY);
    expect(snap1.treeUtilization).to.equal(await pool.getTreeUtilization());

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("0.5") });
    const snap2 = await lens.getSnapshot(poolAddress);
    expect(snap2.treeUtilization).to.be.gt(snap1.treeUtilization);
    expect(snap2.treeUtilization).to.equal((2n * 100n) / TREE_CAPACITY);
  });

  // -------------------------------------------------------------------------
  // Multiple snapshots from same lens are independent
  // -------------------------------------------------------------------------

  it("multiple snapshots from same lens are independent", async function () {
    const [, alice] = await ethers.getSigners();

    const hasherAddress = await deployHasher();
    const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
    const transferVerifier = await TransferVerifier.deploy();
    const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
    const withdrawVerifier = await WithdrawVerifier.deploy();
    const Pool = await ethers.getContractFactory("ConfidentialPool");

    const pool1 = (await Pool.deploy(
      await transferVerifier.getAddress(),
      await withdrawVerifier.getAddress(),
      TREE_HEIGHT,
      hasherAddress
    )) as unknown as ConfidentialPool;

    const pool2 = (await Pool.deploy(
      await transferVerifier.getAddress(),
      await withdrawVerifier.getAddress(),
      TREE_HEIGHT,
      hasherAddress
    )) as unknown as ConfidentialPool;

    const Lens = await ethers.getContractFactory("PoolLens");
    const lens = (await Lens.deploy()) as unknown as PoolLens;

    const deposit1 = ethers.parseEther("1");
    const deposit2 = ethers.parseEther("2");

    await pool1.connect(alice).deposit(randomCommitment(), { value: deposit1 });
    await pool2.connect(alice).deposit(randomCommitment(), { value: deposit2 });
    await pool2.connect(alice).deposit(randomCommitment(), { value: deposit2 });

    const snap1 = await lens.getSnapshot(await pool1.getAddress());
    const snap2 = await lens.getSnapshot(await pool2.getAddress());

    // Each snapshot must reflect its own pool state — same lens, different pools
    expect(snap1.depositCount).to.equal(1n);
    expect(snap2.depositCount).to.equal(2n);
    expect(snap1.totalDeposited).to.equal(deposit1);
    expect(snap2.totalDeposited).to.equal(deposit2 * 2n);
    expect(snap1.totalDeposited).to.not.equal(snap2.totalDeposited);
  });
});
