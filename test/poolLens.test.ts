import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

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
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5, // small tree (32 leaves)
    hasherAddress
  );

  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = await Lens.deploy();

  return { pool, lens, owner, alice };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PoolLens", () => {
  describe("getSnapshot", () => {
    it("returns correct initial snapshot for a fresh pool", async () => {
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
      expect(snapshot.treeCapacity).to.equal(32n); // 2^5
      expect(snapshot.treeUtilization).to.equal(0n);
      expect(snapshot.isPaused).to.equal(false);
      expect(snapshot.allowlistEnabled).to.equal(false);
      expect(snapshot.maxWithdrawAmount).to.equal(0n);
      expect(snapshot.minDepositAge).to.equal(0n);
      expect(snapshot.maxDepositsPerAddress).to.equal(0n);
      expect(snapshot.owner).to.equal(owner.address);
    });

    it("reflects pool state after a deposit", async () => {
      const { pool, lens, alice } = await loadFixture(deployFixture);

      const commitment = ethers.toBigInt(ethers.randomBytes(31));
      const depositAmount = ethers.parseEther("1");
      await pool.connect(alice).deposit(commitment, { value: depositAmount });

      const snapshot = await lens.getSnapshot(await pool.getAddress());

      expect(snapshot.totalDeposited).to.equal(depositAmount);
      expect(snapshot.depositCount).to.equal(1n);
      expect(snapshot.poolBalance).to.equal(depositAmount);
      expect(snapshot.activeNotes).to.equal(1n);
      expect(snapshot.uniqueDepositors).to.equal(1n);
      expect(snapshot.treeUtilization).to.be.gt(0n);
    });

    it("reflects paused state when pool is paused", async () => {
      const { pool, lens, owner } = await loadFixture(deployFixture);

      await pool.connect(owner).pause();

      const snapshot = await lens.getSnapshot(await pool.getAddress());

      expect(snapshot.isPaused).to.equal(true);
    });

    it("lastRoot is non-zero after a deposit", async () => {
      const { pool, lens, alice } = await loadFixture(deployFixture);

      const commitment = ethers.toBigInt(ethers.randomBytes(31));
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });

      const snapshot = await lens.getSnapshot(await pool.getAddress());

      expect(snapshot.lastRoot).to.not.equal(0n);
    });
  });
});
