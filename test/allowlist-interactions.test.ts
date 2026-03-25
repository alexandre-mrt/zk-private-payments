import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { ConfidentialPool } from "../typechain-types";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_ETH = ethers.parseEther("1");
const TWO_ETH = ethers.parseEther("2");
const HALF_ETH = ethers.parseEther("0.5");
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
  return { pool, owner, alice, bob, carol };
}

async function deployPoolWithReceiptFixture() {
  const base = await deployPoolFixture();
  const DepositReceipt = await ethers.getContractFactory("DepositReceipt");
  const receipt = await DepositReceipt.deploy(await base.pool.getAddress());
  await base.pool.setDepositReceipt(await receipt.getAddress());
  return { ...base, receipt };
}

async function deployPoolFalseTransferFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const hasherAddress = await deployHasher();
  const FalseTransfer = await ethers.getContractFactory("MockFalseTransferVerifier");
  const falseTransfer = await FalseTransfer.deploy();
  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();
  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await falseTransfer.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  )) as unknown as ConfidentialPool;
  return { pool, owner, alice, bob, carol };
}

async function deployPoolFalseWithdrawFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const hasherAddress = await deployHasher();
  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();
  const FalseWithdraw = await ethers.getContractFactory("MockFalseWithdrawVerifier");
  const falseWithdraw = await FalseWithdraw.deploy();
  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await falseWithdraw.getAddress(),
    5,
    hasherAddress
  )) as unknown as ConfidentialPool;
  return { pool, owner, alice, bob, carol };
}

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];

async function timelockAndExecute(pool: Pool, action: string, value: bigint): Promise<void> {
  await pool.queueAction(timelockHash(action, value));
  await time.increase(86401); // 1 day + 1 second
}

async function addDenomination(pool: Pool, value: bigint): Promise<void> {
  await timelockAndExecute(pool, "addDenomination", value);
  await pool.addDenomination(value);
}

async function setDepositLimit(pool: Pool, max: bigint): Promise<void> {
  await timelockAndExecute(pool, "setMaxDepositsPerAddress", max);
  await pool.setMaxDepositsPerAddress(max);
}

async function setDepositCooldown(pool: Pool, cooldown: bigint): Promise<void> {
  await timelockAndExecute(pool, "setDepositCooldown", cooldown);
  await pool.setDepositCooldown(cooldown);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Allowlist Interactions", function () {
  // -------------------------------------------------------------------------
  // Allowlist + deposit
  // -------------------------------------------------------------------------

  describe("Allowlist + deposit", function () {
    it("allowlisted user can deposit any amount", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");

      expect(await pool.depositsPerAddress(alice.address)).to.equal(1n);
    });

    it("non-allowlisted user cannot deposit when allowlist is enabled", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      // alice is NOT added to the allowlist

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });

    it("disabling allowlist allows any user to deposit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);

      // alice is blocked while enabled
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");

      // disable and verify alice can now deposit
      await pool.connect(owner).setAllowlistEnabled(false);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist + batchDeposit
  // -------------------------------------------------------------------------

  describe("Allowlist + batchDeposit", function () {
    it("allowlisted user can batchDeposit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 2n })
      ).to.emit(pool, "Deposit");

      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("non-allowlisted user cannot batchDeposit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      // alice is NOT in the allowlist

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 2n })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");

      expect(await pool.depositsPerAddress(alice.address)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist + transfer (transfers are not gated by the allowlist)
  // -------------------------------------------------------------------------

  describe("Allowlist + transfer", function () {
    it("non-allowlisted user can still transfer (not gated)", async function () {
      // The transfer function has no allowlist check. We use MockFalseTransferVerifier
      // so that the proof always fails, confirming the revert is NOT the allowlist error.
      const { pool, owner, alice } = await loadFixture(deployPoolFalseTransferFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      // alice is NOT in the allowlist

      // Deposit as owner to get a known root in the tree
      await pool.connect(owner).setAllowlistEnabled(false);
      const commitment = randomCommitment();
      await pool.connect(owner).deposit(commitment, { value: ONE_ETH });
      const root = await pool.getLastRoot();
      await pool.connect(owner).setAllowlistEnabled(true);

      const ZERO_PROOF = {
        pA: [0n, 0n] as [bigint, bigint],
        pB: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
        pC: [0n, 0n] as [bigint, bigint],
      };

      // Should fail on invalid proof, NOT on allowlist check
      await expect(
        pool.connect(alice).transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          1n,
          randomCommitment(),
          randomCommitment()
        )
      ).to.be.revertedWith("ConfidentialPool: invalid transfer proof");
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist + withdraw (withdrawals are not gated by the allowlist)
  // -------------------------------------------------------------------------

  describe("Allowlist + withdraw", function () {
    it("non-allowlisted user can still withdraw (not gated)", async function () {
      // Withdraw has no allowlist check. We use MockFalseWithdrawVerifier so
      // the proof always fails, confirming the revert is NOT the allowlist error.
      const { pool, owner, alice } = await loadFixture(deployPoolFalseWithdrawFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      // alice is NOT in the allowlist

      await pool.connect(owner).setAllowlistEnabled(false);
      await pool.connect(owner).deposit(randomCommitment(), { value: ONE_ETH });
      const root = await pool.getLastRoot();
      await pool.connect(owner).setAllowlistEnabled(true);

      const ZERO_PROOF = {
        pA: [0n, 0n] as [bigint, bigint],
        pB: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
        pC: [0n, 0n] as [bigint, bigint],
      };

      // Should fail on proof verification, NOT on allowlist
      await expect(
        pool.connect(alice).withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          1n,
          ONE_ETH,
          alice.address as unknown as Parameters<typeof pool.withdraw>[6],
          0n,
          ethers.ZeroAddress as unknown as Parameters<typeof pool.withdraw>[8],
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: invalid withdrawal proof");
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist + deposit limit
  // -------------------------------------------------------------------------

  describe("Allowlist + deposit limit", function () {
    it("allowlisted user with deposit limit can deposit up to limit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);
      await setDepositLimit(pool, 2n);

      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });

      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
      expect(await pool.getRemainingDeposits(alice.address)).to.equal(0n);
    });

    it("allowlisted user exceeding limit is still blocked", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);
      await setDepositLimit(pool, 2n);

      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });

      // Third deposit should be blocked by the limit, not the allowlist
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist + cooldown
  // -------------------------------------------------------------------------

  describe("Allowlist + cooldown", function () {
    it("allowlisted user still subject to cooldown", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);
      await setDepositCooldown(pool, BigInt(COOLDOWN));

      // First deposit succeeds
      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });

      // Immediate second deposit hits cooldown, not allowlist
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");

      // After cooldown, deposit succeeds
      await time.increase(COOLDOWN + 1);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist + denominations
  // -------------------------------------------------------------------------

  describe("Allowlist + denominations", function () {
    it("allowlisted user must use allowed denomination", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);
      await addDenomination(pool, ONE_ETH);

      // Correct denomination succeeds
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");

      // Wrong denomination blocked by denomination check, not allowlist
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: HALF_ETH })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });

    it("non-allowlisted user blocked before denomination check", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await addDenomination(pool, ONE_ETH);
      // alice is NOT allowlisted

      // The contract checks allowlist first (before denominations in deposit())
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist + deposit receipt
  // -------------------------------------------------------------------------

  describe("Allowlist + deposit receipt", function () {
    it("allowlisted deposit mints receipt NFT", async function () {
      const { pool, receipt, owner, alice } = await loadFixture(deployPoolWithReceiptFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);

      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ONE_ETH });

      expect(await receipt.ownerOf(0n)).to.equal(alice.address);
      expect(await receipt.tokenAmount(0n)).to.equal(ONE_ETH);
      expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
    });
  });

  // -------------------------------------------------------------------------
  // batchSetAllowlisted
  // -------------------------------------------------------------------------

  describe("batchSetAllowlisted", function () {
    it("batch grant allows multiple users simultaneously", async function () {
      const { pool, owner, alice, bob, carol } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);

      await pool
        .connect(owner)
        .batchSetAllowlisted([alice.address, bob.address, carol.address], true);

      expect(await pool.allowlisted(alice.address)).to.be.true;
      expect(await pool.allowlisted(bob.address)).to.be.true;
      expect(await pool.allowlisted(carol.address)).to.be.true;

      // All three can deposit
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");
      await expect(
        pool.connect(bob).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");
      await expect(
        pool.connect(carol).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");
    });

    it("batch revoke blocks multiple users simultaneously", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);

      // Grant first
      await pool.connect(owner).batchSetAllowlisted([alice.address, bob.address], true);
      expect(await pool.allowlisted(alice.address)).to.be.true;
      expect(await pool.allowlisted(bob.address)).to.be.true;

      // Revoke both in a single call
      await pool.connect(owner).batchSetAllowlisted([alice.address, bob.address], false);

      expect(await pool.allowlisted(alice.address)).to.be.false;
      expect(await pool.allowlisted(bob.address)).to.be.false;

      // Neither can deposit
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
      await expect(
        pool.connect(bob).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  });
});
