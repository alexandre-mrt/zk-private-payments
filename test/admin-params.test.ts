import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_ETH = ethers.parseEther("1");
const ONE_GWEI = 1_000_000_000n;
const ONE_YEAR_SECONDS = 365n * 24n * 60n * 60n; // 31_536_000 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof deployPoolFixture>>["alice"];

function timelockHash(action: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [action, value])
  );
}

function receiptTimelockHash(addr: string): string {
  // setDepositReceipt in ConfidentialPool has NO timelock — direct call
  // (no-op helper kept for symmetry)
  return addr;
}

async function deployPoolFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
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
  )) as ConfidentialPool;
  return { pool, owner, alice, bob };
}

async function deployPoolWithReceiptFixture() {
  const base = await deployPoolFixture();
  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await base.pool.getAddress()
  )) as unknown as DepositReceipt;
  return { ...base, receipt };
}

async function timelockExecute(pool: Pool, action: string, value: bigint): Promise<void> {
  await pool.queueAction(timelockHash(action, value));
  await time.increase(86401); // 1 day + 1 second
}

async function timelockSet(pool: Pool, action: string, value: bigint): Promise<void> {
  await timelockExecute(pool, action, value);
  switch (action) {
    case "setMaxDepositsPerAddress":
      await pool.setMaxDepositsPerAddress(value);
      break;
    case "setDepositCooldown":
      await pool.setDepositCooldown(value);
      break;
    case "setMaxWithdrawAmount":
      await pool.setMaxWithdrawAmount(value);
      break;
    case "setMinDepositAge":
      await pool.setMinDepositAge(value);
      break;
    case "addDenomination":
      await pool.addDenomination(value);
      break;
    case "removeDenomination":
      await pool.removeDenomination(value);
      break;
    default:
      throw new Error(`Unknown timelocked action: ${action}`);
  }
}

async function doDeposit(pool: Pool, signer: Signer, value: bigint = ONE_ETH) {
  const c = randomCommitment();
  await pool.connect(signer).deposit(c, { value });
  return c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Admin Parameter Ranges — ConfidentialPool", function () {
  // -------------------------------------------------------------------------
  // maxDepositsPerAddress
  // -------------------------------------------------------------------------

  describe("maxDepositsPerAddress", function () {
    it("can be set to 1 (minimum useful value)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxDepositsPerAddress", 1n);
      expect(await pool.maxDepositsPerAddress()).to.equal(1n);
    });

    it("can be set to max uint256", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxDepositsPerAddress", ethers.MaxUint256);
      expect(await pool.maxDepositsPerAddress()).to.equal(ethers.MaxUint256);
    });

    it("can be reset to 0 (unlimited)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxDepositsPerAddress", 5n);
      await timelockSet(pool, "setMaxDepositsPerAddress", 0n);
      expect(await pool.maxDepositsPerAddress()).to.equal(0n);
    });

    it("maxDepositsPerAddress = 1 allows only 1 deposit per address", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxDepositsPerAddress", 1n);

      await doDeposit(pool, alice);
      expect(await pool.depositsPerAddress(alice.address)).to.equal(1n);

      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");
    });

    it("emits MaxDepositsPerAddressUpdated on set", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockExecute(pool, "setMaxDepositsPerAddress", 1n);
      await expect(pool.connect(owner).setMaxDepositsPerAddress(1n))
        .to.emit(pool, "MaxDepositsPerAddressUpdated")
        .withArgs(1n);
    });

    it("emits MaxDepositsPerAddressUpdated when resetting to 0", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxDepositsPerAddress", 3n);
      await timelockExecute(pool, "setMaxDepositsPerAddress", 0n);
      await expect(pool.connect(owner).setMaxDepositsPerAddress(0n))
        .to.emit(pool, "MaxDepositsPerAddressUpdated")
        .withArgs(0n);
    });
  });

  // -------------------------------------------------------------------------
  // depositCooldown
  // -------------------------------------------------------------------------

  describe("depositCooldown", function () {
    it("can be set to 1 second (minimum non-zero value)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setDepositCooldown", 1n);
      expect(await pool.depositCooldown()).to.equal(1n);
    });

    it("can be set to 365 days (large value)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setDepositCooldown", ONE_YEAR_SECONDS);
      expect(await pool.depositCooldown()).to.equal(ONE_YEAR_SECONDS);
    });

    it("can be reset to 0 (no cooldown)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setDepositCooldown", 3600n);
      await timelockSet(pool, "setDepositCooldown", 0n);
      expect(await pool.depositCooldown()).to.equal(0n);
    });

    it("depositCooldown = 2 blocks a deposit before cooldown expires", async function () {
      // Use 2-second cooldown: Hardhat automine advances clock by 1 second per tx,
      // so the immediate next tx is at lastDepositTime + 1, still within 2-second window.
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setDepositCooldown", 2n);

      await doDeposit(pool, alice);

      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");
    });

    it("depositCooldown = 1 allows deposit after 1 second has elapsed", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setDepositCooldown", 1n);

      await doDeposit(pool, alice);
      await time.increase(2); // advance past cooldown
      await doDeposit(pool, alice);

      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("emits DepositCooldownUpdated on set", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockExecute(pool, "setDepositCooldown", 60n);
      await expect(pool.connect(owner).setDepositCooldown(60n))
        .to.emit(pool, "DepositCooldownUpdated")
        .withArgs(60n);
    });
  });

  // -------------------------------------------------------------------------
  // maxWithdrawAmount
  // -------------------------------------------------------------------------

  describe("maxWithdrawAmount", function () {
    it("defaults to 0 (no cap)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.maxWithdrawAmount()).to.equal(0n);
    });

    it("can be set to 1 wei (minimum non-zero value)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxWithdrawAmount", 1n);
      expect(await pool.maxWithdrawAmount()).to.equal(1n);
    });

    it("can be set to max uint256", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxWithdrawAmount", ethers.MaxUint256);
      expect(await pool.maxWithdrawAmount()).to.equal(ethers.MaxUint256);
    });

    it("can be reset to 0 (no cap)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxWithdrawAmount", ONE_ETH);
      await timelockSet(pool, "setMaxWithdrawAmount", 0n);
      expect(await pool.maxWithdrawAmount()).to.equal(0n);
    });

    it("emits MaxWithdrawAmountUpdated on set", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockExecute(pool, "setMaxWithdrawAmount", ONE_ETH);
      await expect(pool.connect(owner).setMaxWithdrawAmount(ONE_ETH))
        .to.emit(pool, "MaxWithdrawAmountUpdated")
        .withArgs(ONE_ETH);
    });

    it("emits MaxWithdrawAmountUpdated when resetting to 0", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMaxWithdrawAmount", ONE_ETH);
      await timelockExecute(pool, "setMaxWithdrawAmount", 0n);
      await expect(pool.connect(owner).setMaxWithdrawAmount(0n))
        .to.emit(pool, "MaxWithdrawAmountUpdated")
        .withArgs(0n);
    });
  });

  // -------------------------------------------------------------------------
  // minDepositAge
  // -------------------------------------------------------------------------

  describe("minDepositAge", function () {
    it("defaults to 0 (no age restriction)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.minDepositAge()).to.equal(0n);
    });

    it("can be set to 1 block (minimum non-zero value)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMinDepositAge", 1n);
      expect(await pool.minDepositAge()).to.equal(1n);
    });

    it("can be set to a large value (1 million blocks)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMinDepositAge", 1_000_000n);
      expect(await pool.minDepositAge()).to.equal(1_000_000n);
    });

    it("can be reset to 0 (no restriction)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMinDepositAge", 100n);
      await timelockSet(pool, "setMinDepositAge", 0n);
      expect(await pool.minDepositAge()).to.equal(0n);
    });

    it("emits MinDepositAgeUpdated on set", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockExecute(pool, "setMinDepositAge", 10n);
      await expect(pool.connect(owner).setMinDepositAge(10n))
        .to.emit(pool, "MinDepositAgeUpdated")
        .withArgs(10n);
    });

    it("emits MinDepositAgeUpdated when resetting to 0", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "setMinDepositAge", 50n);
      await timelockExecute(pool, "setMinDepositAge", 0n);
      await expect(pool.connect(owner).setMinDepositAge(0n))
        .to.emit(pool, "MinDepositAgeUpdated")
        .withArgs(0n);
    });
  });

  // -------------------------------------------------------------------------
  // maxOperationsPerBlock
  // -------------------------------------------------------------------------

  describe("maxOperationsPerBlock", function () {
    it("defaults to 0 (unlimited)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.maxOperationsPerBlock()).to.equal(0n);
    });

    it("can be set to 1 (minimum useful value)", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(1n);
      expect(await pool.maxOperationsPerBlock()).to.equal(1n);
    });

    it("can be set to max uint256", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(ethers.MaxUint256);
      expect(await pool.maxOperationsPerBlock()).to.equal(ethers.MaxUint256);
    });

    it("can be reset to 0 (unlimited)", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(5n);
      await pool.connect(owner).setMaxOperationsPerBlock(0n);
      expect(await pool.maxOperationsPerBlock()).to.equal(0n);
    });

    it("does not require timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setMaxOperationsPerBlock(3n)).to.not.be.reverted;
    });

    it("emits MaxOperationsPerBlockUpdated on set", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setMaxOperationsPerBlock(7n))
        .to.emit(pool, "MaxOperationsPerBlockUpdated")
        .withArgs(7n);
    });

    it("emits MaxOperationsPerBlockUpdated when resetting to 0", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(5n);
      await expect(pool.connect(owner).setMaxOperationsPerBlock(0n))
        .to.emit(pool, "MaxOperationsPerBlockUpdated")
        .withArgs(0n);
    });

    it("setting to 1 blocks a second deposit in the same block", async function () {
      // Verify that maxOperationsPerBlock = 1 limits deposits via batchDeposit of size 2
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(1n);

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 2n })
      ).to.be.revertedWith("ConfidentialPool: block operation limit");
    });
  });

  // -------------------------------------------------------------------------
  // denomination add/remove cycles
  // -------------------------------------------------------------------------

  describe("denomination add/remove cycles", function () {
    it("can add a denomination of 1 wei (minimum)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", 1n);
      expect(await pool.allowedDenominations(1n)).to.equal(true);
    });

    it("can add a denomination of max uint256", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ethers.MaxUint256);
      expect(await pool.allowedDenominations(ethers.MaxUint256)).to.equal(true);
    });

    it("can add multiple denominations in sequence", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ONE_ETH);
      await timelockSet(pool, "addDenomination", ONE_ETH / 2n);
      expect(await pool.allowedDenominations(ONE_ETH)).to.equal(true);
      expect(await pool.allowedDenominations(ONE_ETH / 2n)).to.equal(true);
    });

    it("reverts when adding 0 as a denomination", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockExecute(pool, "addDenomination", 0n);
      await expect(pool.addDenomination(0n)).to.be.revertedWith(
        "ConfidentialPool: zero denomination"
      );
    });

    it("reverts when adding a denomination that already exists", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ONE_ETH);
      await timelockExecute(pool, "addDenomination", ONE_ETH);
      await expect(pool.addDenomination(ONE_ETH)).to.be.revertedWith(
        "ConfidentialPool: denomination exists"
      );
    });

    it("emits DenominationAdded on add", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockExecute(pool, "addDenomination", ONE_ETH);
      await expect(pool.connect(owner).addDenomination(ONE_ETH))
        .to.emit(pool, "DenominationAdded")
        .withArgs(ONE_ETH);
    });

    it("can remove a denomination after adding it", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ONE_ETH);
      await timelockSet(pool, "removeDenomination", ONE_ETH);
      expect(await pool.allowedDenominations(ONE_ETH)).to.equal(false);
    });

    it("denomination remains in getDenominations() list after removal", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ONE_ETH);
      await timelockSet(pool, "removeDenomination", ONE_ETH);
      const list = await pool.getDenominations();
      expect(list).to.include(ONE_ETH);
    });

    it("reverts when removing a denomination that was never added", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockExecute(pool, "removeDenomination", ONE_GWEI);
      await expect(pool.removeDenomination(ONE_GWEI)).to.be.revertedWith(
        "ConfidentialPool: denomination not found"
      );
    });

    it("emits DenominationRemoved on removal", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ONE_ETH);
      await timelockExecute(pool, "removeDenomination", ONE_ETH);
      await expect(pool.connect(owner).removeDenomination(ONE_ETH))
        .to.emit(pool, "DenominationRemoved")
        .withArgs(ONE_ETH);
    });

    it("add-remove-re-add cycle works correctly", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ONE_ETH);
      await timelockSet(pool, "removeDenomination", ONE_ETH);
      expect(await pool.allowedDenominations(ONE_ETH)).to.equal(false);

      // Re-add is allowed because allowedDenominations[ONE_ETH] is now false
      await timelockSet(pool, "addDenomination", ONE_ETH);
      expect(await pool.allowedDenominations(ONE_ETH)).to.equal(true);
    });

    it("when denomination list is non-empty deposit must match an allowed denomination", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ONE_ETH);

      // Wrong amount is rejected
      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH / 2n })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });

    it("after all denominations removed deposit accepts any amount again", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await timelockSet(pool, "addDenomination", ONE_ETH);
      await timelockSet(pool, "removeDenomination", ONE_ETH);

      // Denomination list length is still 1 but allowedDenominations[ONE_ETH] = false.
      // A deposit with ONE_ETH / 2 should be rejected because the list is non-empty.
      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH / 2n })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });
  });

  // -------------------------------------------------------------------------
  // allowlist enable/disable cycles
  // -------------------------------------------------------------------------

  describe("allowlist enable/disable cycles", function () {
    it("allowlistEnabled defaults to false", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.allowlistEnabled()).to.equal(false);
    });

    it("owner can enable the allowlist", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      expect(await pool.allowlistEnabled()).to.equal(true);
    });

    it("owner can disable the allowlist after enabling", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlistEnabled(false);
      expect(await pool.allowlistEnabled()).to.equal(false);
    });

    it("does not require timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setAllowlistEnabled(true)).to.not.be.reverted;
    });

    it("emits AllowlistToggled on enable", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setAllowlistEnabled(true))
        .to.emit(pool, "AllowlistToggled")
        .withArgs(true);
    });

    it("emits AllowlistToggled on disable", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await expect(pool.connect(owner).setAllowlistEnabled(false))
        .to.emit(pool, "AllowlistToggled")
        .withArgs(false);
    });

    it("non-allowlisted address is blocked when allowlist is enabled", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);

      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });

    it("allowlisted address can deposit when allowlist is enabled", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);

      await expect(doDeposit(pool, alice)).to.not.be.reverted;
    });

    it("revoking allowlist entry blocks further deposits", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);
      await doDeposit(pool, alice); // succeeds

      // Revoke
      await pool.connect(owner).setAllowlisted(alice.address, false);

      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });

    it("disabling allowlist re-enables unrestricted deposits", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);

      // Alice blocked initially
      const c1 = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c1, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");

      // Disable allowlist
      await pool.connect(owner).setAllowlistEnabled(false);

      // Alice can now deposit freely
      await expect(doDeposit(pool, alice)).to.not.be.reverted;
    });

    it("only owner can toggle allowlist", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setAllowlistEnabled(true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("only owner can update allowlist entries", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setAllowlisted(bob.address, true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // depositReceipt
  // -------------------------------------------------------------------------

  describe("depositReceipt", function () {
    it("depositReceipt defaults to address(0)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.depositReceipt()).to.equal(ethers.ZeroAddress);
    });

    it("can be set to a valid contract address", async function () {
      const { pool, owner, receipt } = await loadFixture(deployPoolWithReceiptFixture);
      const receiptAddr = await receipt.getAddress();
      await pool.connect(owner).setDepositReceipt(receiptAddr);
      expect(await pool.depositReceipt()).to.equal(receiptAddr);
    });

    it("can be unset to address(0)", async function () {
      const { pool, owner, receipt } = await loadFixture(deployPoolWithReceiptFixture);
      await pool.connect(owner).setDepositReceipt(await receipt.getAddress());
      await pool.connect(owner).setDepositReceipt(ethers.ZeroAddress);
      expect(await pool.depositReceipt()).to.equal(ethers.ZeroAddress);
    });

    it("does not require timelock", async function () {
      const { pool, owner, receipt } = await loadFixture(deployPoolWithReceiptFixture);
      const addr = await receipt.getAddress();
      await expect(pool.connect(owner).setDepositReceipt(addr)).to.not.be.reverted;
    });

    it("emits DepositReceiptSet when setting a contract", async function () {
      const { pool, owner, receipt } = await loadFixture(deployPoolWithReceiptFixture);
      const addr = await receipt.getAddress();
      await expect(pool.connect(owner).setDepositReceipt(addr))
        .to.emit(pool, "DepositReceiptSet")
        .withArgs(addr);
    });

    it("emits DepositReceiptSet when unsetting to address(0)", async function () {
      const { pool, owner, receipt } = await loadFixture(deployPoolWithReceiptFixture);
      await pool.connect(owner).setDepositReceipt(await receipt.getAddress());
      await expect(pool.connect(owner).setDepositReceipt(ethers.ZeroAddress))
        .to.emit(pool, "DepositReceiptSet")
        .withArgs(ethers.ZeroAddress);
    });

    it("setting depositReceipt to EOA does not revert on the setter call", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setDepositReceipt(alice.address)).to.not.be.reverted;
      expect(await pool.depositReceipt()).to.equal(alice.address);
    });

    it("setting depositReceipt to EOA reverts on deposit (mint call fails)", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setDepositReceipt(alice.address);

      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.reverted;
    });

    it("changing depositReceipt to a new contract works", async function () {
      const { pool, owner, receipt } = await loadFixture(deployPoolWithReceiptFixture);
      const firstAddr = await receipt.getAddress();
      await pool.connect(owner).setDepositReceipt(firstAddr);
      expect(await pool.depositReceipt()).to.equal(firstAddr);

      // Deploy second receipt
      const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receipt2 = (await DepositReceiptFactory.deploy(
        await pool.getAddress()
      )) as unknown as DepositReceipt;
      const secondAddr = await receipt2.getAddress();

      await pool.connect(owner).setDepositReceipt(secondAddr);
      expect(await pool.depositReceipt()).to.equal(secondAddr);
    });

    it("only owner can set depositReceipt", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setDepositReceipt(alice.address)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });
  });
});
