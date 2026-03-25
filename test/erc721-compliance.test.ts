import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_AMOUNT = ethers.parseEther("1");

// ERC165 interface IDs
const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC165_INTERFACE_ID = "0x01ffc9a7";
const ERC721_METADATA_INTERFACE_ID = "0x5b5e139f";

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
// ERC721 Compliance Tests
// ---------------------------------------------------------------------------

describe("ERC721 Compliance — DepositReceipt (zk-private-payments)", function () {
  // -------------------------------------------------------------------------
  // 1. Metadata
  // -------------------------------------------------------------------------

  describe("Metadata", function () {
    it("name() returns 'ZK Private Payment Receipt'", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.name()).to.equal("ZK Private Payment Receipt");
    });

    it("symbol() returns 'ZKPR'", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.symbol()).to.equal("ZKPR");
    });
  });

  // -------------------------------------------------------------------------
  // 2. balanceOf
  // -------------------------------------------------------------------------

  describe("balanceOf", function () {
    it("returns 0 for an address with no tokens", async function () {
      const { receipt, alice } = await loadFixture(deployFixture);
      expect(await receipt.balanceOf(alice.address)).to.equal(0n);
    });

    it("returns 1 after one deposit", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    });

    it("returns N for an address with N deposits", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      expect(await receipt.balanceOf(alice.address)).to.equal(3n);
    });

    it("counts are independent per address", async function () {
      const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      expect(await receipt.balanceOf(alice.address)).to.equal(2n);
      expect(await receipt.balanceOf(bob.address)).to.equal(1n);
    });

    it("reverts for the zero address", async function () {
      const { receipt } = await loadFixture(deployFixture);
      await expect(
        receipt.balanceOf(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(receipt, "ERC721InvalidOwner");
    });
  });

  // -------------------------------------------------------------------------
  // 3. ownerOf
  // -------------------------------------------------------------------------

  describe("ownerOf", function () {
    it("returns the correct owner for each token", async function () {
      const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      await pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      expect(await receipt.ownerOf(0n)).to.equal(alice.address);
      expect(await receipt.ownerOf(1n)).to.equal(bob.address);
    });

    it("reverts for a non-existent token", async function () {
      const { receipt } = await loadFixture(deployFixture);
      await expect(
        receipt.ownerOf(999n)
      ).to.be.revertedWithCustomError(receipt, "ERC721NonexistentToken");
    });
  });

  // -------------------------------------------------------------------------
  // 4. tokenURI
  // -------------------------------------------------------------------------

  describe("tokenURI", function () {
    it("returns a valid data URI for an existing token", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

      const uri = await receipt.tokenURI(0n);
      expect(uri).to.match(/^data:application\/json;base64,/);

      const base64Part = uri.replace("data:application/json;base64,", "");
      const decoded = Buffer.from(base64Part, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      expect(parsed).to.have.property("name");
      expect(parsed).to.have.property("attributes");
    });

    it("reverts for a non-existent token", async function () {
      const { receipt } = await loadFixture(deployFixture);
      await expect(
        receipt.tokenURI(999n)
      ).to.be.revertedWithCustomError(receipt, "ERC721NonexistentToken");
    });
  });

  // -------------------------------------------------------------------------
  // 5. tokenAmount stored correctly
  // -------------------------------------------------------------------------

  describe("tokenAmount", function () {
    it("stores the deposited amount on the token", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      expect(await receipt.tokenAmount(0n)).to.equal(DEPOSIT_AMOUNT);
    });

    it("stores distinct amounts for deposits with different values", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      const amount1 = ethers.parseEther("1");
      const amount2 = ethers.parseEther("2");
      await pool.connect(alice).deposit(randomCommitment(), { value: amount1 });
      await pool.connect(alice).deposit(randomCommitment(), { value: amount2 });
      expect(await receipt.tokenAmount(0n)).to.equal(amount1);
      expect(await receipt.tokenAmount(1n)).to.equal(amount2);
    });
  });

  // -------------------------------------------------------------------------
  // 6. batchDeposit
  // -------------------------------------------------------------------------

  describe("batchDeposit", function () {
    it("mints receipts for each commitment — balanceOf reflects count", async function () {
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
    });

    it("batchDeposit stores the correct amount on each token", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("5")];
      const total = amounts.reduce((a, b) => a + b, 0n);

      await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

      expect(await receipt.tokenAmount(0n)).to.equal(amounts[0]);
      expect(await receipt.tokenAmount(1n)).to.equal(amounts[1]);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Soulbound restrictions
  // -------------------------------------------------------------------------

  describe("Soulbound restrictions", function () {
    it("transferFrom reverts with soulbound message", async function () {
      const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

      await expect(
        receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound");
    });

    it("safeTransferFrom(address,address,uint256) reverts with soulbound message", async function () {
      const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

      await expect(
        receipt
          .connect(alice)
          ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound");
    });

    it("safeTransferFrom(address,address,uint256,bytes) reverts with soulbound message", async function () {
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

    it("approve does not bypass the soulbound restriction on transfer", async function () {
      // approve itself is not blocked — only the subsequent transfer is blocked
      const { pool, receipt, alice, bob } = await loadFixture(deployFixtureWithReceipt);
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

      await expect(
        receipt.connect(alice).approve(bob.address, 0n)
      ).to.not.be.reverted;

      await expect(
        receipt.connect(bob).transferFrom(alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound");
    });
  });

  // -------------------------------------------------------------------------
  // 8. supportsInterface
  // -------------------------------------------------------------------------

  describe("supportsInterface", function () {
    it("returns true for ERC721 interface (0x80ac58cd)", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.supportsInterface(ERC721_INTERFACE_ID)).to.equal(true);
    });

    it("returns true for ERC165 interface (0x01ffc9a7)", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.supportsInterface(ERC165_INTERFACE_ID)).to.equal(true);
    });

    it("returns true for ERC721Metadata interface (0x5b5e139f)", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.supportsInterface(ERC721_METADATA_INTERFACE_ID)).to.equal(true);
    });

    it("returns false for an unknown interface", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });
});
