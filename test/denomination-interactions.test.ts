import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_ETH = ethers.parseEther("1");
const HALF_ETH = ethers.parseEther("0.5");
const TWO_ETH = ethers.parseEther("2");
const COOLDOWN = 60; // seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

function timelockHash(action: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [action, value])
  );
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

async function timelockAction(pool: Pool, action: string, value: bigint): Promise<void> {
  await pool.queueAction(timelockHash(action, value));
  await time.increase(86401); // 1 day + 1 second
}

async function addDenomination(pool: Pool, value: bigint): Promise<void> {
  await timelockAction(pool, "addDenomination", value);
  await pool.addDenomination(value);
}

async function removeDenomination(pool: Pool, value: bigint): Promise<void> {
  await timelockAction(pool, "removeDenomination", value);
  await pool.removeDenomination(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Denomination Interactions", function () {
  // -------------------------------------------------------------------------
  // Denomination + batchDeposit
  // -------------------------------------------------------------------------

  describe("Denomination + batchDeposit", function () {
    it("batchDeposit with allowed denominations succeeds", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 2n })
      ).to.emit(pool, "Deposit");

      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("batchDeposit with one non-allowed denomination reverts entire batch", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);

      const commitments = [randomCommitment(), randomCommitment()];
      // second amount is not an allowed denomination
      const amounts = [ONE_ETH, HALF_ETH];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH + HALF_ETH })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");

      // No deposits should have been recorded
      expect(await pool.depositsPerAddress(alice.address)).to.equal(0n);
    });

    it("batchDeposit with mixed allowed amounts succeeds when all are allowed", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      await addDenomination(pool, TWO_ETH);

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, TWO_ETH];
      const total = ONE_ETH + TWO_ETH;
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.emit(pool, "Deposit");

      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    });
  });

  // -------------------------------------------------------------------------
  // Denomination + deposit limits
  // -------------------------------------------------------------------------

  describe("Denomination + deposit limits", function () {
    it("deposit limit applies regardless of denomination", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      await timelockAction(pool, "setMaxDepositsPerAddress", 2n);
      await pool.connect(owner).setMaxDepositsPerAddress(2n);

      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });

      // Third deposit with the same (allowed) denomination must still hit the limit
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");
    });

    it("each denomination deposit counts toward per-address limit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      await addDenomination(pool, TWO_ETH);
      await timelockAction(pool, "setMaxDepositsPerAddress", 2n);
      await pool.connect(owner).setMaxDepositsPerAddress(2n);

      // Use different denominations — both should count toward the limit
      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      await pool.connect(alice).deposit(randomCommitment(), { value: TWO_ETH });

      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
      expect(await pool.getRemainingDeposits(alice.address)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Denomination + cooldown
  // -------------------------------------------------------------------------

  describe("Denomination + cooldown", function () {
    it("deposit cooldown applies across different denominations", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      await addDenomination(pool, TWO_ETH);
      await timelockAction(pool, "setDepositCooldown", BigInt(COOLDOWN));
      await pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN));

      // First deposit with ONE_ETH starts the cooldown
      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });

      // Immediately attempting a deposit with a different denomination still triggers cooldown
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: TWO_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");

      // After cooldown expires the different denomination is accepted
      await time.increase(COOLDOWN + 1);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: TWO_ETH })
      ).to.emit(pool, "Deposit");
    });
  });

  // -------------------------------------------------------------------------
  // Denomination + allowlist
  // -------------------------------------------------------------------------

  describe("Denomination + allowlist", function () {
    it("allowlisted user can deposit any allowed denomination", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      await addDenomination(pool, TWO_ETH);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: TWO_ETH })
      ).to.emit(pool, "Deposit");
    });

    it("non-allowlisted user cannot deposit even an allowed denomination", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      await pool.connect(owner).setAllowlistEnabled(true);
      // alice is NOT in the allowlist

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  });

  // -------------------------------------------------------------------------
  // Denomination + receipts
  // -------------------------------------------------------------------------

  describe("Denomination + receipts", function () {
    async function deployFixtureWithReceipt() {
      const base = await deployPoolFixture();
      const DepositReceipt = await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceipt.deploy(await base.pool.getAddress());
      await base.pool.setDepositReceipt(await receipt.getAddress());
      return { ...base, receipt };
    }

    it("receipt stores correct amount for each denomination", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      await addDenomination(pool, ONE_ETH);

      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ONE_ETH });

      expect(await receipt.tokenAmount(0n)).to.equal(ONE_ETH);
      expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
    });

    it("receipt amounts differ by denomination", async function () {
      const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
      await addDenomination(pool, ONE_ETH);
      await addDenomination(pool, TWO_ETH);

      const c1 = randomCommitment();
      const c2 = randomCommitment();
      await pool.connect(alice).deposit(c1, { value: ONE_ETH });
      await pool.connect(alice).deposit(c2, { value: TWO_ETH });

      expect(await receipt.tokenAmount(0n)).to.equal(ONE_ETH);
      expect(await receipt.tokenAmount(1n)).to.equal(TWO_ETH);
      expect(await receipt.tokenCommitment(0n)).to.equal(c1);
      expect(await receipt.tokenCommitment(1n)).to.equal(c2);
    });
  });

  // -------------------------------------------------------------------------
  // Denomination management
  // -------------------------------------------------------------------------

  describe("Denomination management", function () {
    it("adding same denomination twice reverts", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      // Queue the same hash again (second attempt after timelock)
      await timelockAction(pool, "addDenomination", ONE_ETH);
      await expect(pool.addDenomination(ONE_ETH)).to.be.revertedWith(
        "ConfidentialPool: denomination exists"
      );
    });

    it("removing non-existent denomination reverts", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockAction(pool, "removeDenomination", ONE_ETH);
      await expect(pool.removeDenomination(ONE_ETH)).to.be.revertedWith(
        "ConfidentialPool: denomination not found"
      );
    });

    it("getDenominations returns all added denominations", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      await addDenomination(pool, TWO_ETH);

      const list = await pool.getDenominations();
      expect(list.length).to.equal(2);
      expect(list[0]).to.equal(ONE_ETH);
      expect(list[1]).to.equal(TWO_ETH);
    });

    it("removed denomination is no longer accepted for deposits", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);

      // Verify the denomination is accepted before removal
      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });

      await removeDenomination(pool, ONE_ETH);

      // denominationList still has one entry but the flag is false — must revert
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });

    it("re-adding a removed denomination works", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await addDenomination(pool, ONE_ETH);
      await removeDenomination(pool, ONE_ETH);

      // getDenominations still lists it (historical), but it is disabled
      expect(await pool.allowedDenominations(ONE_ETH)).to.be.false;

      // Re-add the same denomination
      await timelockAction(pool, "addDenomination", ONE_ETH);
      await pool.addDenomination(ONE_ETH);

      expect(await pool.allowedDenominations(ONE_ETH)).to.be.true;

      // Deposits must now succeed again
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");
    });
  });
});
