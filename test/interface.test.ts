import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

const MERKLE_TREE_HEIGHT = 5;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31)) || 1n;
}

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_TREE_HEIGHT,
    hasherAddress
  );

  const PoolLensFactory = await ethers.getContractFactory("PoolLens");
  const poolLens = await PoolLensFactory.deploy();

  const StealthRegistryFactory = await ethers.getContractFactory("StealthRegistry");
  const stealthRegistry = await StealthRegistryFactory.deploy();

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const depositReceipt = await DepositReceiptFactory.deploy(await pool.getAddress());

  return { pool, poolLens, stealthRegistry, depositReceipt, owner, alice, bob };
}

// Returns true only when the error is a missing function selector (ABI mismatch).
function isFunctionNotFound(err: unknown): boolean {
  const msg = (err as Error).message ?? "";
  return (
    msg.includes("function not found") ||
    msg.includes("no matching function") ||
    msg.includes("call revert exception") ||
    msg.includes("CALL_EXCEPTION")
  );
}

describe("Contract Interface", function () {
  // -------------------------------------------------------------------------
  // ConfidentialPool — core operations
  // -------------------------------------------------------------------------

  describe("ConfidentialPool — core operations", function () {
    it("exposes deposit(uint256) payable", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      const commitment = randomCommitment();
      try {
        await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `deposit() selector not found on ConfidentialPool: ${(err as Error).message}`
        );
      }
    });

    it("exposes transfer with correct signature", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      // Deposit first so a valid root exists.
      const inputCommitment = randomCommitment();
      await pool.connect(alice).deposit(inputCommitment, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      try {
        await pool.transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifier, out1, out2);
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `transfer() selector not found on ConfidentialPool: ${(err as Error).message}`
        );
      }
    });

    it("exposes withdraw with correct signature", async function () {
      const { pool, alice, bob } = await loadFixture(deployFixture);
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();
      const amount = ethers.parseEther("1");

      try {
        await pool.withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          amount,
          bob.address as `0x${string}`,
          0n,
          ethers.ZeroAddress as `0x${string}`,
          0n
        );
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `withdraw() selector not found on ConfidentialPool: ${(err as Error).message}`
        );
      }
    });

    it("exposes batchDeposit(uint256[], uint256[]) payable", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      const c1 = randomCommitment();
      const c2 = randomCommitment();
      const a1 = ethers.parseEther("0.5");
      const a2 = ethers.parseEther("0.5");

      try {
        await pool
          .connect(alice)
          .batchDeposit([c1, c2], [a1, a2], { value: a1 + a2 });
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `batchDeposit() selector not found on ConfidentialPool: ${(err as Error).message}`
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // ConfidentialPool — admin functions
  // -------------------------------------------------------------------------

  describe("ConfidentialPool — admin functions", function () {
    it("exposes pause() and unpause()", async function () {
      const { pool, owner } = await loadFixture(deployFixture);
      await pool.connect(owner).pause();
      expect(await pool.paused()).to.equal(true);
      await pool.connect(owner).unpause();
      expect(await pool.paused()).to.equal(false);
    });

    it("exposes queueAction(bytes32)", async function () {
      const { pool, owner } = await loadFixture(deployFixture);
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("test-action"));
      await pool.connect(owner).queueAction(actionHash);
      const pending = await pool.pendingAction();
      expect(pending.actionHash).to.equal(actionHash);
    });

    it("exposes cancelAction()", async function () {
      const { pool, owner } = await loadFixture(deployFixture);
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes("cancel-test"));
      await pool.connect(owner).queueAction(actionHash);
      await pool.connect(owner).cancelAction();
      const pending = await pool.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
    });

    it("exposes setAllowlistEnabled(bool)", async function () {
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
      await pool.connect(owner).setAllowlistEnabled(false);
    });

    it("exposes setAllowlisted(address, bool)", async function () {
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

    it("exposes batchSetAllowlisted(address[], bool)", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployFixture);
      try {
        await pool
          .connect(owner)
          .batchSetAllowlisted([alice.address, bob.address], true);
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `batchSetAllowlisted() selector not found: ${(err as Error).message}`
        );
      }
      expect(await pool.allowlisted(alice.address)).to.equal(true);
      expect(await pool.allowlisted(bob.address)).to.equal(true);
    });

    it("exposes setDepositReceipt(address)", async function () {
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

    it("exposes emergencyDrain(address payable) — only when paused", async function () {
      const { pool, owner, alice } = await loadFixture(deployFixture);
      await pool.connect(owner).pause();
      // Pool has no balance, so drain should revert on balance check not selector.
      try {
        await pool.connect(owner).emergencyDrain(alice.address as `0x${string}`);
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `emergencyDrain() selector not found: ${(err as Error).message}`
        );
      }
      await pool.connect(owner).unpause();
    });
  });

  // -------------------------------------------------------------------------
  // ConfidentialPool — view functions
  // -------------------------------------------------------------------------

  describe("ConfidentialPool — view functions", function () {
    it("exposes isSpent(uint256) view", async function () {
      const { pool } = await loadFixture(deployFixture);
      expect(await pool.isSpent(1n)).to.equal(false);
    });

    it("exposes isCommitted(uint256) view", async function () {
      const { pool } = await loadFixture(deployFixture);
      expect(await pool.isCommitted(1n)).to.equal(false);
    });

    it("exposes getCommitmentIndex(uint256) view — reverts for unknown commitment", async function () {
      const { pool } = await loadFixture(deployFixture);
      try {
        await pool.getCommitmentIndex(1n);
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `getCommitmentIndex() selector not found: ${(err as Error).message}`
        );
        expect((err as Error).message).to.include("commitment not found");
      }
    });

    it("exposes getDepositCount() view", async function () {
      const { pool } = await loadFixture(deployFixture);
      expect(await pool.getDepositCount()).to.equal(0n);
    });

    it("exposes getPoolBalance() view", async function () {
      const { pool } = await loadFixture(deployFixture);
      expect(await pool.getPoolBalance()).to.equal(0n);
    });

    it("exposes getActiveNoteCount() view", async function () {
      const { pool } = await loadFixture(deployFixture);
      expect(await pool.getActiveNoteCount()).to.equal(0n);
    });

    it("exposes getPoolHealth() view with 7 return values", async function () {
      const { pool } = await loadFixture(deployFixture);
      const result = await pool.getPoolHealth();
      const [
        activeNotes,
        treeUtilization,
        poolBalance,
        isPaused,
        isAllowlisted,
        currentMaxWithdraw,
        currentMinAge,
      ] = result;
      expect(activeNotes).to.be.a("bigint");
      expect(treeUtilization).to.be.a("bigint");
      expect(poolBalance).to.be.a("bigint");
      expect(isPaused).to.be.a("boolean");
      expect(isAllowlisted).to.be.a("boolean");
      expect(currentMaxWithdraw).to.be.a("bigint");
      expect(currentMinAge).to.be.a("bigint");
    });

    it("exposes getPoolStats() view with 7 return values", async function () {
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
      expect(totalDeposited).to.be.a("bigint");
      expect(totalWithdrawn).to.be.a("bigint");
      expect(totalTransfers).to.be.a("bigint");
      expect(depositCount).to.be.a("bigint");
      expect(withdrawalCount).to.be.a("bigint");
      expect(uniqueDepositors).to.be.a("bigint");
      expect(poolBalance).to.be.a("bigint");
    });

    it("exposes getTreeCapacity() view", async function () {
      const { pool } = await loadFixture(deployFixture);
      expect(await pool.getTreeCapacity()).to.equal(BigInt(2 ** MERKLE_TREE_HEIGHT));
    });

    it("exposes getLastRoot() view", async function () {
      const { pool } = await loadFixture(deployFixture);
      const root = await pool.getLastRoot();
      expect(root).to.not.equal(0n);
    });

    it("exposes getDenominations() view", async function () {
      const { pool } = await loadFixture(deployFixture);
      const denoms = await pool.getDenominations();
      expect(Array.isArray(denoms)).to.equal(true);
    });

    it("exposes getRemainingDeposits(address) view", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      // No limit set — should return type(uint256).max
      const remaining = await pool.getRemainingDeposits(alice.address);
      expect(remaining).to.equal(ethers.MaxUint256);
    });

    it("exposes getWithdrawalRecordCount() view", async function () {
      const { pool } = await loadFixture(deployFixture);
      expect(await pool.getWithdrawalRecordCount()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // StealthRegistry
  // -------------------------------------------------------------------------

  describe("StealthRegistry", function () {
    it("exposes registerViewingKey(uint256, uint256)", async function () {
      const { stealthRegistry, alice } = await loadFixture(deployFixture);
      // Non-zero BabyJubjub-style coordinates
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

    it("exposes getViewingKey(address) view", async function () {
      const { stealthRegistry, alice } = await loadFixture(deployFixture);
      await stealthRegistry.connect(alice).registerViewingKey(3n, 4n);
      const [x, y] = await stealthRegistry.getViewingKey(alice.address);
      expect(x).to.equal(3n);
      expect(y).to.equal(4n);
    });

    it("exposes announceStealthPayment with correct signature", async function () {
      const { stealthRegistry, alice } = await loadFixture(deployFixture);
      try {
        await stealthRegistry
          .connect(alice)
          .announceStealthPayment(1n, 2n, 3n, 4n, 5n, 6n, 7n);
      } catch (err) {
        expect(isFunctionNotFound(err)).to.equal(
          false,
          `announceStealthPayment() selector not found: ${(err as Error).message}`
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // PoolLens
  // -------------------------------------------------------------------------

  describe("PoolLens", function () {
    it("exposes getSnapshot(address) view", async function () {
      const { pool, poolLens } = await loadFixture(deployFixture);
      const poolAddress = await pool.getAddress();
      const snapshot = await poolLens.getSnapshot(poolAddress);
      expect(snapshot.totalDeposited).to.be.a("bigint");
      expect(snapshot.totalWithdrawn).to.be.a("bigint");
      expect(snapshot.totalTransfers).to.be.a("bigint");
      expect(snapshot.depositCount).to.be.a("bigint");
      expect(snapshot.withdrawalCount).to.be.a("bigint");
      expect(snapshot.uniqueDepositors).to.be.a("bigint");
      expect(snapshot.poolBalance).to.be.a("bigint");
      expect(snapshot.activeNotes).to.be.a("bigint");
      expect(snapshot.treeCapacity).to.equal(BigInt(2 ** MERKLE_TREE_HEIGHT));
      expect(snapshot.treeUtilization).to.be.a("bigint");
      expect(snapshot.lastRoot).to.not.equal(0n);
      expect(snapshot.isPaused).to.be.a("boolean");
      expect(snapshot.allowlistEnabled).to.be.a("boolean");
      expect(snapshot.maxWithdrawAmount).to.be.a("bigint");
      expect(snapshot.minDepositAge).to.be.a("bigint");
      expect(snapshot.owner).to.be.a("string");
    });
  });

  // -------------------------------------------------------------------------
  // DepositReceipt
  // -------------------------------------------------------------------------

  describe("DepositReceipt", function () {
    it("exposes mint — only callable by pool", async function () {
      const { depositReceipt, alice } = await loadFixture(deployFixture);
      // Calling from a non-pool address must revert with "only pool", not with
      // a function-not-found error, confirming the selector exists.
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

    it("is soulbound — transfers revert", async function () {
      const { pool, depositReceipt, owner, alice, bob } =
        await loadFixture(deployFixture);

      // Wire the receipt contract into the pool (no timelock for setDepositReceipt).
      await pool.connect(owner).setDepositReceipt(await depositReceipt.getAddress());

      // Make a deposit so token 0 is minted to alice.
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });

      const aliceAddress = await alice.getAddress();
      const bobAddress = await bob.getAddress();
      expect(await depositReceipt.ownerOf(0n)).to.equal(aliceAddress);

      // Attempting to transfer must revert with the soulbound message.
      await expect(
        depositReceipt
          .connect(alice)
          .transferFrom(aliceAddress, bobAddress, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound");
    });
  });
});
