import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types/ConfidentialPool.sol";
import type { StealthRegistry } from "../typechain-types";
import type { PoolLens } from "../typechain-types/contracts/PoolLens";

const MERKLE_TREE_HEIGHT = 5;

// Gas ceiling for view calls
const VIEW_GAS_LIMIT = 300_000n;

async function deployFixture() {
  const [owner, alice] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  const Registry = await ethers.getContractFactory("StealthRegistry");
  const registry = (await Registry.deploy()) as unknown as StealthRegistry;

  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = (await Lens.deploy()) as unknown as PoolLens;

  return { pool, registry, lens, owner, alice };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertReasonableGas(
  contract: { getAddress(): Promise<string>; interface: { encodeFunctionData(fn: string, args?: unknown[]): string } },
  fn: string,
  args: unknown[] = []
): Promise<void> {
  const to = await contract.getAddress();
  const data = contract.interface.encodeFunctionData(fn, args);
  const gas = await ethers.provider.estimateGas({ to, data });
  expect(gas).to.be.lessThanOrEqual(
    VIEW_GAS_LIMIT,
    `${fn} used ${gas} gas — exceeds VIEW_GAS_LIMIT of ${VIEW_GAS_LIMIT}`
  );
}

// ---------------------------------------------------------------------------
// ConfidentialPool view functions
// ---------------------------------------------------------------------------

describe("View Function Accessibility — ConfidentialPool", function () {
  // -------------------------------------------------------------------------
  // getPoolStats()
  // -------------------------------------------------------------------------

  it("getPoolStats callable by alice returns correct types", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const [
      totalDeposited,
      totalWithdrawn,
      totalTransfers,
      depositCount,
      withdrawalCount,
      uniqueDepositors,
      poolBalance,
    ] = await pool.connect(alice).getPoolStats();

    expect(typeof totalDeposited).to.equal("bigint");
    expect(typeof totalWithdrawn).to.equal("bigint");
    expect(typeof totalTransfers).to.equal("bigint");
    expect(typeof depositCount).to.equal("bigint");
    expect(typeof withdrawalCount).to.equal("bigint");
    expect(typeof uniqueDepositors).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");

    // Fresh deployment — all counters at zero
    expect(totalDeposited).to.equal(0n);
    expect(withdrawalCount).to.equal(0n);

    await assertReasonableGas(pool, "getPoolStats");
  });

  // -------------------------------------------------------------------------
  // getActiveNoteCount()
  // -------------------------------------------------------------------------

  it("getActiveNoteCount callable by alice returns a bigint", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getActiveNoteCount();
    expect(typeof result).to.equal("bigint");
    expect(result).to.equal(0n);
    await assertReasonableGas(pool, "getActiveNoteCount");
  });

  // -------------------------------------------------------------------------
  // getPoolHealth()
  // -------------------------------------------------------------------------

  it("getPoolHealth callable by alice returns correct types", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const [
      activeNotes,
      treeUtilization,
      poolBalance,
      isPaused,
      isAllowlisted,
      currentMaxWithdraw,
      currentMinAge,
    ] = await pool.connect(alice).getPoolHealth();

    expect(typeof activeNotes).to.equal("bigint");
    expect(typeof treeUtilization).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
    expect(typeof isPaused).to.equal("boolean");
    expect(typeof isAllowlisted).to.equal("boolean");
    expect(typeof currentMaxWithdraw).to.equal("bigint");
    expect(typeof currentMinAge).to.equal("bigint");

    expect(isPaused).to.equal(false);
    expect(isAllowlisted).to.equal(false);

    await assertReasonableGas(pool, "getPoolHealth");
  });

  // -------------------------------------------------------------------------
  // getWithdrawalRecordCount()
  // -------------------------------------------------------------------------

  it("getWithdrawalRecordCount callable by alice returns a bigint", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getWithdrawalRecordCount();
    expect(typeof result).to.equal("bigint");
    expect(result).to.equal(0n);
    await assertReasonableGas(pool, "getWithdrawalRecordCount");
  });

  // -------------------------------------------------------------------------
  // getDenominations()
  // -------------------------------------------------------------------------

  it("getDenominations callable by alice returns an array", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getDenominations();
    expect(Array.isArray(result)).to.equal(true);
    // No denominations added at deploy — empty list
    expect(result.length).to.equal(0);
    await assertReasonableGas(pool, "getDenominations");
  });

  // -------------------------------------------------------------------------
  // allowlistEnabled
  // -------------------------------------------------------------------------

  it("allowlistEnabled callable by alice returns a boolean", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).allowlistEnabled();
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
    await assertReasonableGas(pool, "allowlistEnabled");
  });

  // -------------------------------------------------------------------------
  // maxWithdrawAmount
  // -------------------------------------------------------------------------

  it("maxWithdrawAmount callable by alice returns a bigint", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).maxWithdrawAmount();
    expect(typeof result).to.equal("bigint");
    // Default: 0 means no limit
    expect(result).to.equal(0n);
    await assertReasonableGas(pool, "maxWithdrawAmount");
  });

  // -------------------------------------------------------------------------
  // minDepositAge
  // -------------------------------------------------------------------------

  it("minDepositAge callable by alice returns a bigint", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).minDepositAge();
    expect(typeof result).to.equal("bigint");
    // Default: 0 means no restriction
    expect(result).to.equal(0n);
    await assertReasonableGas(pool, "minDepositAge");
  });

  // -------------------------------------------------------------------------
  // MerkleTree views inherited by ConfidentialPool
  // -------------------------------------------------------------------------

  it("getLastRoot callable by alice returns a non-zero bigint", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getLastRoot();
    expect(typeof result).to.equal("bigint");
    expect(result).to.be.greaterThan(0n);
    await assertReasonableGas(pool, "getLastRoot");
  });

  it("isKnownRoot callable by alice returns true for the current root", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const root = await pool.getLastRoot();
    const result = await pool.connect(alice).isKnownRoot(root);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(true);
    await assertReasonableGas(pool, "isKnownRoot", [root]);
  });

  it("getTreeCapacity callable by alice returns 2^levels", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getTreeCapacity();
    expect(typeof result).to.equal("bigint");
    expect(result).to.equal(2n ** BigInt(MERKLE_TREE_HEIGHT));
    await assertReasonableGas(pool, "getTreeCapacity");
  });

  it("getTreeUtilization callable by alice returns a bigint", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getTreeUtilization();
    expect(typeof result).to.equal("bigint");
    expect(result).to.equal(0n);
    await assertReasonableGas(pool, "getTreeUtilization");
  });

  it("hasCapacity callable by alice returns true on fresh deployment", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).hasCapacity();
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(true);
    await assertReasonableGas(pool, "hasCapacity");
  });

  it("getRootHistory callable by alice returns an array of ROOT_HISTORY_SIZE elements", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getRootHistory();
    expect(Array.isArray(result)).to.equal(true);
    expect(result.length).to.equal(30);
    for (const entry of result) {
      expect(typeof entry).to.equal("bigint");
    }
    await assertReasonableGas(pool, "getRootHistory");
  });

  it("getValidRootCount callable by alice returns at least 1", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getValidRootCount();
    expect(typeof result).to.equal("bigint");
    expect(result).to.be.greaterThanOrEqual(1n);
    await assertReasonableGas(pool, "getValidRootCount");
  });

  it("getCommitments callable by alice returns an empty array on fresh deployment", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).getCommitments(0, 10);
    expect(Array.isArray(result)).to.equal(true);
    expect(result.length).to.equal(0);
    await assertReasonableGas(pool, "getCommitments", [0, 10]);
  });

  it("isSpent callable by alice returns false for arbitrary nullifier", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).isSpent(42n);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
    await assertReasonableGas(pool, "isSpent", [42n]);
  });

  it("isCommitted callable by alice returns false for arbitrary commitment", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const result = await pool.connect(alice).isCommitted(7n);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
    await assertReasonableGas(pool, "isCommitted", [7n]);
  });
});

// ---------------------------------------------------------------------------
// StealthRegistry view functions
// ---------------------------------------------------------------------------

describe("View Function Accessibility — StealthRegistry", function () {
  it("getViewingKey callable by alice returns (0, 0) for unregistered address", async function () {
    const { registry, alice, owner } = await loadFixture(deployFixture);
    // Query owner's key — owner has not registered, so result should be (0, 0)
    const [pubKeyX, pubKeyY] = await registry.connect(alice).getViewingKey(owner.address);
    expect(typeof pubKeyX).to.equal("bigint");
    expect(typeof pubKeyY).to.equal("bigint");
    expect(pubKeyX).to.equal(0n);
    expect(pubKeyY).to.equal(0n);
    await assertReasonableGas(registry, "getViewingKey", [owner.address]);
  });

  it("getViewingKey callable by alice returns registered key for any address", async function () {
    const { registry, alice, owner } = await loadFixture(deployFixture);
    const expectedX = 12345678901234567890n;
    const expectedY = 98765432109876543210n;
    // owner registers a key
    await registry.connect(owner).registerViewingKey(expectedX, expectedY);
    // alice can read it without restriction
    const [pubKeyX, pubKeyY] = await registry.connect(alice).getViewingKey(owner.address);
    expect(pubKeyX).to.equal(expectedX);
    expect(pubKeyY).to.equal(expectedY);
  });
});

// ---------------------------------------------------------------------------
// PoolLens view functions
// ---------------------------------------------------------------------------

describe("View Function Accessibility — PoolLens", function () {
  it("PoolLens.getSnapshot callable by alice returns a full snapshot", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);
    const poolAddress = await pool.getAddress();
    const snapshot = await lens.connect(alice).getSnapshot(poolAddress);

    expect(typeof snapshot.totalDeposited).to.equal("bigint");
    expect(typeof snapshot.totalWithdrawn).to.equal("bigint");
    expect(typeof snapshot.totalTransfers).to.equal("bigint");
    expect(typeof snapshot.depositCount).to.equal("bigint");
    expect(typeof snapshot.withdrawalCount).to.equal("bigint");
    expect(typeof snapshot.uniqueDepositors).to.equal("bigint");
    expect(typeof snapshot.poolBalance).to.equal("bigint");
    expect(typeof snapshot.activeNotes).to.equal("bigint");
    expect(typeof snapshot.treeCapacity).to.equal("bigint");
    expect(typeof snapshot.treeUtilization).to.equal("bigint");
    expect(typeof snapshot.lastRoot).to.equal("bigint");
    expect(typeof snapshot.isPaused).to.equal("boolean");
    expect(typeof snapshot.allowlistEnabled).to.equal("boolean");
    expect(typeof snapshot.maxWithdrawAmount).to.equal("bigint");
    expect(typeof snapshot.minDepositAge).to.equal("bigint");
    expect(typeof snapshot.maxDepositsPerAddress).to.equal("bigint");
    expect(typeof snapshot.owner).to.equal("string");
    expect(typeof snapshot.version).to.equal("string");

    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.allowlistEnabled).to.equal(false);
    expect(snapshot.version).to.equal("1.0.0");
  });
});
