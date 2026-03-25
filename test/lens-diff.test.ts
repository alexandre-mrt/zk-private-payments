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

function maxDepositsActionHash(max: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["setMaxDepositsPerAddress", max])
  );
}

// ---------------------------------------------------------------------------
// Snapshot diff utility
// ---------------------------------------------------------------------------

type PoolSnapshotFields = {
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  totalTransfers: bigint;
  depositCount: bigint;
  withdrawalCount: bigint;
  uniqueDepositors: bigint;
  poolBalance: bigint;
  activeNotes: bigint;
  treeCapacity: bigint;
  treeUtilization: bigint;
  lastRoot: bigint;
  isPaused: boolean;
  allowlistEnabled: boolean;
  maxWithdrawAmount: bigint;
  minDepositAge: bigint;
  maxDepositsPerAddress: bigint;
  owner: string;
  version: string;
};

type SnapshotDiff = {
  changed: (keyof PoolSnapshotFields)[];
  unchanged: (keyof PoolSnapshotFields)[];
};

function diffSnapshots(
  before: PoolSnapshotFields,
  after: PoolSnapshotFields
): SnapshotDiff {
  const keys = Object.keys(before) as (keyof PoolSnapshotFields)[];
  const changed: (keyof PoolSnapshotFields)[] = [];
  const unchanged: (keyof PoolSnapshotFields)[] = [];
  for (const key of keys) {
    if (before[key] !== after[key]) {
      changed.push(key);
    } else {
      unchanged.push(key);
    }
  }
  return { changed, unchanged };
}

function toSnapshotFields(raw: Awaited<ReturnType<PoolLens["getSnapshot"]>>): PoolSnapshotFields {
  return {
    totalDeposited: raw.totalDeposited,
    totalWithdrawn: raw.totalWithdrawn,
    totalTransfers: raw.totalTransfers,
    depositCount: raw.depositCount,
    withdrawalCount: raw.withdrawalCount,
    uniqueDepositors: raw.uniqueDepositors,
    poolBalance: raw.poolBalance,
    activeNotes: raw.activeNotes,
    treeCapacity: raw.treeCapacity,
    treeUtilization: raw.treeUtilization,
    lastRoot: raw.lastRoot,
    isPaused: raw.isPaused,
    allowlistEnabled: raw.allowlistEnabled,
    maxWithdrawAmount: raw.maxWithdrawAmount,
    minDepositAge: raw.minDepositAge,
    maxDepositsPerAddress: raw.maxDepositsPerAddress,
    owner: raw.owner,
    version: raw.version,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

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

  return { pool, lens, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Lens Snapshot Diffs", function () {
  // -------------------------------------------------------------------------
  // deposit
  // -------------------------------------------------------------------------

  it("deposit changes exactly: depositCount, poolBalance, totalDeposited, treeUtilization, activeNotes, uniqueDepositors, lastRoot", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const before = toSnapshotFields(await lens.getSnapshot(poolAddress));

    const commitment = randomCommitment();
    const depositAmount = ethers.parseEther("1");
    await pool.connect(alice).deposit(commitment, { value: depositAmount });

    const after = toSnapshotFields(await lens.getSnapshot(poolAddress));

    // Fields that must change
    expect(after.depositCount).to.equal(before.depositCount + 1n, "depositCount");
    expect(after.poolBalance).to.equal(before.poolBalance + depositAmount, "poolBalance");
    expect(after.totalDeposited).to.equal(before.totalDeposited + depositAmount, "totalDeposited");
    expect(after.activeNotes).to.equal(before.activeNotes + 1n, "activeNotes");
    expect(after.uniqueDepositors).to.equal(before.uniqueDepositors + 1n, "uniqueDepositors");
    expect(after.treeUtilization).to.be.gt(before.treeUtilization, "treeUtilization");
    expect(after.lastRoot).to.not.equal(before.lastRoot, "lastRoot");

    // Fields that must NOT change
    const mustNotChange: (keyof PoolSnapshotFields)[] = [
      "totalWithdrawn",
      "totalTransfers",
      "withdrawalCount",
      "treeCapacity",
      "isPaused",
      "allowlistEnabled",
      "maxWithdrawAmount",
      "minDepositAge",
      "maxDepositsPerAddress",
      "owner",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on deposit`);
    }
  });

  // -------------------------------------------------------------------------
  // transfer
  // -------------------------------------------------------------------------

  it("transfer changes exactly: totalTransfers, activeNotes, treeUtilization, lastRoot, depositCount", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    // Setup: deposit a note first
    const inputCommitment = randomCommitment();
    const depositAmount = ethers.parseEther("1");
    await pool.connect(alice).deposit(inputCommitment, { value: depositAmount });

    const rootAfterDeposit = await pool.getLastRoot();
    const nullifier = randomNullifier();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    const before = toSnapshotFields(await lens.getSnapshot(poolAddress));

    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      rootAfterDeposit,
      nullifier,
      out1,
      out2
    );

    const after = toSnapshotFields(await lens.getSnapshot(poolAddress));

    // transfer: inserts 2 output commitments into the Merkle tree (nextIndex +2),
    // spends 1 nullifier (totalTransfers++).
    // depositCount = nextIndex (total tree insertions, not just deposit ops) → +2
    // activeNotes = nextIndex - (withdrawalCount + totalTransfers): +2 - 1 = +1
    expect(after.totalTransfers).to.equal(before.totalTransfers + 1n, "totalTransfers");
    expect(after.depositCount).to.equal(before.depositCount + 2n, "depositCount (nextIndex) +2 from two output commitments");
    expect(after.activeNotes).to.equal(before.activeNotes + 1n, "activeNotes");
    expect(after.treeUtilization).to.be.gt(before.treeUtilization, "treeUtilization");
    expect(after.lastRoot).to.not.equal(before.lastRoot, "lastRoot");

    // Fields that must NOT change
    const mustNotChange: (keyof PoolSnapshotFields)[] = [
      "totalDeposited",
      "totalWithdrawn",
      "withdrawalCount",
      "uniqueDepositors",
      "poolBalance",
      "treeCapacity",
      "isPaused",
      "allowlistEnabled",
      "maxWithdrawAmount",
      "minDepositAge",
      "maxDepositsPerAddress",
      "owner",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on transfer`);
    }
  });

  // -------------------------------------------------------------------------
  // withdraw (no change note — full spend)
  // -------------------------------------------------------------------------

  it("withdraw changes exactly: withdrawalCount, poolBalance, totalWithdrawn, activeNotes", async function () {
    const { pool, lens, alice, bob } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const depositAmount = ethers.parseEther("1");
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: depositAmount });

    const root = await pool.getLastRoot();
    const nullifier = randomNullifier();

    const before = toSnapshotFields(await lens.getSnapshot(poolAddress));

    // Withdraw the full amount with no change note
    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      depositAmount,
      bob.address,
      0n, // no change commitment
      ethers.ZeroAddress,
      0n
    );

    const after = toSnapshotFields(await lens.getSnapshot(poolAddress));

    // Fields that must change
    expect(after.withdrawalCount).to.equal(before.withdrawalCount + 1n, "withdrawalCount");
    expect(after.poolBalance).to.equal(before.poolBalance - depositAmount, "poolBalance");
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn + depositAmount, "totalWithdrawn");
    // No change note: nextIndex unchanged, withdrawalCount +1 → activeNotes -1
    expect(after.activeNotes).to.equal(before.activeNotes - 1n, "activeNotes");

    // Fields that must NOT change
    const mustNotChange: (keyof PoolSnapshotFields)[] = [
      "totalDeposited",
      "totalTransfers",
      "depositCount",
      "uniqueDepositors",
      "treeCapacity",
      "treeUtilization",
      "lastRoot",
      "isPaused",
      "allowlistEnabled",
      "maxWithdrawAmount",
      "minDepositAge",
      "maxDepositsPerAddress",
      "owner",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on withdraw`);
    }
  });

  // -------------------------------------------------------------------------
  // pause
  // -------------------------------------------------------------------------

  it("pause changes exactly: isPaused", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const before = toSnapshotFields(await lens.getSnapshot(poolAddress));
    expect(before.isPaused).to.equal(false, "should not be paused initially");

    await pool.connect(owner).pause();

    const after = toSnapshotFields(await lens.getSnapshot(poolAddress));
    const diff = diffSnapshots(before, after);

    expect(after.isPaused).to.equal(true, "isPaused should be true after pause");
    expect(diff.changed).to.deep.equal(["isPaused"], "only isPaused should change on pause");

    const mustNotChange: (keyof PoolSnapshotFields)[] = [
      "totalDeposited",
      "totalWithdrawn",
      "totalTransfers",
      "depositCount",
      "withdrawalCount",
      "uniqueDepositors",
      "poolBalance",
      "activeNotes",
      "treeCapacity",
      "treeUtilization",
      "lastRoot",
      "allowlistEnabled",
      "maxWithdrawAmount",
      "minDepositAge",
      "maxDepositsPerAddress",
      "owner",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on pause`);
    }
  });

  // -------------------------------------------------------------------------
  // setMaxDepositsPerAddress (via timelock)
  // -------------------------------------------------------------------------

  it("setMaxDepositsPerAddress changes exactly: maxDepositsPerAddress", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const newMax = 5n;
    const actionHash = maxDepositsActionHash(newMax);
    await pool.connect(owner).queueAction(actionHash);
    await time.increase(ONE_DAY + 1);

    const before = toSnapshotFields(await lens.getSnapshot(poolAddress));
    expect(before.maxDepositsPerAddress).to.equal(0n, "should be 0 initially");

    await pool.connect(owner).setMaxDepositsPerAddress(newMax);

    const after = toSnapshotFields(await lens.getSnapshot(poolAddress));
    const diff = diffSnapshots(before, after);

    expect(after.maxDepositsPerAddress).to.equal(newMax, "maxDepositsPerAddress");
    expect(diff.changed).to.deep.equal(
      ["maxDepositsPerAddress"],
      "only maxDepositsPerAddress should change"
    );
  });

  // -------------------------------------------------------------------------
  // batchDeposit
  // -------------------------------------------------------------------------

  it("batchDeposit changes exactly: depositCount, poolBalance, totalDeposited, treeUtilization, activeNotes, uniqueDepositors, lastRoot", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const before = toSnapshotFields(await lens.getSnapshot(poolAddress));

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("0.5"),
    ];
    const totalAmount = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: totalAmount });

    const after = toSnapshotFields(await lens.getSnapshot(poolAddress));

    const batchSize = BigInt(commitments.length);
    expect(after.depositCount).to.equal(before.depositCount + batchSize, "depositCount");
    expect(after.poolBalance).to.equal(before.poolBalance + totalAmount, "poolBalance");
    expect(after.totalDeposited).to.equal(before.totalDeposited + totalAmount, "totalDeposited");
    expect(after.activeNotes).to.equal(before.activeNotes + batchSize, "activeNotes");
    // Alice is a new depositor
    expect(after.uniqueDepositors).to.equal(before.uniqueDepositors + 1n, "uniqueDepositors");
    expect(after.treeUtilization).to.be.gt(before.treeUtilization, "treeUtilization");
    expect(after.lastRoot).to.not.equal(before.lastRoot, "lastRoot");

    // Fields that must NOT change
    const mustNotChange: (keyof PoolSnapshotFields)[] = [
      "totalWithdrawn",
      "totalTransfers",
      "withdrawalCount",
      "treeCapacity",
      "isPaused",
      "allowlistEnabled",
      "maxWithdrawAmount",
      "minDepositAge",
      "maxDepositsPerAddress",
      "owner",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on batchDeposit`);
    }
  });

  // -------------------------------------------------------------------------
  // allowlist toggle
  // -------------------------------------------------------------------------

  it("setAllowlistEnabled changes exactly: allowlistEnabled", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();

    const before = toSnapshotFields(await lens.getSnapshot(poolAddress));
    expect(before.allowlistEnabled).to.equal(false, "allowlist should be disabled initially");

    await pool.connect(owner).setAllowlistEnabled(true);

    const after = toSnapshotFields(await lens.getSnapshot(poolAddress));
    const diff = diffSnapshots(before, after);

    expect(after.allowlistEnabled).to.equal(true, "allowlistEnabled should be true after toggle");
    expect(diff.changed).to.deep.equal(
      ["allowlistEnabled"],
      "only allowlistEnabled should change on setAllowlistEnabled"
    );

    const mustNotChange: (keyof PoolSnapshotFields)[] = [
      "totalDeposited",
      "totalWithdrawn",
      "totalTransfers",
      "depositCount",
      "withdrawalCount",
      "uniqueDepositors",
      "poolBalance",
      "activeNotes",
      "treeCapacity",
      "treeUtilization",
      "lastRoot",
      "isPaused",
      "maxWithdrawAmount",
      "minDepositAge",
      "maxDepositsPerAddress",
      "owner",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on allowlist toggle`);
    }
  });
});
