import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_AMOUNT = ethers.parseEther("1");
const SOULBOUND_ERROR = "DepositReceipt: soulbound";

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
  const [owner, alice, bob, carol] = await ethers.getSigners();

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

  await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { pool, receipt, owner, alice, bob, carol };
}

// Fixture that also pre-mints a token to alice (tokenId = 0)
async function deployFixtureWithToken() {
  const base = await deployFixture();
  await base.pool.connect(base.alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
  return base;
}

// ---------------------------------------------------------------------------
// Soulbound Restrictions
// ---------------------------------------------------------------------------

describe("Soulbound Restrictions — DepositReceipt (zk-private-payments)", function () {
  it("transferFrom owner to other reverts", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("safeTransferFrom owner to other reverts", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await expect(
      receipt
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("safeTransferFrom with data reverts", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await expect(
      receipt
        .connect(alice)
        ["safeTransferFrom(address,address,uint256,bytes)"](
          alice.address,
          bob.address,
          0n,
          ethers.toUtf8Bytes("arbitrary data")
        )
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("approve does not enable transfer", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    // Approve succeeds — approvals are not blocked by soulbound logic
    await receipt.connect(alice).approve(bob.address, 0n);
    expect(await receipt.getApproved(0n)).to.equal(bob.address);

    // But the approved operator still cannot transfer
    await expect(
      receipt.connect(bob).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("setApprovalForAll does not enable transfer", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await receipt.connect(alice).setApprovalForAll(bob.address, true);
    expect(await receipt.isApprovedForAll(alice.address, bob.address)).to.be.true;

    // Operator approval does not bypass soulbound restriction
    await expect(
      receipt.connect(bob).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);
  });

  it("token stays with original owner after failed transfer attempt", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);

    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
  });

  it("balanceOf remains unchanged after failed transfer", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    const aliceBalanceBefore = await receipt.balanceOf(alice.address);
    const bobBalanceBefore = await receipt.balanceOf(bob.address);

    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith(SOULBOUND_ERROR);

    expect(await receipt.balanceOf(alice.address)).to.equal(aliceBalanceBefore);
    expect(await receipt.balanceOf(bob.address)).to.equal(bobBalanceBefore);
  });

  it("multiple tokens: none are transferable", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixture);

    // Mint 3 tokens to alice
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    for (const tokenId of [0n, 1n, 2n]) {
      await expect(
        receipt.connect(alice).transferFrom(alice.address, bob.address, tokenId)
      ).to.be.revertedWith(SOULBOUND_ERROR);
    }
  });

  it("mint is allowed (from == address(0))", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixture);

    // Deposit triggers a mint — must not revert
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.not.be.reverted;

    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
  });

  it("soulbound message is descriptive", async function () {
    const { receipt, alice, bob } = await loadFixture(deployFixtureWithToken);

    // Verify the exact revert string so callers can identify the reason
    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
    ).to.be.revertedWith("DepositReceipt: soulbound");
  });

  it("batchDeposit tokens are all soulbound", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixture);

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    expect(await receipt.balanceOf(alice.address)).to.equal(3n);

    // Every token minted via batchDeposit must be non-transferable
    for (const tokenId of [0n, 1n, 2n]) {
      await expect(
        receipt.connect(alice).transferFrom(alice.address, bob.address, tokenId)
      ).to.be.revertedWith(SOULBOUND_ERROR);
    }
  });

  it("token from batchDeposit cannot be transferred", async function () {
    const { pool, receipt, alice, bob } = await loadFixture(deployFixture);

    const commitments = [randomCommitment(), randomCommitment()];
    const amounts = [ethers.parseEther("1"), ethers.parseEther("2")];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    // Test all three ERC721 transfer paths for tokenId 1 (second in batch)
    await expect(
      receipt.connect(alice).transferFrom(alice.address, bob.address, 1n)
    ).to.be.revertedWith(SOULBOUND_ERROR);

    await expect(
      receipt
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 1n)
    ).to.be.revertedWith(SOULBOUND_ERROR);

    await expect(
      receipt
        .connect(alice)
        ["safeTransferFrom(address,address,uint256,bytes)"](
          alice.address,
          bob.address,
          1n,
          "0x"
        )
    ).to.be.revertedWith(SOULBOUND_ERROR);

    // Token must still belong to alice
    expect(await receipt.ownerOf(1n)).to.equal(alice.address);
  });
});
