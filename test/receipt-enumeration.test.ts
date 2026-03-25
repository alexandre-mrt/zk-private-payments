import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

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
// Receipt Enumeration
// ---------------------------------------------------------------------------

describe("Receipt Enumeration", function () {
  it("no receipts exist before any deposit", async function () {
    const { receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    expect(await receipt.balanceOf(alice.address)).to.equal(0n);
  });

  it("first deposit mints tokenId 0", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
  });

  it("second deposit mints tokenId 1", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.ownerOf(1n)).to.equal(alice.address);
  });

  it("tokenCommitment matches deposit commitment for each receipt", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    const c0 = randomCommitment();
    const c1 = randomCommitment();

    await pool.connect(alice).deposit(c0, { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(c1, { value: DEPOSIT_AMOUNT });

    expect(await receipt.tokenCommitment(0n)).to.equal(c0);
    expect(await receipt.tokenCommitment(1n)).to.equal(c1);
  });

  it("tokenTimestamp is non-zero for minted tokens", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.tokenTimestamp(0n)).to.be.greaterThan(0n);
  });

  it("ownerOf returns depositor for each receipt", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.ownerOf(1n)).to.equal(alice.address);
    expect(await receipt.ownerOf(2n)).to.equal(alice.address);
  });

  it("balanceOf returns 1 per deposit per user", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(alice.address)).to.equal(1n);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(alice.address)).to.equal(2n);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(alice.address)).to.equal(3n);
  });

  it("multiple users have their own receipts", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
    const commitmentAlice = randomCommitment();
    const commitmentBob = randomCommitment();

    await pool.connect(alice).deposit(commitmentAlice, { value: DEPOSIT_AMOUNT });
    await pool.connect(bob).deposit(commitmentBob, { value: DEPOSIT_AMOUNT });

    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.balanceOf(bob.address)).to.equal(1n);
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.ownerOf(1n)).to.equal(bob.address);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitmentAlice);
    expect(await receipt.tokenCommitment(1n)).to.equal(commitmentBob);
  });

  it("tokenAmount stored correctly for single deposit", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    const amount = ethers.parseEther("2.5");

    await pool.connect(alice).deposit(randomCommitment(), { value: amount });

    expect(await receipt.tokenAmount(0n)).to.equal(amount);
  });

  it("tokenURI contains valid base64 JSON", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const uri = await receipt.tokenURI(0n);
    expect(uri).to.match(/^data:application\/json;base64,/);

    const base64Part = uri.replace("data:application/json;base64,", "");
    const decoded = Buffer.from(base64Part, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);

    expect(parsed).to.have.property("name");
    expect(parsed).to.have.property("description");
    expect(parsed).to.have.property("attributes");
    expect(Array.isArray(parsed.attributes)).to.be.true;
  });

  it("tokenURI contains correct tokenId in name field", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const uri0 = await receipt.tokenURI(0n);
    const decoded0 = Buffer.from(uri0.replace("data:application/json;base64,", ""), "base64").toString("utf8");
    expect(JSON.parse(decoded0).name).to.equal("Deposit Receipt #0");

    const uri1 = await receipt.tokenURI(1n);
    const decoded1 = Buffer.from(uri1.replace("data:application/json;base64,", ""), "base64").toString("utf8");
    expect(JSON.parse(decoded1).name).to.equal("Deposit Receipt #1");
  });

  it("batchDeposit creates sequential receipts", async function () {
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
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.ownerOf(1n)).to.equal(alice.address);
    expect(await receipt.ownerOf(2n)).to.equal(alice.address);
  });

  it("batchDeposit receipt amounts match deposit amounts", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    for (let i = 0; i < amounts.length; i++) {
      expect(await receipt.tokenAmount(BigInt(i))).to.equal(amounts[i]);
    }
  });

  it("receipt from batchDeposit has correct commitments", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    for (let i = 0; i < commitments.length; i++) {
      expect(await receipt.tokenCommitment(BigInt(i))).to.equal(commitments[i]);
    }
  });
});
