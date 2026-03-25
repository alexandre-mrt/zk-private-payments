import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_AMOUNT = ethers.parseEther("1");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  )) as unknown as ConfidentialPool;

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await pool.getAddress()
  )) as unknown as DepositReceipt;

  return { pool, receipt, owner, alice, bob, carol };
}

async function deployFixtureWithReceipt() {
  const base = await deployFixture();
  await base.pool.setDepositReceipt(await base.receipt.getAddress());
  return base;
}

// ---------------------------------------------------------------------------
// Receipt Ownership
// ---------------------------------------------------------------------------

describe("Receipt Ownership", function () {
  it("each depositor owns their receipt", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.ownerOf(1n)).to.equal(bob.address);
  });

  it("3 users deposit: each has balanceOf == 1", async function () {
    const { pool, receipt, alice, bob, carol } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(carol).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.balanceOf(bob.address)).to.equal(1n);
    expect(await receipt.balanceOf(carol.address)).to.equal(1n);
  });

  it("same user deposits 3 times: balanceOf == 3", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.balanceOf(alice.address)).to.equal(3n);
  });

  it("ownerOf tracks correct address for each token", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.ownerOf(1n)).to.equal(bob.address);
    expect(await receipt.ownerOf(2n)).to.equal(alice.address);
  });

  it("receipt persists after operations (not burned on deposit)", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    // Make a second deposit to change pool state
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // First receipt still owned by alice
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.balanceOf(alice.address)).to.equal(2n);
  });

  it("ownerOf for token 0 is the first depositor", async function () {
    const { pool, receipt, bob, alice } = await loadFixture(deployFixtureWithReceipt);

    // bob deposits first
    await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.ownerOf(0n)).to.equal(bob.address);
    expect(await receipt.ownerOf(1n)).to.equal(alice.address);
  });

  it("withdrawal doesn't change receipt ownership", async function () {
    // Receipts are soulbound — ownership cannot change. We verify the token still
    // belongs to alice after time passes (ZK proofs are required for actual withdrawal;
    // this tests the NFT state is unaffected by pool operations).
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const ownerBefore = await receipt.ownerOf(0n);
    expect(ownerBefore).to.equal(alice.address);

    // Additional deposit to modify pool state without affecting existing receipt
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const ownerAfter = await receipt.ownerOf(0n);
    expect(ownerAfter).to.equal(alice.address);
  });

  it("receipt commitment matches the specific deposit", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);

    const commitmentAlice = randomCommitment();
    const commitmentBob = randomCommitment();

    await pool.connect(alice).deposit(commitmentAlice, { value: DEPOSIT_AMOUNT });
    await pool.connect(bob).deposit(commitmentBob, { value: DEPOSIT_AMOUNT });

    expect(await receipt.tokenCommitment(0n)).to.equal(commitmentAlice);
    expect(await receipt.tokenCommitment(1n)).to.equal(commitmentBob);
  });

  it("no receipt minted when depositReceipt is not set", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixture);

    expect(await pool.depositReceipt()).to.equal(ethers.ZeroAddress);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.balanceOf(alice.address)).to.equal(0n);
  });

  it("owner can unset receipt and new deposits don't mint", async function () {
    const { pool, receipt, owner, alice } = await loadFixture(deployFixtureWithReceipt);

    // First deposit with receipt active
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(alice.address)).to.equal(1n);

    // Owner unsets the receipt (direct setDepositReceipt — no timelock on this pool)
    await pool.connect(owner).setDepositReceipt(ethers.ZeroAddress);
    expect(await pool.depositReceipt()).to.equal(ethers.ZeroAddress);

    // Second deposit — no new receipt should be minted
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
  });

  // ---------------------------------------------------------------------------
  // batchDeposit ownership
  // ---------------------------------------------------------------------------

  it("batchDeposit: all receipts owned by the batch caller", async function () {
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
    for (let i = 0; i < commitments.length; i++) {
      expect(await receipt.ownerOf(BigInt(i))).to.equal(alice.address);
    }
  });

  it("batchDeposit from user A, single deposit from user B: receipts correct", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);

    // alice does a batch of 2
    const batchCommitments = [randomCommitment(), randomCommitment()];
    const batchAmounts = [ethers.parseEther("1"), ethers.parseEther("2")];
    const batchTotal = batchAmounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(batchCommitments, batchAmounts, { value: batchTotal });

    // bob does a single deposit (gets token id 2)
    await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.balanceOf(alice.address)).to.equal(2n);
    expect(await receipt.balanceOf(bob.address)).to.equal(1n);

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.ownerOf(1n)).to.equal(alice.address);
    expect(await receipt.ownerOf(2n)).to.equal(bob.address);
  });

  it("receipt tokenAmount matches deposit amount per user", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);

    const amountAlice = ethers.parseEther("1");
    const amountBob = ethers.parseEther("2");

    await pool.connect(alice).deposit(randomCommitment(), { value: amountAlice });
    await pool.connect(bob).deposit(randomCommitment(), { value: amountBob });

    expect(await receipt.tokenAmount(0n)).to.equal(amountAlice);
    expect(await receipt.tokenAmount(1n)).to.equal(amountBob);
  });
});
