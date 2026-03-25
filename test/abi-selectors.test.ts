import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type {
  ConfidentialPool,
  PoolLens,
  StealthRegistry,
  DepositReceipt,
} from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DEPOSIT_AMOUNT = ethers.parseEther("1");

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// Returns true if the error indicates the function selector was not found in
// the ABI (i.e. the call never reached the contract).
function isFunctionNotFound(err: unknown): boolean {
  const msg = (err as Error).message ?? "";
  return (
    msg.includes("function not found") ||
    msg.includes("no matching function") ||
    msg.includes("call revert exception") ||
    msg.includes("CALL_EXCEPTION")
  );
}

async function deployFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const PoolFactory = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await PoolFactory.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  const PoolLensFactory = await ethers.getContractFactory("PoolLens");
  const poolLens = (await PoolLensFactory.deploy()) as unknown as PoolLens;

  const StealthRegistryFactory = await ethers.getContractFactory("StealthRegistry");
  const stealthRegistry = (await StealthRegistryFactory.deploy()) as unknown as StealthRegistry;

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const depositReceipt = (await DepositReceiptFactory.deploy(
    await pool.getAddress()
  )) as unknown as DepositReceipt;

  return { pool, poolLens, stealthRegistry, depositReceipt, owner, alice, bob, relayer };
}

// ---------------------------------------------------------------------------
// ABI Function Selectors
// ---------------------------------------------------------------------------

describe("ABI Function Selectors", function () {
  // -------------------------------------------------------------------------
  // ConfidentialPool — mutating functions
  // -------------------------------------------------------------------------

  it("deposit(uint256) selector exists in ABI", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = ethers.toBigInt(ethers.randomBytes(31));
    try {
      await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `deposit() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("batchDeposit(uint256[],uint256[]) selector exists in ABI", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment1 = ethers.toBigInt(ethers.randomBytes(31));
    const commitment2 = ethers.toBigInt(ethers.randomBytes(31));
    const amount1 = ethers.parseEther("0.5");
    const amount2 = ethers.parseEther("0.5");
    try {
      await pool.connect(alice).batchDeposit(
        [commitment1, commitment2],
        [amount1, amount2],
        { value: amount1 + amount2 }
      );
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `batchDeposit() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("transfer(...) selector exists in ABI", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = ethers.toBigInt(ethers.randomBytes(31));
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });
    const root = await pool.getLastRoot();
    const out1 = ethers.toBigInt(ethers.randomBytes(31));
    const out2 = ethers.toBigInt(ethers.randomBytes(31));

    try {
      await pool.transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, 1n, out1, out2);
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `transfer() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("withdraw(...) selector exists in ABI", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);
    const commitment = ethers.toBigInt(ethers.randomBytes(31));
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });
    const root = await pool.getLastRoot();

    try {
      await pool.withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        1n,
        DEPOSIT_AMOUNT,
        bob.address as `0x${string}`,
        0n,
        ethers.ZeroAddress as `0x${string}`,
        0n
      );
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `withdraw() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("pause() selector exists", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    try {
      await pool.connect(owner).pause();
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `pause() selector not found: ${(err as Error).message}`
      );
    }
    expect(await pool.paused()).to.equal(true);
  });

  it("unpause() selector exists", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    await pool.connect(owner).pause();
    try {
      await pool.connect(owner).unpause();
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `unpause() selector not found: ${(err as Error).message}`
      );
    }
    expect(await pool.paused()).to.equal(false);
  });

  it("queueAction(bytes32) selector exists", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    const actionHash = ethers.keccak256(ethers.toUtf8Bytes("test-action"));
    try {
      await pool.connect(owner).queueAction(actionHash);
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `queueAction() selector not found: ${(err as Error).message}`
      );
    }
    const pending = await pool.pendingAction();
    expect(pending.actionHash).to.equal(actionHash);
  });

  it("cancelAction() selector exists", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    const actionHash = ethers.keccak256(ethers.toUtf8Bytes("cancel-test"));
    await pool.connect(owner).queueAction(actionHash);
    try {
      await pool.connect(owner).cancelAction();
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `cancelAction() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("setAllowlistEnabled(bool) selector exists", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    try {
      await pool.connect(owner).setAllowlistEnabled(true);
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `setAllowlistEnabled() selector not found: ${(err as Error).message}`
      );
    }
    expect(await pool.allowlistEnabled()).to.equal(true);
  });

  it("setAllowlisted(address,bool) selector exists", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);
    try {
      await pool.connect(owner).setAllowlisted(alice.address, true);
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `setAllowlisted() selector not found: ${(err as Error).message}`
      );
    }
    expect(await pool.allowlisted(alice.address)).to.equal(true);
  });

  it("setMaxOperationsPerBlock(uint256) selector exists", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    try {
      await pool.connect(owner).setMaxOperationsPerBlock(10n);
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `setMaxOperationsPerBlock() selector not found: ${(err as Error).message}`
      );
    }
    expect(await pool.maxOperationsPerBlock()).to.equal(10n);
  });

  it("setDepositReceipt(address) selector exists", async function () {
    const { pool, owner, depositReceipt } = await loadFixture(deployFixture);
    try {
      await pool.connect(owner).setDepositReceipt(await depositReceipt.getAddress());
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `setDepositReceipt() selector not found: ${(err as Error).message}`
      );
    }
  });

  // -------------------------------------------------------------------------
  // ConfidentialPool — view functions
  // -------------------------------------------------------------------------

  it("isSpent(uint256) selector exists and returns bool", async function () {
    const { pool } = await loadFixture(deployFixture);
    const result = await pool.isSpent(1n);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
  });

  it("isCommitted(uint256) selector exists and returns bool", async function () {
    const { pool } = await loadFixture(deployFixture);
    const result = await pool.isCommitted(1n);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
  });

  it("getLastRoot() selector exists and returns uint256", async function () {
    const { pool } = await loadFixture(deployFixture);
    const root = await pool.getLastRoot();
    expect(typeof root).to.equal("bigint");
  });

  it("isKnownRoot(uint256) selector exists and returns bool", async function () {
    const { pool } = await loadFixture(deployFixture);
    const result = await pool.isKnownRoot(1n);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
  });

  it("getTreeCapacity() selector exists and returns uint256", async function () {
    const { pool } = await loadFixture(deployFixture);
    const capacity = await pool.getTreeCapacity();
    expect(typeof capacity).to.equal("bigint");
    expect(capacity).to.equal(BigInt(2 ** MERKLE_TREE_HEIGHT));
  });

  it("getTreeUtilization() selector exists and returns uint256", async function () {
    const { pool } = await loadFixture(deployFixture);
    const utilization = await pool.getTreeUtilization();
    expect(typeof utilization).to.equal("bigint");
    expect(utilization).to.equal(0n);
  });

  it("getDepositCount() selector exists and returns uint32", async function () {
    const { pool } = await loadFixture(deployFixture);
    const count = await pool.getDepositCount();
    expect(typeof count).to.equal("bigint");
    expect(count).to.equal(0n);
  });

  it("getPoolBalance() selector exists and returns uint256", async function () {
    const { pool } = await loadFixture(deployFixture);
    const balance = await pool.getPoolBalance();
    expect(typeof balance).to.equal("bigint");
    expect(balance).to.equal(0n);
  });

  it("getActiveNoteCount() selector exists and returns uint256", async function () {
    const { pool } = await loadFixture(deployFixture);
    const count = await pool.getActiveNoteCount();
    expect(typeof count).to.equal("bigint");
    expect(count).to.equal(0n);
  });

  it("getPoolHealth() selector exists and returns 7 values", async function () {
    const { pool } = await loadFixture(deployFixture);
    const result = await pool.getPoolHealth();
    const [activeNotes, treeUtilization, poolBalance, isPaused, isAllowlisted, currentMaxWithdraw, currentMinAge] = result;
    expect(typeof activeNotes).to.equal("bigint");
    expect(typeof treeUtilization).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
    expect(typeof isPaused).to.equal("boolean");
    expect(typeof isAllowlisted).to.equal("boolean");
    expect(typeof currentMaxWithdraw).to.equal("bigint");
    expect(typeof currentMinAge).to.equal("bigint");
  });

  it("getPoolStats() selector exists and returns 7 values", async function () {
    const { pool } = await loadFixture(deployFixture);
    const result = await pool.getPoolStats();
    const [
      totalDeposited,
      totalWithdrawn,
      totalTransfers,
      depositCount,
      withdrawalCount,
      uniqueDepositors,
      poolBalance,
    ] = result;
    expect(typeof totalDeposited).to.equal("bigint");
    expect(typeof totalWithdrawn).to.equal("bigint");
    expect(typeof totalTransfers).to.equal("bigint");
    expect(typeof depositCount).to.equal("bigint");
    expect(typeof withdrawalCount).to.equal("bigint");
    expect(typeof uniqueDepositors).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
  });

  it("getDenominations() selector exists and returns uint256[]", async function () {
    const { pool } = await loadFixture(deployFixture);
    const denoms = await pool.getDenominations();
    expect(Array.isArray(denoms)).to.equal(true);
    expect(denoms.length).to.equal(0);
  });

  it("getRemainingDeposits(address) selector exists and returns uint256", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const remaining = await pool.getRemainingDeposits(alice.address);
    expect(typeof remaining).to.equal("bigint");
    // Default is unlimited (type(uint256).max)
    expect(remaining).to.equal(ethers.MaxUint256);
  });

  it("getWithdrawalRecordCount() selector exists and returns uint256", async function () {
    const { pool } = await loadFixture(deployFixture);
    const count = await pool.getWithdrawalRecordCount();
    expect(typeof count).to.equal("bigint");
    expect(count).to.equal(0n);
  });

  it("getWithdrawalRecord(uint256) selector exists — reverts for out-of-bounds index", async function () {
    const { pool } = await loadFixture(deployFixture);
    try {
      await pool.getWithdrawalRecord(0n);
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `getWithdrawalRecord() selector not found: ${(err as Error).message}`
      );
      expect((err as Error).message).to.include("invalid record index");
    }
  });

  it("getCommitments(uint32,uint32) selector exists and returns uint256[]", async function () {
    const { pool } = await loadFixture(deployFixture);
    const result = await pool.getCommitments(0, 10);
    expect(Array.isArray(result)).to.equal(true);
  });

  it("hashLeftRight(uint256,uint256) selector exists and returns uint256", async function () {
    const { pool } = await loadFixture(deployFixture);
    const result = await pool.hashLeftRight(1n, 2n);
    expect(typeof result).to.equal("bigint");
    expect(result).to.be.gt(0n);
  });

  it("owner() selector exists and returns address", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    const ownerAddr = await pool.owner();
    expect(ownerAddr).to.equal(owner.address);
  });

  it("supportsInterface(bytes4) selector exists and returns bool", async function () {
    const { pool } = await loadFixture(deployFixture);
    // ERC165 interface ID
    const result = await pool.supportsInterface("0x01ffc9a7");
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(true);
  });

  it("VERSION() selector exists and returns string", async function () {
    const { pool } = await loadFixture(deployFixture);
    const version = await pool.VERSION();
    expect(typeof version).to.equal("string");
    expect(version.length).to.be.gt(0);
  });

  it("getVersion() selector exists and returns string matching VERSION", async function () {
    const { pool } = await loadFixture(deployFixture);
    const version = await pool.getVersion();
    expect(typeof version).to.equal("string");
    expect(version).to.equal(await pool.VERSION());
  });

  // -------------------------------------------------------------------------
  // StealthRegistry
  // -------------------------------------------------------------------------

  it("StealthRegistry.registerViewingKey(uint256,uint256) selector exists", async function () {
    const { stealthRegistry, alice } = await loadFixture(deployFixture);
    const pubKeyX = 1n;
    const pubKeyY = 2n;
    try {
      await stealthRegistry.connect(alice).registerViewingKey(pubKeyX, pubKeyY);
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `registerViewingKey() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("StealthRegistry.getViewingKey(address) selector exists and returns (uint256,uint256)", async function () {
    const { stealthRegistry, alice } = await loadFixture(deployFixture);
    const pubKeyX = 12345n;
    const pubKeyY = 67890n;
    await stealthRegistry.connect(alice).registerViewingKey(pubKeyX, pubKeyY);

    const [x, y] = await stealthRegistry.getViewingKey(alice.address);
    expect(typeof x).to.equal("bigint");
    expect(typeof y).to.equal("bigint");
    expect(x).to.equal(pubKeyX);
    expect(y).to.equal(pubKeyY);
  });

  it("StealthRegistry.announceStealthPayment(...) selector exists", async function () {
    const { stealthRegistry, alice } = await loadFixture(deployFixture);
    try {
      await stealthRegistry.connect(alice).announceStealthPayment(
        1n, // commitment
        2n, // ephemeralPubKeyX
        3n, // ephemeralPubKeyY
        4n, // stealthPubKeyX
        5n, // stealthPubKeyY
        6n, // encryptedAmount
        7n  // encryptedBlinding
      );
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `announceStealthPayment() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("StealthRegistry.VERSION() selector exists and returns string", async function () {
    const { stealthRegistry } = await loadFixture(deployFixture);
    const version = await stealthRegistry.VERSION();
    expect(typeof version).to.equal("string");
    expect(version.length).to.be.gt(0);
  });

  // -------------------------------------------------------------------------
  // PoolLens
  // -------------------------------------------------------------------------

  it("PoolLens.getSnapshot(address) selector exists and returns PoolSnapshot", async function () {
    const { pool, poolLens } = await loadFixture(deployFixture);
    const snapshot = await poolLens.getSnapshot(await pool.getAddress());
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
  });

  // -------------------------------------------------------------------------
  // DepositReceipt
  // -------------------------------------------------------------------------

  it("DepositReceipt.mint(address,uint256,uint256) selector exists — reverts with only pool for non-pool caller", async function () {
    const { depositReceipt, alice } = await loadFixture(deployFixture);
    try {
      await depositReceipt.connect(alice).mint(alice.address, 1n, ethers.parseEther("1"));
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `mint() selector not found on DepositReceipt: ${(err as Error).message}`
      );
      expect((err as Error).message).to.include("only pool");
    }
  });
});
