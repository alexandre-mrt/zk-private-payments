import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types/contracts/ConfidentialPool.sol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const TIMELOCK_DELAY_SECONDS = 86_400n; // 1 day
const ROOT_HISTORY_SIZE = 30n;
const HARDHAT_CHAIN_ID = 31337n;

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
  const [owner, alice] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();
  const transferVerifierAddress = await transferVerifier.getAddress();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();
  const withdrawVerifierAddress = await withdrawVerifier.getAddress();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    transferVerifierAddress,
    withdrawVerifierAddress,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  return {
    pool,
    transferVerifierAddress,
    withdrawVerifierAddress,
    hasherAddress,
    owner,
    alice,
  };
}

// ---------------------------------------------------------------------------
// Immutability and Determinism
// ---------------------------------------------------------------------------

describe("Immutability and Determinism", function () {
  // -------------------------------------------------------------------------
  // Immutable storage slots survive state changes
  // -------------------------------------------------------------------------

  it("transferVerifier unchanged after deposits", async function () {
    const { pool, alice, transferVerifierAddress } = await loadFixture(deployFixture);

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    expect(await pool.transferVerifier()).to.equal(transferVerifierAddress);
  });

  it("withdrawVerifier unchanged after deposits", async function () {
    const { pool, alice, withdrawVerifierAddress } = await loadFixture(deployFixture);

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    expect(await pool.withdrawVerifier()).to.equal(withdrawVerifierAddress);
  });

  it("levels unchanged after tree mutations", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const levelsBefore = await pool.levels();

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    expect(await pool.levels()).to.equal(levelsBefore);
    expect(await pool.levels()).to.equal(BigInt(MERKLE_TREE_HEIGHT));
  });

  it("hasher address unchanged after deposits", async function () {
    const { pool, alice, hasherAddress } = await loadFixture(deployFixture);

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    expect(await pool.hasher()).to.equal(hasherAddress);
  });

  it("deployedChainId unchanged after deposits", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const chainIdBefore = await pool.deployedChainId();

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    expect(await pool.deployedChainId()).to.equal(chainIdBefore);
    expect(await pool.deployedChainId()).to.equal(HARDHAT_CHAIN_ID);
  });

  it("VERSION constant unchanged after deposits", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const versionBefore = await pool.VERSION();

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    expect(await pool.VERSION()).to.equal(versionBefore);
    expect(await pool.VERSION()).to.equal("1.0.0");
  });

  it("TIMELOCK_DELAY is constant and unchanged after state changes", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const delayBefore = await pool.TIMELOCK_DELAY();

    for (let i = 0; i < 3; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    expect(await pool.TIMELOCK_DELAY()).to.equal(delayBefore);
    expect(await pool.TIMELOCK_DELAY()).to.equal(TIMELOCK_DELAY_SECONDS);
  });

  it("ROOT_HISTORY_SIZE is constant and unchanged after tree mutations", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const sizeBefore = await pool.ROOT_HISTORY_SIZE();

    for (let i = 0; i < 5; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    expect(await pool.ROOT_HISTORY_SIZE()).to.equal(sizeBefore);
    expect(await pool.ROOT_HISTORY_SIZE()).to.equal(ROOT_HISTORY_SIZE);
  });

  // -------------------------------------------------------------------------
  // View function determinism — same input, same output, no state change
  // -------------------------------------------------------------------------

  it("getLastRoot returns same value on consecutive calls without state change", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DENOMINATION });

    const root1 = await pool.getLastRoot();
    const root2 = await pool.getLastRoot();
    const root3 = await pool.getLastRoot();

    expect(root1).to.equal(root2);
    expect(root2).to.equal(root3);
    expect(root1).to.be.greaterThan(0n);
  });

  it("getPoolStats returns same values on consecutive calls without state change", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    const stats1 = await pool.getPoolStats();
    const stats2 = await pool.getPoolStats();

    expect(stats1[0]).to.equal(stats2[0]); // totalDeposited
    expect(stats1[1]).to.equal(stats2[1]); // totalWithdrawn
    expect(stats1[2]).to.equal(stats2[2]); // totalTransfers
    expect(stats1[3]).to.equal(stats2[3]); // depositCount
    expect(stats1[4]).to.equal(stats2[4]); // withdrawalCount
    expect(stats1[5]).to.equal(stats2[5]); // uniqueDepositors
    expect(stats1[6]).to.equal(stats2[6]); // poolBalance
  });

  it("getPoolHealth returns same values on consecutive calls without state change", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    const health1 = await pool.getPoolHealth();
    const health2 = await pool.getPoolHealth();

    expect(health1[0]).to.equal(health2[0]); // activeNotes
    expect(health1[1]).to.equal(health2[1]); // treeUtilization
    expect(health1[2]).to.equal(health2[2]); // poolBalance
    expect(health1[3]).to.equal(health2[3]); // isPaused
    expect(health1[4]).to.equal(health2[4]); // isAllowlisted
    expect(health1[5]).to.equal(health2[5]); // currentMaxWithdraw
    expect(health1[6]).to.equal(health2[6]); // currentMinAge
  });

  it("isKnownRoot is deterministic for the same root", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DENOMINATION });

    const root = await pool.getLastRoot();

    const result1 = await pool.isKnownRoot(root);
    const result2 = await pool.isKnownRoot(root);
    const result3 = await pool.isKnownRoot(root);

    expect(result1).to.equal(result2);
    expect(result2).to.equal(result3);
    expect(result1).to.be.true;

    // Unknown root is also deterministically false
    const unknownRoot = randomCommitment();
    const unknown1 = await pool.isKnownRoot(unknownRoot);
    const unknown2 = await pool.isKnownRoot(unknownRoot);
    expect(unknown1).to.equal(unknown2);
    expect(unknown1).to.be.false;
  });

  it("hashLeftRight(a, b) is deterministic across multiple calls", async function () {
    const { pool } = await loadFixture(deployFixture);

    const left = 1n;
    const right = 2n;

    const hash1 = await pool.hashLeftRight(left, right);
    const hash2 = await pool.hashLeftRight(left, right);
    const hash3 = await pool.hashLeftRight(left, right);

    expect(hash1).to.equal(hash2);
    expect(hash2).to.equal(hash3);
    expect(hash1).to.be.greaterThan(0n);

    // Different inputs produce different outputs
    const hashDiff = await pool.hashLeftRight(right, left);
    expect(hash1).to.not.equal(hashDiff);
  });

  it("getActiveNoteCount is deterministic on consecutive calls without state change", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    for (let i = 0; i < 4; i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    }

    const count1 = await pool.getActiveNoteCount();
    const count2 = await pool.getActiveNoteCount();
    const count3 = await pool.getActiveNoteCount();

    expect(count1).to.equal(count2);
    expect(count2).to.equal(count3);
    expect(count1).to.equal(4n);
  });

  it("getWithdrawalRecordCount is deterministic on consecutive calls without state change", async function () {
    const { pool } = await loadFixture(deployFixture);

    const count1 = await pool.getWithdrawalRecordCount();
    const count2 = await pool.getWithdrawalRecordCount();
    const count3 = await pool.getWithdrawalRecordCount();

    expect(count1).to.equal(count2);
    expect(count2).to.equal(count3);
    expect(count1).to.equal(0n);
  });
});
