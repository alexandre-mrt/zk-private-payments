import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_AMOUNT = ethers.parseEther("1");
const DEPOSIT_AMOUNT_2 = ethers.parseEther("2");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

interface TokenMetadata {
  name: string;
  description: string;
  attributes: Array<{ trait_type: string; value: string }>;
}

function decodeTokenURI(uri: string): TokenMetadata {
  const prefix = "data:application/json;base64,";
  const base64Part = uri.replace(prefix, "");
  const decoded = Buffer.from(base64Part, "base64").toString("utf8");
  return JSON.parse(decoded) as TokenMetadata;
}

function getAttributeValue(
  meta: TokenMetadata,
  traitType: string
): string | undefined {
  const attr = meta.attributes.find((a) => a.trait_type === traitType);
  return attr?.value;
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

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = await DepositReceiptFactory.deploy(await pool.getAddress());

  return { pool, receipt, owner, alice, bob };
}

async function deployFixtureWithReceipt() {
  const base = await deployFixture();
  await base.pool.setDepositReceipt(await base.receipt.getAddress());
  return base;
}

// ---------------------------------------------------------------------------
// Receipt Metadata
// ---------------------------------------------------------------------------

describe("Receipt Metadata", function () {
  // -------------------------------------------------------------------------
  // 1. URI format
  // -------------------------------------------------------------------------

  it("tokenURI starts with data:application/json;base64,", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const uri = await receipt.tokenURI(0n);
    expect(uri).to.match(/^data:application\/json;base64,/);
  });

  // -------------------------------------------------------------------------
  // 2. JSON name field with correct tokenId
  // -------------------------------------------------------------------------

  it("decoded JSON has name field with correct tokenId", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const meta0 = decodeTokenURI(await receipt.tokenURI(0n));
    const meta1 = decodeTokenURI(await receipt.tokenURI(1n));

    expect(meta0.name).to.equal("Deposit Receipt #0");
    expect(meta1.name).to.equal("Deposit Receipt #1");
  });

  // -------------------------------------------------------------------------
  // 3. Description mentions 'soulbound'
  // -------------------------------------------------------------------------

  it("decoded JSON has description mentioning 'soulbound'", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    expect(meta.description).to.include("soulbound");
  });

  // -------------------------------------------------------------------------
  // 4. Attributes array present
  // -------------------------------------------------------------------------

  it("decoded JSON has attributes array", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    expect(meta.attributes).to.be.an("array");
    expect(meta.attributes.length).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 5. Commitment attribute — 0x-prefixed 64-char hex
  // -------------------------------------------------------------------------

  it("Commitment attribute value is hex string of correct length", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    const commitmentValue = getAttributeValue(meta, "Commitment");

    expect(commitmentValue).to.not.be.undefined;
    // Strings.toHexString(value, 32) produces "0x" + 64 hex chars
    expect(commitmentValue).to.match(/^0x[0-9a-f]{64}$/i);
  });

  // -------------------------------------------------------------------------
  // 6. Commitment attribute — correct value
  // -------------------------------------------------------------------------

  it("Commitment attribute value matches the deposited commitment", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    const commitmentValue = getAttributeValue(meta, "Commitment");

    const expected = "0x" + commitment.toString(16).padStart(64, "0");
    expect(commitmentValue?.toLowerCase()).to.equal(expected.toLowerCase());
  });

  // -------------------------------------------------------------------------
  // 7. Timestamp attribute — non-zero number string
  // -------------------------------------------------------------------------

  it("Timestamp attribute value is non-zero number", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    const timestampValue = getAttributeValue(meta, "Timestamp");

    expect(timestampValue).to.not.be.undefined;
    const ts = Number(timestampValue);
    expect(Number.isNaN(ts)).to.equal(false);
    expect(ts).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 8. Different tokens have different commitment attributes
  // -------------------------------------------------------------------------

  it("different tokens have different commitment attributes", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    const c0 = randomCommitment();
    const c1 = randomCommitment();
    await pool.connect(alice).deposit(c0, { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(c1, { value: DEPOSIT_AMOUNT });

    const meta0 = decodeTokenURI(await receipt.tokenURI(0n));
    const meta1 = decodeTokenURI(await receipt.tokenURI(1n));

    const cv0 = getAttributeValue(meta0, "Commitment");
    const cv1 = getAttributeValue(meta1, "Commitment");

    expect(cv0).to.not.equal(cv1);
  });

  // -------------------------------------------------------------------------
  // 9. tokenURI changes between tokens (not cached/shared)
  // -------------------------------------------------------------------------

  it("tokenURI changes between tokens (not cached/shared)", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const uri0 = await receipt.tokenURI(0n);
    const uri1 = await receipt.tokenURI(1n);

    expect(uri0).to.not.equal(uri1);
  });

  // -------------------------------------------------------------------------
  // 10. Very first token (id 0) has valid metadata
  // -------------------------------------------------------------------------

  it("very first token (id 0) has valid metadata", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const uri = await receipt.tokenURI(0n);
    expect(uri).to.match(/^data:application\/json;base64,/);

    const meta = decodeTokenURI(uri);
    expect(meta.name).to.equal("Deposit Receipt #0");
    expect(meta.attributes).to.be.an("array");
    expect(getAttributeValue(meta, "Commitment")).to.match(/^0x[0-9a-f]{64}$/i);
    expect(Number(getAttributeValue(meta, "Timestamp"))).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 11. Token after 10 deposits has correct metadata
  // -------------------------------------------------------------------------

  it("token after 10 deposits has correct metadata", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    // Merkle tree height = 5 → capacity = 32 slots, 10 deposits is safe
    for (let i = 0; i < 10; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    }

    const uri = await receipt.tokenURI(9n);
    const meta = decodeTokenURI(uri);

    expect(meta.name).to.equal("Deposit Receipt #9");
    expect(meta.attributes).to.be.an("array");
    expect(getAttributeValue(meta, "Commitment")).to.match(/^0x[0-9a-f]{64}$/i);
    expect(Number(getAttributeValue(meta, "Timestamp"))).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 12. Amount attribute present and correct
  // -------------------------------------------------------------------------

  it("Amount attribute present and matches deposited amount", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const meta = decodeTokenURI(await receipt.tokenURI(0n));
    const amountValue = getAttributeValue(meta, "Amount");

    expect(amountValue).to.not.be.undefined;
    // Strings.toString(amount) → decimal string of wei value
    expect(amountValue).to.equal(DEPOSIT_AMOUNT.toString());
  });

  // -------------------------------------------------------------------------
  // 13. Amount differs between tokens when deposit amounts differ
  // -------------------------------------------------------------------------

  it("Amount differs between tokens when deposit amounts differ", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT_2 });

    const meta0 = decodeTokenURI(await receipt.tokenURI(0n));
    const meta1 = decodeTokenURI(await receipt.tokenURI(1n));

    expect(getAttributeValue(meta0, "Amount")).to.equal(DEPOSIT_AMOUNT.toString());
    expect(getAttributeValue(meta1, "Amount")).to.equal(DEPOSIT_AMOUNT_2.toString());
  });

  // -------------------------------------------------------------------------
  // 14. batchDeposit tokens each have unique metadata
  // -------------------------------------------------------------------------

  it("batchDeposit tokens each have unique metadata", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    const metas = await Promise.all(
      [0n, 1n, 2n].map(async (id) => decodeTokenURI(await receipt.tokenURI(id)))
    );

    // Names are unique and correct
    expect(metas[0].name).to.equal("Deposit Receipt #0");
    expect(metas[1].name).to.equal("Deposit Receipt #1");
    expect(metas[2].name).to.equal("Deposit Receipt #2");

    // Commitments are distinct
    const cv = metas.map((m) => getAttributeValue(m, "Commitment"));
    expect(cv[0]).to.not.equal(cv[1]);
    expect(cv[1]).to.not.equal(cv[2]);
    expect(cv[0]).to.not.equal(cv[2]);

    // Amounts match the deposited values
    expect(getAttributeValue(metas[0], "Amount")).to.equal(amounts[0].toString());
    expect(getAttributeValue(metas[1], "Amount")).to.equal(amounts[1].toString());
    expect(getAttributeValue(metas[2], "Amount")).to.equal(amounts[2].toString());
  });

  // -------------------------------------------------------------------------
  // 15. Soulbound — approve does not bypass transfer restriction
  // -------------------------------------------------------------------------

  it("soulbound: approve does not bypass transfer restriction", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // approve should succeed
    await expect(receipt.connect(alice).approve(bob.address, 0n)).to.not.be.reverted;

    // but the approved party still cannot transfer
    await expect(
      receipt.connect(bob).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith("DepositReceipt: soulbound");
  });

  // -------------------------------------------------------------------------
  // 16. Soulbound — safeTransferFrom with bytes data reverts
  // -------------------------------------------------------------------------

  it("soulbound: safeTransferFrom(address,address,uint256,bytes) reverts", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    await expect(
      receipt
        .connect(alice)
        ["safeTransferFrom(address,address,uint256,bytes)"](
          alice.address,
          bob.address,
          0n,
          "0x"
        )
    ).to.be.revertedWith("DepositReceipt: soulbound");
  });

  // -------------------------------------------------------------------------
  // 17. Soulbound — setApprovalForAll does not bypass restriction
  // -------------------------------------------------------------------------

  it("soulbound: setApprovalForAll does not bypass transfer restriction", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    await expect(
      receipt.connect(alice).setApprovalForAll(bob.address, true)
    ).to.not.be.reverted;

    await expect(
      receipt
        .connect(bob)
        ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0n)
    ).to.be.revertedWith("DepositReceipt: soulbound");
  });
});
