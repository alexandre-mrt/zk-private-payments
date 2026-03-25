import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_AMOUNT = ethers.parseEther("1");

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
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
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  );

  const DepositReceipt = await ethers.getContractFactory("DepositReceipt");
  const receipt = await DepositReceipt.deploy(await pool.getAddress());

  return { pool, receipt, owner, alice, bob };
}

async function deployFixtureWithReceipt() {
  const base = await deployFixture();
  await base.pool.setDepositReceipt(await base.receipt.getAddress());
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DepositReceipt", function () {
  // -------------------------------------------------------------------------
  // 1. Deployment and access control
  // -------------------------------------------------------------------------

  describe("Deployment", function () {
    it("stores the pool address as immutable", async function () {
      const { pool, receipt } = await loadFixture(deployFixture);
      expect(await receipt.pool()).to.equal(await pool.getAddress());
    });

    it("reverts if deployed with zero pool address", async function () {
      const DepositReceipt = await ethers.getContractFactory("DepositReceipt");
      await expect(
        DepositReceipt.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("DepositReceipt: zero pool");
    });
  });

  // -------------------------------------------------------------------------
  // 2. setDepositReceipt — owner access control
  // -------------------------------------------------------------------------

  describe("setDepositReceipt", function () {
    it("owner can set the receipt contract on the pool", async function () {
      const { pool, receipt, owner } = await loadFixture(deployFixture);
      const receiptAddress = await receipt.getAddress();
      await expect(pool.connect(owner).setDepositReceipt(receiptAddress))
        .to.emit(pool, "DepositReceiptSet")
        .withArgs(receiptAddress);
      expect(await pool.depositReceipt()).to.equal(receiptAddress);
    });

    it("non-owner cannot set the receipt contract", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixture);
      await expect(
        pool.connect(alice).setDepositReceipt(await receipt.getAddress())
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("owner can unset the receipt contract by passing address(0)", async function () {
      const { pool, receipt, owner } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(owner).setDepositReceipt(ethers.ZeroAddress);
      expect(await pool.depositReceipt()).to.equal(ethers.ZeroAddress);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Deposit mints receipt
  // -------------------------------------------------------------------------

  describe("deposit mints receipt", function () {
    it("mints receipt NFT to depositor on deposit", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      const commitment = randomCommitment();

      await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

      expect(await receipt.balanceOf(alice.address)).to.equal(1n);
      expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    });

    it("receipt stores commitment, amount, and timestamp", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      const commitment = randomCommitment();

      const tx = await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });
      const block = await ethers.provider.getBlock(tx.blockNumber!);

      expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
      expect(await receipt.tokenAmount(0n)).to.equal(DEPOSIT_AMOUNT);
      expect(await receipt.tokenTimestamp(0n)).to.equal(BigInt(block!.timestamp));
    });

    it("does not mint a receipt when receipt contract is not configured", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixture);
      // receipt not wired to pool — depositReceipt is address(0)
      const commitment = randomCommitment();

      await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

      expect(await receipt.balanceOf(alice.address)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // 4. batchDeposit mints receipts
  // -------------------------------------------------------------------------

  describe("batchDeposit mints receipts", function () {
    it("mints one receipt per commitment in a batch", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

      const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
      const amounts = [
        ethers.parseEther("1"),
        ethers.parseEther("2"),
        ethers.parseEther("3"),
      ];
      const total = amounts.reduce((a, b) => a + b, 0n);

      await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

      expect(await receipt.balanceOf(alice.address)).to.equal(3n);
      // Verify each token stores the correct commitment and amount
      for (let i = 0; i < commitments.length; i++) {
        expect(await receipt.tokenCommitment(BigInt(i))).to.equal(commitments[i]);
        expect(await receipt.tokenAmount(BigInt(i))).to.equal(amounts[i]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. Soulbound — transfers are blocked
  // -------------------------------------------------------------------------

  describe("soulbound", function () {
    it("reverts on transfer between two non-zero addresses", async function () {
      const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

      await expect(
        receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound");
    });

    it("reverts on safeTransferFrom between two non-zero addresses", async function () {
      const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

      await expect(
        receipt
          .connect(alice)
          ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Only pool can mint
  // -------------------------------------------------------------------------

  describe("access control on mint", function () {
    it("reverts if an arbitrary address calls mint directly", async function () {
      const { receipt, alice } = await loadFixture(deployFixture);
      await expect(
        receipt.connect(alice).mint(alice.address, randomCommitment(), DEPOSIT_AMOUNT)
      ).to.be.revertedWith("DepositReceipt: only pool");
    });
  });
});
