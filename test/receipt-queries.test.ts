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

function decodeTokenURI(uri: string): {
  name: string;
  attributes: Array<{ trait_type: string; value: string }>;
} {
  const base64Part = uri.replace("data:application/json;base64,", "");
  return JSON.parse(Buffer.from(base64Part, "base64").toString("utf8"));
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
// Receipt Queries
// ---------------------------------------------------------------------------

describe("Receipt Queries", function () {
  // -------------------------------------------------------------------------
  // ownerOf — boundary lookups
  // -------------------------------------------------------------------------

  it("ownerOf(0) returns first depositor after 1 deposit", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
  });

  it("ownerOf(N-1) returns last depositor after N deposits", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);

    const N = 4;
    // alice does N-1 deposits, bob does the last one
    for (let i = 0; i < N - 1; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    }
    await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // token N-1 (0-indexed) must belong to bob
    expect(await receipt.ownerOf(BigInt(N - 1))).to.equal(bob.address);
  });

  it("ownerOf(N) reverts for non-existent token", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // only token 0 exists — querying token 1 must revert
    await expect(receipt.ownerOf(1n)).to.be.revertedWithCustomError(
      receipt,
      "ERC721NonexistentToken"
    );
  });

  // -------------------------------------------------------------------------
  // balanceOf — supply tracking
  // -------------------------------------------------------------------------

  it("balanceOf returns 0 for non-depositor", async function () {
    const { receipt, bob } = await loadFixture(deployFixtureWithReceipt);

    expect(await receipt.balanceOf(bob.address)).to.equal(0n);
  });

  it("balanceOf increments per deposit for same user", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    expect(await receipt.balanceOf(alice.address)).to.equal(0n);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(alice.address)).to.equal(1n);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(alice.address)).to.equal(2n);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(alice.address)).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // tokenCommitment lookup
  // -------------------------------------------------------------------------

  it("tokenCommitment maps tokenId to correct commitment", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    const commitment = randomCommitment();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
  });

  it("tokenTimestamp maps tokenId to non-zero value", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    expect(await receipt.tokenTimestamp(0n)).to.be.greaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // tokenAmount lookup
  // -------------------------------------------------------------------------

  it("tokenAmount query returns correct ETH amount", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    const amount = ethers.parseEther("3.75");

    await pool.connect(alice).deposit(randomCommitment(), { value: amount });

    expect(await receipt.tokenAmount(0n)).to.equal(amount);
  });

  it("tokenAmount reflects distinct amounts per depositor", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);

    const amountAlice = ethers.parseEther("1");
    const amountBob = ethers.parseEther("5");

    await pool.connect(alice).deposit(randomCommitment(), { value: amountAlice });
    await pool.connect(bob).deposit(randomCommitment(), { value: amountBob });

    expect(await receipt.tokenAmount(0n)).to.equal(amountAlice);
    expect(await receipt.tokenAmount(1n)).to.equal(amountBob);
  });

  // -------------------------------------------------------------------------
  // Multi-user: unique tokens and correct ownership
  // -------------------------------------------------------------------------

  it("3 users deposit: each has unique token and correct owner", async function () {
    const { pool, receipt, alice, bob, carol } = await loadFixture(
      deployFixtureWithReceipt
    );

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(carol).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // Each user owns exactly one token
    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.balanceOf(bob.address)).to.equal(1n);
    expect(await receipt.balanceOf(carol.address)).to.equal(1n);

    // Tokens are sequential and tied to the depositor
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.ownerOf(1n)).to.equal(bob.address);
    expect(await receipt.ownerOf(2n)).to.equal(carol.address);
  });

  // -------------------------------------------------------------------------
  // No receipt contract wired: ownerOf has nothing to query
  // -------------------------------------------------------------------------

  it("deposit without receipt: ownerOf reverts (no tokens minted)", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixture);

    // Confirm receipt is not configured
    expect(await pool.depositReceipt()).to.equal(ethers.ZeroAddress);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // No minting occurred — token 0 must not exist
    await expect(receipt.ownerOf(0n)).to.be.revertedWithCustomError(
      receipt,
      "ERC721NonexistentToken"
    );
  });

  // -------------------------------------------------------------------------
  // batchDeposit tokens: all queryable with correct data
  // -------------------------------------------------------------------------

  it("batchDeposit tokens: all queryable with correct data", async function () {
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
      const tokenId = BigInt(i);
      expect(await receipt.ownerOf(tokenId)).to.equal(alice.address);
      expect(await receipt.tokenCommitment(tokenId)).to.equal(commitments[i]);
      expect(await receipt.tokenAmount(tokenId)).to.equal(amounts[i]);
      expect(await receipt.tokenTimestamp(tokenId)).to.be.greaterThan(0n);
    }

    // One past the batch must not exist
    await expect(receipt.ownerOf(3n)).to.be.revertedWithCustomError(
      receipt,
      "ERC721NonexistentToken"
    );
  });

  // -------------------------------------------------------------------------
  // Receipt data survives additional pool operations (soulbound, data intact)
  // -------------------------------------------------------------------------

  it("receipt data survives transfer operations (NFTs unaffected)", async function () {
    // Receipts are soulbound: NFT transfers are blocked. This verifies that
    // a rejected transfer attempt leaves commitment and amount data unchanged.
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);

    const commitment = randomCommitment();
    const amount = ethers.parseEther("1.5");

    await pool.connect(alice).deposit(commitment, { value: amount });

    // Capture state before attempted transfer
    const ownerBefore = await receipt.ownerOf(0n);
    const commitmentBefore = await receipt.tokenCommitment(0n);
    const amountBefore = await receipt.tokenAmount(0n);
    const timestampBefore = await receipt.tokenTimestamp(0n);

    // Attempted NFT transfer must revert (soulbound)
    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith("DepositReceipt: soulbound");

    // All receipt data must be unchanged after the failed transfer
    expect(await receipt.ownerOf(0n)).to.equal(ownerBefore);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitmentBefore);
    expect(await receipt.tokenAmount(0n)).to.equal(amountBefore);
    expect(await receipt.tokenTimestamp(0n)).to.equal(timestampBefore);
    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.balanceOf(bob.address)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // 10 rapid deposits: receipt data correctness
  // -------------------------------------------------------------------------

  it("receipt data is correct after 10 rapid deposits", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    const commitments: bigint[] = [];
    const amounts: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      const c = randomCommitment();
      const a = ethers.parseEther(String(i + 1));
      commitments.push(c);
      amounts.push(a);
      await pool.connect(alice).deposit(c, { value: a });
    }

    // Supply tracking
    expect(await receipt.balanceOf(alice.address)).to.equal(10n);

    // Boundary ownership
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
    expect(await receipt.ownerOf(9n)).to.equal(alice.address);

    // All data stored correctly
    for (let i = 0; i < 10; i++) {
      const tokenId = BigInt(i);
      expect(await receipt.tokenCommitment(tokenId)).to.equal(commitments[i]);
      expect(await receipt.tokenAmount(tokenId)).to.equal(amounts[i]);
      expect(await receipt.tokenTimestamp(tokenId)).to.be.greaterThan(0n);
    }

    // Token 10 must not exist
    await expect(receipt.ownerOf(10n)).to.be.revertedWithCustomError(
      receipt,
      "ERC721NonexistentToken"
    );
  });

  // -------------------------------------------------------------------------
  // tokenURI: prefix check for all tokens
  // -------------------------------------------------------------------------

  it("tokenURI starts with data:application/json;base64 for all tokens", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    const N = 5;
    for (let i = 0; i < N; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    }

    for (let i = 0; i < N; i++) {
      const uri = await receipt.tokenURI(BigInt(i));
      expect(uri).to.match(/^data:application\/json;base64,/);

      // Verify each URI is independently decodable and has the correct token id in name
      const meta = decodeTokenURI(uri);
      expect(meta.name).to.equal(`Deposit Receipt #${i}`);
    }
  });
});
