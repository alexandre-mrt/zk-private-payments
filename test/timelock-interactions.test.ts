import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_ETH = ethers.parseEther("1");
const ONE_DAY = 86_400; // TIMELOCK_DELAY in seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

/** Matches keccak256(abi.encode(name, value)) used in ConfidentialPool */
function actionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

function maxDepositsHash(max: bigint): string {
  return actionHash("setMaxDepositsPerAddress", max);
}

function depositCooldownHash(cooldown: bigint): string {
  return actionHash("setDepositCooldown", cooldown);
}

function maxWithdrawHash(amount: bigint): string {
  return actionHash("setMaxWithdrawAmount", amount);
}

function minDepositAgeHash(age: bigint): string {
  return actionHash("setMinDepositAge", age);
}

function addDenominationHash(denom: bigint): string {
  return actionHash("addDenomination", denom);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
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
  return { pool, owner, alice, bob };
}

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];

/** Queue an action and advance time past the delay */
async function queueAndWait(pool: Pool, hash: string): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfidentialPool — Timelock Interactions", function () {
  // -------------------------------------------------------------------------
  // Queueing during pause still works
  // -------------------------------------------------------------------------

  it("queuing during pause still works", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    await pool.connect(owner).pause();

    const hash = maxDepositsHash(5n);
    await expect(pool.connect(owner).queueAction(hash)).to.emit(pool, "ActionQueued");

    const pending = await pool.pendingAction();
    expect(pending.actionHash).to.equal(hash);
  });

  // -------------------------------------------------------------------------
  // Executing after unpause works
  // -------------------------------------------------------------------------

  it("executing after unpause works", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const hash = maxDepositsHash(3n);
    await pool.connect(owner).pause();
    await pool.connect(owner).queueAction(hash);
    await time.increase(ONE_DAY + 1);
    await pool.connect(owner).unpause();

    await expect(pool.connect(owner).setMaxDepositsPerAddress(3n))
      .to.emit(pool, "ActionExecuted")
      .withArgs(hash);

    expect(await pool.maxDepositsPerAddress()).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // Ownership transfer does not affect pending action
  // -------------------------------------------------------------------------

  it("ownership transfer does not affect pending action", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    const hash = maxDepositsHash(7n);
    await pool.connect(owner).queueAction(hash);
    await pool.connect(owner).transferOwnership(alice.address);

    const pending = await pool.pendingAction();
    expect(pending.actionHash).to.equal(hash);
    expect(pending.executeAfter).to.be.greaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // New owner can execute action queued by old owner
  // -------------------------------------------------------------------------

  it("new owner can execute action queued by old owner", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    const hash = maxDepositsHash(7n);
    await pool.connect(owner).queueAction(hash);
    await pool.connect(owner).transferOwnership(alice.address);
    await time.increase(ONE_DAY + 1);

    await expect(pool.connect(alice).setMaxDepositsPerAddress(7n))
      .to.emit(pool, "ActionExecuted")
      .withArgs(hash);

    expect(await pool.maxDepositsPerAddress()).to.equal(7n);
  });

  // -------------------------------------------------------------------------
  // Cancel then queue new action: only new one is executable
  // -------------------------------------------------------------------------

  it("cancel then queue new action: only new one is executable", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const hash1 = maxDepositsHash(3n);
    const hash2 = maxDepositsHash(9n);

    await pool.connect(owner).queueAction(hash1);
    await pool.connect(owner).cancelAction();

    await pool.connect(owner).queueAction(hash2);
    await time.increase(ONE_DAY + 1);

    // Old value must revert
    await expect(
      pool.connect(owner).setMaxDepositsPerAddress(3n)
    ).to.be.revertedWith("ConfidentialPool: action not queued");

    // New value must succeed
    await expect(pool.connect(owner).setMaxDepositsPerAddress(9n))
      .to.emit(pool, "ActionExecuted")
      .withArgs(hash2);
  });

  // -------------------------------------------------------------------------
  // TIMELOCK_DELAY is a constant
  // -------------------------------------------------------------------------

  it("TIMELOCK_DELAY cannot be changed (it is a constant)", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    expect(await pool.TIMELOCK_DELAY()).to.equal(BigInt(ONE_DAY));
  });

  // -------------------------------------------------------------------------
  // Action hash is unique per function + parameter combo
  // -------------------------------------------------------------------------

  it("action hash is unique per function + parameter combo", async function () {
    const h1 = maxDepositsHash(5n);
    const h2 = depositCooldownHash(5n);
    const h3 = maxWithdrawHash(5n);
    const h4 = minDepositAgeHash(5n);
    const h5 = addDenominationHash(5n);

    const hashes = [h1, h2, h3, h4, h5];
    const unique = new Set(hashes);
    expect(unique.size).to.equal(hashes.length);
  });

  // -------------------------------------------------------------------------
  // Same function different params produces different hashes
  // -------------------------------------------------------------------------

  it("same function different params produces different hashes", async function () {
    expect(maxDepositsHash(5n)).to.not.equal(maxDepositsHash(6n));
    expect(depositCooldownHash(60n)).to.not.equal(depositCooldownHash(120n));
    expect(maxWithdrawHash(ONE_ETH)).to.not.equal(maxWithdrawHash(ONE_ETH * 2n));
  });

  // -------------------------------------------------------------------------
  // Queuing overwrites previous pending action
  // -------------------------------------------------------------------------

  it("queuing overwrites previous pending action", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const hash1 = maxDepositsHash(3n);
    const hash2 = maxDepositsHash(8n);

    await pool.connect(owner).queueAction(hash1);
    expect((await pool.pendingAction()).actionHash).to.equal(hash1);

    await pool.connect(owner).queueAction(hash2);
    expect((await pool.pendingAction()).actionHash).to.equal(hash2);

    await time.increase(ONE_DAY + 1);

    await expect(
      pool.connect(owner).setMaxDepositsPerAddress(3n)
    ).to.be.revertedWith("ConfidentialPool: action not queued");

    await expect(pool.connect(owner).setMaxDepositsPerAddress(8n))
      .to.emit(pool, "MaxDepositsPerAddressUpdated")
      .withArgs(8n);
  });

  // -------------------------------------------------------------------------
  // Execute at exactly executeAfter timestamp succeeds
  // -------------------------------------------------------------------------

  it("execute at exactly executeAfter timestamp succeeds", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const hash = maxDepositsHash(4n);
    await pool.connect(owner).queueAction(hash);

    const executeAfter = (await pool.pendingAction()).executeAfter;
    await time.setNextBlockTimestamp(executeAfter);

    await expect(pool.connect(owner).setMaxDepositsPerAddress(4n))
      .to.emit(pool, "ActionExecuted")
      .withArgs(hash);

    expect(await pool.maxDepositsPerAddress()).to.equal(4n);
  });

  // -------------------------------------------------------------------------
  // Multiple timelocked functions have independent queues (only 1 pending slot)
  // -------------------------------------------------------------------------

  it("only one action can be pending — second queueAction replaces the first", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const hashDenom = addDenominationHash(ONE_ETH);
    const hashMax = maxWithdrawHash(ONE_ETH);

    await pool.connect(owner).queueAction(hashDenom);
    // Immediately overwrite with a different action
    await pool.connect(owner).queueAction(hashMax);

    const pending = await pool.pendingAction();
    expect(pending.actionHash).to.equal(hashMax);

    await time.increase(ONE_DAY + 1);

    // addDenomination must revert (it was overwritten)
    await expect(pool.connect(owner).addDenomination(ONE_ETH)).to.be.revertedWith(
      "ConfidentialPool: action not queued"
    );

    // setMaxWithdrawAmount must succeed
    await expect(pool.connect(owner).setMaxWithdrawAmount(ONE_ETH))
      .to.emit(pool, "ActionExecuted")
      .withArgs(hashMax);
  });

  // -------------------------------------------------------------------------
  // Queue denomination then queue withdrawal limit — only last one executes
  // -------------------------------------------------------------------------

  it("queue denomination then queue withdrawal limit: only last one executes", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const hashDenom = addDenominationHash(ONE_ETH);
    const hashWithdraw = maxWithdrawHash(ONE_ETH * 5n);

    await pool.connect(owner).queueAction(hashDenom);
    // Overwrite before the delay expires
    await pool.connect(owner).queueAction(hashWithdraw);
    await time.increase(ONE_DAY + 1);

    // denomination was overwritten — must revert
    await expect(pool.connect(owner).addDenomination(ONE_ETH)).to.be.revertedWith(
      "ConfidentialPool: action not queued"
    );

    // withdrawal limit is the active action — must succeed
    await expect(pool.connect(owner).setMaxWithdrawAmount(ONE_ETH * 5n))
      .to.emit(pool, "MaxWithdrawAmountUpdated")
      .withArgs(ONE_ETH * 5n);

    expect(await pool.maxWithdrawAmount()).to.equal(ONE_ETH * 5n);
  });

  // -------------------------------------------------------------------------
  // Timelock works correctly for all 5 timelocked functions
  // -------------------------------------------------------------------------

  describe("all timelocked functions enforce the delay", function () {
    it("setMaxDepositsPerAddress reverts before delay and succeeds after", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = maxDepositsHash(10n);

      await pool.connect(owner).queueAction(hash);
      await expect(pool.connect(owner).setMaxDepositsPerAddress(10n)).to.be.revertedWith(
        "ConfidentialPool: timelock not expired"
      );

      await time.increase(ONE_DAY + 1);
      await expect(pool.connect(owner).setMaxDepositsPerAddress(10n))
        .to.emit(pool, "MaxDepositsPerAddressUpdated")
        .withArgs(10n);
    });

    it("setDepositCooldown reverts before delay and succeeds after", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const cooldown = 3600n; // 1 hour
      const hash = depositCooldownHash(cooldown);

      await pool.connect(owner).queueAction(hash);
      await expect(pool.connect(owner).setDepositCooldown(cooldown)).to.be.revertedWith(
        "ConfidentialPool: timelock not expired"
      );

      await time.increase(ONE_DAY + 1);
      await expect(pool.connect(owner).setDepositCooldown(cooldown))
        .to.emit(pool, "DepositCooldownUpdated")
        .withArgs(cooldown);

      expect(await pool.depositCooldown()).to.equal(cooldown);
    });

    it("setMaxWithdrawAmount reverts before delay and succeeds after", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const cap = ONE_ETH * 10n;
      const hash = maxWithdrawHash(cap);

      await pool.connect(owner).queueAction(hash);
      await expect(pool.connect(owner).setMaxWithdrawAmount(cap)).to.be.revertedWith(
        "ConfidentialPool: timelock not expired"
      );

      await time.increase(ONE_DAY + 1);
      await expect(pool.connect(owner).setMaxWithdrawAmount(cap))
        .to.emit(pool, "MaxWithdrawAmountUpdated")
        .withArgs(cap);

      expect(await pool.maxWithdrawAmount()).to.equal(cap);
    });

    it("setMinDepositAge reverts before delay and succeeds after", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const age = 5n; // 5 blocks
      const hash = minDepositAgeHash(age);

      await pool.connect(owner).queueAction(hash);
      await expect(pool.connect(owner).setMinDepositAge(age)).to.be.revertedWith(
        "ConfidentialPool: timelock not expired"
      );

      await time.increase(ONE_DAY + 1);
      await expect(pool.connect(owner).setMinDepositAge(age))
        .to.emit(pool, "MinDepositAgeUpdated")
        .withArgs(age);

      expect(await pool.minDepositAge()).to.equal(age);
    });

    it("addDenomination reverts before delay and succeeds after", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const hash = addDenominationHash(ONE_ETH);

      await pool.connect(owner).queueAction(hash);
      await expect(pool.connect(owner).addDenomination(ONE_ETH)).to.be.revertedWith(
        "ConfidentialPool: timelock not expired"
      );

      await time.increase(ONE_DAY + 1);
      await expect(pool.connect(owner).addDenomination(ONE_ETH))
        .to.emit(pool, "DenominationAdded")
        .withArgs(ONE_ETH);

      expect(await pool.allowedDenominations(ONE_ETH)).to.be.true;

      // Deposit at the new denomination must now work
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");
    });
  });
});
