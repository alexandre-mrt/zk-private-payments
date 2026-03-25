import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const DEPOSIT_AMOUNT = ethers.parseEther("0.1");

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

function randomFieldElement(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
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
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie };
}

async function deployPoolWithReceiptFixture() {
  const base = await deployPoolFixture();
  const { pool, owner } = base;

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = await DepositReceiptFactory.deploy(await pool.getAddress());

  await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

async function deployPoolLensFixture() {
  const base = await deployPoolFixture();

  const PoolLensFactory = await ethers.getContractFactory("PoolLens");
  const lens = await PoolLensFactory.deploy();

  return { ...base, lens };
}

// ---------------------------------------------------------------------------
// ETH Handling Tests
// ---------------------------------------------------------------------------

describe("ETH Handling", function () {
  // -------------------------------------------------------------------------
  // Receive / fallback guard
  // -------------------------------------------------------------------------

  it("direct ETH send to ConfidentialPool reverts", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await expect(
      alice.sendTransaction({
        to: await pool.getAddress(),
        value: ethers.parseEther("1"),
      })
    ).to.be.revertedWithoutReason();
  });

  it("direct ETH send to StealthRegistry reverts", async function () {
    const { alice } = await loadFixture(deployPoolFixture);

    const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
    const registry = await StealthRegistry.deploy();

    await expect(
      alice.sendTransaction({
        to: await registry.getAddress(),
        value: 1n,
      })
    ).to.be.revertedWithoutReason();
  });

  it("pool only accepts ETH via deposit() or batchDeposit()", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomFieldElement();

    // Raw send must revert
    await expect(
      alice.sendTransaction({
        to: await pool.getAddress(),
        value: DEPOSIT_AMOUNT,
      })
    ).to.be.revertedWithoutReason();

    // deposit() must succeed
    await expect(
      pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT })
    ).to.not.be.reverted;
  });

  it("deposit with 0 ETH reverts", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomFieldElement();

    await expect(
      pool.connect(alice).deposit(commitment, { value: 0n })
    ).to.be.revertedWith("ConfidentialPool: zero deposit");
  });

  it("batchDeposit total must match msg.value exactly", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const c1 = randomFieldElement();
    const c2 = randomFieldElement();

    const amounts = [DEPOSIT_AMOUNT, DEPOSIT_AMOUNT];
    const totalNeeded = DEPOSIT_AMOUNT + DEPOSIT_AMOUNT;

    // Send too little
    await expect(
      pool.connect(alice).batchDeposit([c1, c2], amounts, {
        value: DEPOSIT_AMOUNT,
      })
    ).to.be.revertedWith("ConfidentialPool: incorrect total amount");

    // Send too much
    await expect(
      pool.connect(alice).batchDeposit([c1, c2], amounts, {
        value: totalNeeded + 1n,
      })
    ).to.be.revertedWith("ConfidentialPool: incorrect total amount");

    // Exact match succeeds
    await expect(
      pool.connect(alice).batchDeposit([c1, c2], amounts, {
        value: totalNeeded,
      })
    ).to.not.be.reverted;
  });

  it("withdrawal sends correct amount minus fee to recipient", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);
    const commitment = randomFieldElement();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const recipientAddr = await bob.getAddress();
    const root = await pool.getLastRoot();
    const nullifier = randomFieldElement();
    const fee = ethers.parseEther("0.001");
    const withdrawAmount = DEPOSIT_AMOUNT;

    const recipientBefore = await ethers.provider.getBalance(recipientAddr);

    await pool.connect(alice).withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      withdrawAmount,
      recipientAddr as unknown as Parameters<typeof pool.withdraw>[6],
      0n,
      ethers.ZeroAddress as unknown as Parameters<typeof pool.withdraw>[8],
      0n
    );

    const recipientAfter = await ethers.provider.getBalance(recipientAddr);
    // fee is 0 — recipient gets full withdrawal amount
    expect(recipientAfter - recipientBefore).to.equal(DEPOSIT_AMOUNT);
  });

  it("emergency drain sends full balance to owner", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    const c1 = randomFieldElement();
    const c2 = randomFieldElement();
    await pool.connect(alice).deposit(c1, { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(c2, { value: DEPOSIT_AMOUNT });

    const poolAddr = await pool.getAddress();
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(DEPOSIT_AMOUNT * 2n);

    // emergencyDrain requires paused state
    await pool.connect(owner).pause();

    const ownerAddr = await owner.getAddress();
    const ownerBefore = await ethers.provider.getBalance(ownerAddr);

    const tx = await pool.connect(owner).emergencyDrain(ownerAddr);
    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    const ownerAfter = await ethers.provider.getBalance(ownerAddr);
    // owner received 2 × DEPOSIT_AMOUNT, minus gas
    expect(ownerAfter - ownerBefore + gasUsed).to.equal(DEPOSIT_AMOUNT * 2n);
  });

  it("after full drain, pool balance is zero", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomFieldElement(), { value: DEPOSIT_AMOUNT });

    await pool.connect(owner).pause();
    const ownerAddr = await owner.getAddress();
    await pool.connect(owner).emergencyDrain(ownerAddr);

    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(0n);
  });

  it("DepositReceipt rejects direct ETH", async function () {
    const { receipt, alice } = await loadFixture(deployPoolWithReceiptFixture);

    await expect(
      alice.sendTransaction({
        to: await receipt.getAddress(),
        value: ethers.parseEther("0.1"),
      })
    ).to.be.revertedWithoutReason();
  });

  it("PoolLens rejects direct ETH", async function () {
    const { lens, alice } = await loadFixture(deployPoolLensFixture);

    await expect(
      alice.sendTransaction({
        to: await lens.getAddress(),
        value: 1n,
      })
    ).to.be.revertedWithoutReason();
  });
});
