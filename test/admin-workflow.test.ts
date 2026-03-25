import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const ONE_DAY = 24 * 60 * 60;
const DEPOSIT_AMOUNT = ethers.parseEther("1");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31)) || 1n;
}

function makeActionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

type Pool = Awaited<ReturnType<typeof deployFixture>>["pool"];

async function queueAndWait(pool: Pool, hash: string): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, newAdmin, alice, bob] = await ethers.getSigners();

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

  return { pool, owner, newAdmin, alice, bob };
}

async function deployFixtureWithFunds() {
  const base = await deployFixture();

  // Fund the pool with a deposit so emergencyDrain has balance to move
  const commitment = randomCommitment();
  await base.pool.connect(base.alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

  return base;
}

// ---------------------------------------------------------------------------
// Admin Workflows
// ---------------------------------------------------------------------------

describe("Admin Workflows", function () {
  // -------------------------------------------------------------------------
  // Emergency: pause
  // -------------------------------------------------------------------------

  it("emergency: pause halts all pool operations", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    // Owner pauses immediately — no timelock required
    await pool.connect(owner).pause();

    // Pool health confirms paused state
    const [, , , isPaused] = await pool.getPoolHealth();
    expect(isPaused).to.equal(true);

    // Deposit is blocked
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");

    // batchDeposit is also blocked
    await expect(
      pool.connect(alice).batchDeposit([randomCommitment()], [DEPOSIT_AMOUNT], {
        value: DEPOSIT_AMOUNT,
      })
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("emergency: pause + drain + unpause recovery flow", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixtureWithFunds);

    const poolAddr = await pool.getAddress();
    const poolBalanceBefore = await ethers.provider.getBalance(poolAddr);
    expect(poolBalanceBefore).to.equal(DEPOSIT_AMOUNT);

    // Pause first (required by emergencyDrain)
    await pool.connect(owner).pause();

    // Drain to owner
    const ownerAddr = await owner.getAddress();
    const ownerBalanceBefore = await ethers.provider.getBalance(ownerAddr);

    await expect(pool.connect(owner).emergencyDrain(ownerAddr))
      .to.emit(pool, "EmergencyDrain")
      .withArgs(ownerAddr, DEPOSIT_AMOUNT);

    // Pool is empty
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(0n);

    // Owner received the funds (roughly — minus gas)
    const ownerBalanceAfter = await ethers.provider.getBalance(ownerAddr);
    expect(ownerBalanceAfter).to.be.greaterThan(ownerBalanceBefore);

    // Unpause to resume operations
    await pool.connect(owner).unpause();
    const [, , , isPaused] = await pool.getPoolHealth();
    expect(isPaused).to.equal(false);

    // Deposits are accepted again
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // Governance: timelocked parameter changes
  // -------------------------------------------------------------------------

  it("governance: configure denominations via timelock", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    const denom = ethers.parseEther("0.5");
    const addHash = makeActionHash("addDenomination", denom);

    // Queue and execute addDenomination
    await queueAndWait(pool.connect(owner) as unknown as Pool, addHash);
    await expect(pool.connect(owner).addDenomination(denom))
      .to.emit(pool, "ActionExecuted").withArgs(addHash)
      .and.to.emit(pool, "DenominationAdded").withArgs(denom);

    expect(await pool.allowedDenominations(denom)).to.equal(true);

    // Deposit with the allowed denomination succeeds
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: denom })
    ).to.not.be.reverted;

    // Deposit with a different amount is now rejected
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
  });

  it("governance: set withdrawal limit via timelock", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    const cap = ethers.parseEther("2");
    const hash = makeActionHash("setMaxWithdrawAmount", cap);

    // Cannot execute before queuing
    await expect(
      pool.connect(owner).setMaxWithdrawAmount(cap)
    ).to.be.revertedWith("ConfidentialPool: action not queued");

    // Queue, wait, execute
    await queueAndWait(pool.connect(owner) as unknown as Pool, hash);
    await expect(pool.connect(owner).setMaxWithdrawAmount(cap))
      .to.emit(pool, "MaxWithdrawAmountUpdated").withArgs(cap)
      .and.to.emit(pool, "ActionExecuted").withArgs(hash);

    expect(await pool.maxWithdrawAmount()).to.equal(cap);

    // Pending action is cleared
    const pending = await pool.pendingAction();
    expect(pending.actionHash).to.equal(ethers.ZeroHash);
  });

  it("governance: set min deposit age via timelock", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    const blocks = 10n;
    const hash = makeActionHash("setMinDepositAge", blocks);

    await queueAndWait(pool.connect(owner) as unknown as Pool, hash);
    await expect(pool.connect(owner).setMinDepositAge(blocks))
      .to.emit(pool, "MinDepositAgeUpdated").withArgs(blocks)
      .and.to.emit(pool, "ActionExecuted").withArgs(hash);

    expect(await pool.minDepositAge()).to.equal(blocks);
  });

  // -------------------------------------------------------------------------
  // Compliance: allowlist
  // -------------------------------------------------------------------------

  it("compliance: enable allowlist + grant access + deposit flow", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployFixture);

    // Enable the allowlist — direct owner call, no timelock
    await expect(pool.connect(owner).setAllowlistEnabled(true))
      .to.emit(pool, "AllowlistToggled").withArgs(true);
    expect(await pool.allowlistEnabled()).to.equal(true);

    // Non-allowlisted address is blocked
    await expect(
      pool.connect(bob).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");

    // Grant alice access
    await expect(pool.connect(owner).setAllowlisted(alice.address, true))
      .to.emit(pool, "AllowlistUpdated").withArgs(alice.address, true);
    expect(await pool.allowlisted(alice.address)).to.equal(true);

    // Alice can now deposit
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.not.be.reverted;
  });

  it("compliance: revoke access mid-operation", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    // Enable allowlist and grant alice access
    await pool.connect(owner).setAllowlistEnabled(true);
    await pool.connect(owner).setAllowlisted(alice.address, true);

    // Alice deposits successfully
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // Owner revokes access
    await expect(pool.connect(owner).setAllowlisted(alice.address, false))
      .to.emit(pool, "AllowlistUpdated").withArgs(alice.address, false);

    expect(await pool.allowlisted(alice.address)).to.equal(false);

    // Alice can no longer deposit
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
  });

  // -------------------------------------------------------------------------
  // Ownership: transfer
  // -------------------------------------------------------------------------

  it("ownership: transfer to new admin, old admin locked out", async function () {
    const { pool, owner, newAdmin } = await loadFixture(deployFixture);

    // Transfer ownership
    await pool.connect(owner).transferOwnership(newAdmin.address);
    expect(await pool.owner()).to.equal(newAdmin.address);

    // Old owner is locked out
    await expect(
      pool.connect(owner).pause()
    ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");

    await expect(
      pool.connect(owner).setAllowlistEnabled(true)
    ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");

    // New admin has full control
    await expect(pool.connect(newAdmin).pause()).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // Configuration: deposit receipt + batch mint
  // -------------------------------------------------------------------------

  it("configuration: set deposit receipt, verify batch mint", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    // Deploy DepositReceipt
    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const receipt = await DepositReceiptFactory.deploy(await pool.getAddress());
    const receiptAddr = await receipt.getAddress();

    // Owner sets receipt — no timelock for this function
    await expect(pool.connect(owner).setDepositReceipt(receiptAddr))
      .to.emit(pool, "DepositReceiptSet").withArgs(receiptAddr);
    expect(await pool.depositReceipt()).to.equal(receiptAddr);

    // batchDeposit mints one receipt per commitment
    const commitments = [randomCommitment(), randomCommitment()];
    const amounts = [ethers.parseEther("1"), ethers.parseEther("2")];
    const total = amounts[0] + amounts[1];

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    expect(await receipt.balanceOf(alice.address)).to.equal(2n);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitments[0]);
    expect(await receipt.tokenCommitment(1n)).to.equal(commitments[1]);
    expect(await receipt.tokenAmount(0n)).to.equal(amounts[0]);
    expect(await receipt.tokenAmount(1n)).to.equal(amounts[1]);
  });

  // -------------------------------------------------------------------------
  // Rate-limit: max operations per block
  // -------------------------------------------------------------------------

  it("rate-limit: set max operations per block", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    // Set limit to 2 operations per block — direct owner call, no timelock
    await expect(pool.connect(owner).setMaxOperationsPerBlock(2n))
      .to.emit(pool, "MaxOperationsPerBlockUpdated").withArgs(2n);
    expect(await pool.maxOperationsPerBlock()).to.equal(2n);

    // batchDeposit with 3 commitments exceeds the per-block limit of 2 in a single tx
    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [DEPOSIT_AMOUNT, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT];
    await expect(
      pool.connect(alice).batchDeposit(commitments, amounts, { value: DEPOSIT_AMOUNT * 3n })
    ).to.be.revertedWith("ConfidentialPool: block operation limit");

    // A single deposit (1 operation) still succeeds under the limit
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // Anti-spam: deposit cooldown via timelock
  // -------------------------------------------------------------------------

  it("anti-spam: configure deposit cooldown via timelock", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    const cooldown = 3600n; // 1 hour
    const hash = makeActionHash("setDepositCooldown", cooldown);

    await queueAndWait(pool.connect(owner) as unknown as Pool, hash);
    await expect(pool.connect(owner).setDepositCooldown(cooldown))
      .to.emit(pool, "DepositCooldownUpdated").withArgs(cooldown)
      .and.to.emit(pool, "ActionExecuted").withArgs(hash);

    expect(await pool.depositCooldown()).to.equal(cooldown);

    // First deposit goes through
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // Immediate second deposit is rejected by the cooldown
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");

    // After cooldown elapses the deposit is accepted
    await time.increase(Number(cooldown) + 1);
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT })
    ).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // Monitoring: admin events
  // -------------------------------------------------------------------------

  it("monitoring: verify all admin events are emitted correctly", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    // AllowlistToggled
    await expect(pool.connect(owner).setAllowlistEnabled(true))
      .to.emit(pool, "AllowlistToggled").withArgs(true);
    await expect(pool.connect(owner).setAllowlistEnabled(false))
      .to.emit(pool, "AllowlistToggled").withArgs(false);

    // AllowlistUpdated
    await expect(pool.connect(owner).setAllowlisted(alice.address, true))
      .to.emit(pool, "AllowlistUpdated").withArgs(alice.address, true);
    await expect(pool.connect(owner).setAllowlisted(alice.address, false))
      .to.emit(pool, "AllowlistUpdated").withArgs(alice.address, false);

    // MaxOperationsPerBlockUpdated
    await expect(pool.connect(owner).setMaxOperationsPerBlock(5n))
      .to.emit(pool, "MaxOperationsPerBlockUpdated").withArgs(5n);

    // ActionQueued
    const hash = makeActionHash("setMaxDepositsPerAddress", 2n);
    await expect(pool.connect(owner).queueAction(hash))
      .to.emit(pool, "ActionQueued")
      .withArgs(hash, (v: bigint) => v > 0n);

    // ActionCancelled
    await expect(pool.connect(owner).cancelAction())
      .to.emit(pool, "ActionCancelled").withArgs(hash);

    // ActionQueued again for execution
    const hash2 = makeActionHash("setMaxDepositsPerAddress", 2n);
    await pool.connect(owner).queueAction(hash2);
    await time.increase(ONE_DAY + 1);

    // ActionExecuted + MaxDepositsPerAddressUpdated
    await expect(pool.connect(owner).setMaxDepositsPerAddress(2n))
      .to.emit(pool, "ActionExecuted").withArgs(hash2)
      .and.to.emit(pool, "MaxDepositsPerAddressUpdated").withArgs(2n);
  });
});
