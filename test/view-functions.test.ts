import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types/contracts/ConfidentialPool.sol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const EXPECTED_TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32
const ROOT_HISTORY_SIZE = 30;
const TIMELOCK_DELAY_SECONDS = 86_400n; // 1 day
const HARDHAT_CHAIN_ID = 31337n;
const UINT256_MAX = 2n ** 256n - 1n;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

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

  return { pool, owner, alice };
}

// ---------------------------------------------------------------------------
// View Functions — initial state
// ---------------------------------------------------------------------------

describe("View Functions", function () {
  it("levels returns configured tree height", async function () {
    const { pool } = await loadFixture(deployFixture);
    const value = await pool.levels();
    expect(typeof value).to.equal("bigint");
    expect(value).to.equal(BigInt(MERKLE_TREE_HEIGHT));
  });

  it("getLastRoot returns non-zero after deployment", async function () {
    const { pool } = await loadFixture(deployFixture);
    const root = await pool.getLastRoot();
    expect(typeof root).to.equal("bigint");
    expect(root).to.be.greaterThan(0n);
  });

  it("isKnownRoot(getLastRoot()) returns true", async function () {
    const { pool } = await loadFixture(deployFixture);
    const root = await pool.getLastRoot();
    const known = await pool.isKnownRoot(root);
    expect(typeof known).to.equal("boolean");
    expect(known).to.be.true;
  });

  it("isKnownRoot(0) returns false", async function () {
    const { pool } = await loadFixture(deployFixture);
    const known = await pool.isKnownRoot(0n);
    expect(typeof known).to.equal("boolean");
    expect(known).to.be.false;
  });

  it("getActiveNoteCount returns 0 initially", async function () {
    const { pool } = await loadFixture(deployFixture);
    const count = await pool.getActiveNoteCount();
    expect(typeof count).to.equal("bigint");
    expect(count).to.equal(0n);
  });

  it("getPoolStats returns 7 values all initially zero except balance", async function () {
    const { pool } = await loadFixture(deployFixture);
    const [
      totalDeposited,
      totalWithdrawn,
      totalTransfers,
      depositCount,
      withdrawalCount,
      uniqueDepositors,
      poolBalance,
    ] = await pool.getPoolStats();

    expect(totalDeposited).to.equal(0n);
    expect(totalWithdrawn).to.equal(0n);
    expect(totalTransfers).to.equal(0n);
    expect(depositCount).to.equal(0n);
    expect(withdrawalCount).to.equal(0n);
    expect(uniqueDepositors).to.equal(0n);
    expect(poolBalance).to.equal(0n);

    for (const v of [
      totalDeposited,
      totalWithdrawn,
      totalTransfers,
      depositCount,
      withdrawalCount,
      uniqueDepositors,
      poolBalance,
    ]) {
      expect(typeof v).to.equal("bigint");
    }
  });

  it("getPoolHealth returns 7 values", async function () {
    const { pool } = await loadFixture(deployFixture);
    const [
      activeNotes,
      treeUtilization,
      poolBalance,
      isPaused,
      isAllowlisted,
      currentMaxWithdraw,
      currentMinAge,
    ] = await pool.getPoolHealth();

    expect(typeof activeNotes).to.equal("bigint");
    expect(typeof treeUtilization).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
    expect(typeof isPaused).to.equal("boolean");
    expect(typeof isAllowlisted).to.equal("boolean");
    expect(typeof currentMaxWithdraw).to.equal("bigint");
    expect(typeof currentMinAge).to.equal("bigint");

    expect(activeNotes).to.equal(0n);
    expect(treeUtilization).to.equal(0n);
    expect(poolBalance).to.equal(0n);
    expect(isPaused).to.be.false;
    expect(isAllowlisted).to.be.false;
    expect(currentMaxWithdraw).to.equal(0n);
    expect(currentMinAge).to.equal(0n);
  });

  it("getTreeCapacity returns 2^levels", async function () {
    const { pool } = await loadFixture(deployFixture);
    const capacity = await pool.getTreeCapacity();
    expect(typeof capacity).to.equal("bigint");
    expect(capacity).to.equal(EXPECTED_TREE_CAPACITY);
  });

  it("getTreeUtilization returns 0 initially", async function () {
    const { pool } = await loadFixture(deployFixture);
    const utilization = await pool.getTreeUtilization();
    expect(typeof utilization).to.equal("bigint");
    expect(utilization).to.equal(0n);
    expect(utilization).to.be.lessThanOrEqual(100n);
  });

  it("hasCapacity returns true initially", async function () {
    const { pool } = await loadFixture(deployFixture);
    const capacity = await pool.hasCapacity();
    expect(typeof capacity).to.equal("boolean");
    expect(capacity).to.be.true;
  });

  it("getRootHistory returns array of length 30", async function () {
    const { pool } = await loadFixture(deployFixture);
    const history = await pool.getRootHistory();
    expect(Array.isArray(history)).to.be.true;
    expect(history.length).to.equal(ROOT_HISTORY_SIZE);
    for (const root of history) {
      expect(typeof root).to.equal("bigint");
    }
  });

  it("getValidRootCount returns 1 initially (empty tree root)", async function () {
    const { pool } = await loadFixture(deployFixture);
    const count = await pool.getValidRootCount();
    expect(typeof count).to.equal("bigint");
    expect(count).to.equal(1n);
  });

  it("allowlistEnabled returns false initially", async function () {
    const { pool } = await loadFixture(deployFixture);
    const enabled = await pool.allowlistEnabled();
    expect(typeof enabled).to.equal("boolean");
    expect(enabled).to.be.false;
  });

  it("maxWithdrawAmount returns 0 initially (no cap)", async function () {
    const { pool } = await loadFixture(deployFixture);
    const maxAmount = await pool.maxWithdrawAmount();
    expect(typeof maxAmount).to.equal("bigint");
    expect(maxAmount).to.equal(0n);
  });

  it("minDepositAge returns 0 initially (no restriction)", async function () {
    const { pool } = await loadFixture(deployFixture);
    const minAge = await pool.minDepositAge();
    expect(typeof minAge).to.equal("bigint");
    expect(minAge).to.equal(0n);
  });

  it("getWithdrawalRecordCount returns 0 initially", async function () {
    const { pool } = await loadFixture(deployFixture);
    const count = await pool.getWithdrawalRecordCount();
    expect(typeof count).to.equal("bigint");
    expect(count).to.equal(0n);
  });

  it("getDenominations returns empty array initially", async function () {
    const { pool } = await loadFixture(deployFixture);
    const denominations = await pool.getDenominations();
    expect(Array.isArray(denominations)).to.be.true;
    expect(denominations.length).to.equal(0);
  });

  it("getRemainingDeposits returns max uint when limit is 0", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const remaining = await pool.getRemainingDeposits(alice.address);
    expect(typeof remaining).to.equal("bigint");
    expect(remaining).to.equal(UINT256_MAX);
  });

  it("deployedChainId returns 31337", async function () {
    const { pool } = await loadFixture(deployFixture);
    const chainId = await pool.deployedChainId();
    expect(typeof chainId).to.equal("bigint");
    expect(chainId).to.equal(HARDHAT_CHAIN_ID);
  });

  it("TIMELOCK_DELAY returns 86400 (1 day)", async function () {
    const { pool } = await loadFixture(deployFixture);
    const delay = await pool.TIMELOCK_DELAY();
    expect(typeof delay).to.equal("bigint");
    expect(delay).to.equal(TIMELOCK_DELAY_SECONDS);
  });

  it("paused returns false initially", async function () {
    const { pool } = await loadFixture(deployFixture);
    const paused = await pool.paused();
    expect(typeof paused).to.equal("boolean");
    expect(paused).to.be.false;
  });

  it("owner returns deployer", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    const contractOwner = await pool.owner();
    expect(typeof contractOwner).to.equal("string");
    expect(contractOwner).to.equal(owner.address);
  });
});
