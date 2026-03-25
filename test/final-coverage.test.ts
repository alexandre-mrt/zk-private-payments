import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type {
  ConfidentialPool,
  DepositReceipt,
  StealthRegistry,
} from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ROOT_HISTORY_SIZE = 30n;
const HARDHAT_CHAIN_ID = 31337n;
const TIMELOCK_DELAY = 86_400n; // 1 day in seconds
const ONE_DAY = 24 * 60 * 60;

// Proof stubs — TransferVerifier and WithdrawVerifier accept all-zero proofs
const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie] = await ethers.getSigners();
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

  return { pool, owner, alice, bob, charlie };
}

async function deployPoolWithReceiptFixture() {
  const base = await deployPoolFixture();
  const { pool, owner } = base;

  const DepositReceiptFactory =
    await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await pool.getAddress()
  )) as unknown as DepositReceipt;

  // setDepositReceipt does NOT require a timelock in ConfidentialPool
  await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

async function deployRegistryFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = (await StealthRegistry.deploy()) as unknown as StealthRegistry;
  return { registry, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Final Coverage", function () {
  // -------------------------------------------------------------------------
  // Timelock — initial state
  // -------------------------------------------------------------------------

  describe("Timelock — initial state", function () {
    it("TIMELOCK_DELAY is 86400", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.TIMELOCK_DELAY()).to.equal(TIMELOCK_DELAY);
    });

    it("pending action is zeroed initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const pending = await pool.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
      expect(pending.executeAfter).to.equal(0n);
    });

    it("queue + execute lifecycle", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 5n]
        )
      );
      await pool.connect(owner).queueAction(hash);
      const pending = await pool.pendingAction();
      expect(pending.actionHash).to.equal(hash);
      expect(pending.executeAfter).to.be.greaterThan(0n);

      await time.increase(ONE_DAY + 1);
      await pool.connect(owner).setMaxDepositsPerAddress(5n);

      const cleared = await pool.pendingAction();
      expect(cleared.actionHash).to.equal(ethers.ZeroHash);
      expect(cleared.executeAfter).to.equal(0n);
    });

    it("cancel clears pending", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 3n]
        )
      );
      await pool.connect(owner).queueAction(hash);
      await pool.connect(owner).cancelAction();
      const pending = await pool.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
    });
  });

  // -------------------------------------------------------------------------
  // Pool stats — empty state
  // -------------------------------------------------------------------------

  describe("Pool stats — empty state", function () {
    it("getPoolStats with empty pool returns all zeros", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const stats = await pool.getPoolStats();
      expect(stats._totalDeposited).to.equal(0n);
      expect(stats._totalWithdrawn).to.equal(0n);
      expect(stats._totalTransfers).to.equal(0n);
      expect(stats._depositCount).to.equal(0n);
      expect(stats._withdrawalCount).to.equal(0n);
      expect(stats._uniqueDepositors).to.equal(0n);
      expect(stats._poolBalance).to.equal(0n);
    });

    it("getActiveNoteCount with empty pool is 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getActiveNoteCount()).to.equal(0n);
    });

    it("getPoolHealth with empty pool has 0 utilization", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const health = await pool.getPoolHealth();
      expect(health.activeNotes).to.equal(0n);
      expect(health.treeUtilization).to.equal(0n);
      expect(health.poolBalance).to.equal(0n);
      expect(health.isPaused).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // DepositReceipt — metadata
  // -------------------------------------------------------------------------

  describe("DepositReceipt — metadata", function () {
    it("receipt pool() returns correct address", async function () {
      const { pool, receipt } = await loadFixture(deployPoolWithReceiptFixture);
      expect(await receipt.pool()).to.equal(await pool.getAddress());
    });

    it("receipt name is correct", async function () {
      const { receipt } = await loadFixture(deployPoolWithReceiptFixture);
      expect(await receipt.name()).to.equal("ZK Private Payment Receipt");
    });

    it("receipt symbol is correct", async function () {
      const { receipt } = await loadFixture(deployPoolWithReceiptFixture);
      expect(await receipt.symbol()).to.equal("ZKPR");
    });

    it("tokenURI for minted token contains valid base64 JSON prefix", async function () {
      const { pool, receipt, alice } = await loadFixture(
        deployPoolWithReceiptFixture
      );
      const c = randomCommitment();
      const amount = ethers.parseEther("1");
      await pool.connect(alice).deposit(c, { value: amount });
      const uri = await receipt.tokenURI(0n);
      expect(uri).to.include("data:application/json;base64,");
    });
  });

  // -------------------------------------------------------------------------
  // StealthRegistry — edge cases
  // -------------------------------------------------------------------------

  describe("StealthRegistry — edge cases", function () {
    it("getViewingKey for zero address returns (0, 0)", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      const [x, y] = await registry.getViewingKey(ethers.ZeroAddress);
      expect(x).to.equal(0n);
      expect(y).to.equal(0n);
    });

    it("announceStealthPayment with zero commitment succeeds (only emits event)", async function () {
      const { registry, alice } = await loadFixture(deployRegistryFixture);
      await expect(
        registry
          .connect(alice)
          .announceStealthPayment(0n, 1n, 2n, 3n, 4n, 5n, 6n)
      ).to.not.be.reverted;
    });

    it("StealthRegistry VERSION matches '1.0.0'", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);
      expect(await registry.VERSION()).to.equal("1.0.0");
    });
  });

  // -------------------------------------------------------------------------
  // Transfer — duplicate output commitment
  // -------------------------------------------------------------------------

  describe("Transfer — output commitment constraints", function () {
    it("transfer with zero output commitment1 reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = randomCommitment();
      await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();
      const out2 = randomCommitment();

      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          0n, // zero output commitment
          out2
        )
      ).to.be.revertedWith("ConfidentialPool: zero output commitment");
    });

    it("transfer with distinct output commitments succeeds", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = randomCommitment();
      await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await expect(
        pool
          .connect(alice)
          .transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifier, out1, out2)
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Withdrawal — amount edge cases
  // -------------------------------------------------------------------------

  describe("Withdrawal — amount edge cases", function () {
    it("withdraw 1 wei succeeds", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const c = randomCommitment();
      await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          1n, // 1 wei
          bob.address,
          0n, // no change
          ethers.ZeroAddress,
          0n
        )
      ).to.not.be.reverted;
    });

    it("withdraw full pool balance succeeds", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("2");
      const c = randomCommitment();
      await pool.connect(alice).deposit(c, { value: depositAmount });
      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();

      const bobBefore = await ethers.provider.getBalance(bob.address);
      await pool.connect(alice).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        depositAmount,
        bob.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      const bobAfter = await ethers.provider.getBalance(bob.address);
      expect(bobAfter - bobBefore).to.equal(depositAmount);
      expect(await pool.getPoolBalance()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Combined operations
  // -------------------------------------------------------------------------

  describe("Combined operations", function () {
    it("deposit → batchDeposit → transfer → withdraw full cycle", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount1 = ethers.parseEther("1");

      // deposit
      const c1 = randomCommitment();
      await pool.connect(alice).deposit(c1, { value: amount1 });

      // batchDeposit (2 notes)
      const c2 = randomCommitment();
      const c3 = randomCommitment();
      await pool.connect(alice).batchDeposit(
        [c2, c3],
        [amount1, amount1],
        { value: amount1 * 2n }
      );

      // transfer (spend c1, produce 2 outputs)
      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();
      await pool
        .connect(alice)
        .transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifier, out1, out2);

      // withdraw
      const root2 = await pool.getLastRoot();
      const nullifier2 = randomCommitment();
      await pool.connect(alice).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root2,
        nullifier2,
        amount1,
        bob.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      // validate stats
      const stats = await pool.getPoolStats();
      expect(stats._totalDeposited).to.equal(amount1 * 3n);
      expect(stats._totalWithdrawn).to.equal(amount1);
      expect(stats._totalTransfers).to.equal(1n);
      expect(stats._withdrawalCount).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe("Constants", function () {
    it("ROOT_HISTORY_SIZE is 30", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.ROOT_HISTORY_SIZE()).to.equal(ROOT_HISTORY_SIZE);
    });

    it("FIELD_SIZE matches BN254", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.FIELD_SIZE()).to.equal(FIELD_SIZE);
    });

    it("VERSION is 1.0.0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.VERSION()).to.equal("1.0.0");
    });

    it("deployedChainId is 31337", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.deployedChainId()).to.equal(HARDHAT_CHAIN_ID);
    });

    it("maxOperationsPerBlock defaults to 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.maxOperationsPerBlock()).to.equal(0n);
    });

    it("depositCooldown defaults to 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.depositCooldown()).to.equal(0n);
    });

    it("maxDepositsPerAddress defaults to 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.maxDepositsPerAddress()).to.equal(0n);
    });

    it("allowlistEnabled defaults to false", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.allowlistEnabled()).to.equal(false);
    });

    it("maxWithdrawAmount defaults to 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.maxWithdrawAmount()).to.equal(0n);
    });

    it("minDepositAge defaults to 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.minDepositAge()).to.equal(0n);
    });
  });
});
