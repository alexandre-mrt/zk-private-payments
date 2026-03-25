import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_ETH = ethers.parseEther("1");
const COOLDOWN = 60; // seconds
const DEPOSIT_LIMIT = 3n;
const BLOCK_LIMIT = 2n;
const MIN_AGE = 2n; // blocks
// operationsPerBlock is a mapping at storage slot 19 (verified in blockRateLimit.test.ts)
const OPERATIONS_PER_BLOCK_SLOT = 19;

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
// Fixtures
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

async function deployPoolFalseTransferFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const hasherAddress = await deployHasher();
  const FalseTransfer = await ethers.getContractFactory("MockFalseTransferVerifier");
  const falseTransfer = await FalseTransfer.deploy();
  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();
  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await falseTransfer.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  );
  return { pool, owner, alice, bob };
}

async function deployPoolFalseWithdrawFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const hasherAddress = await deployHasher();
  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();
  const FalseWithdraw = await ethers.getContractFactory("MockFalseWithdrawVerifier");
  const falseWithdraw = await FalseWithdraw.deploy();
  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await falseWithdraw.getAddress(),
    5,
    hasherAddress
  );
  return { pool, owner, alice, bob };
}

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function timelockAndExecute(pool: Pool, action: string, value: bigint): Promise<void> {
  await pool.queueAction(timelockHash(action, value));
  await time.increase(86401); // 1 day + 1 second
}

async function setCooldown(pool: Pool, cooldown: bigint): Promise<void> {
  await timelockAndExecute(pool, "setDepositCooldown", cooldown);
  await pool.setDepositCooldown(cooldown);
}

async function setDepositLimit(pool: Pool, max: bigint): Promise<void> {
  await timelockAndExecute(pool, "setMaxDepositsPerAddress", max);
  await pool.setMaxDepositsPerAddress(max);
}

async function addDenomination(pool: Pool, value: bigint): Promise<void> {
  await timelockAndExecute(pool, "addDenomination", value);
  await pool.addDenomination(value);
}

async function setMinDepositAge(pool: Pool, age: bigint): Promise<void> {
  await timelockAndExecute(pool, "setMinDepositAge", age);
  await pool.setMinDepositAge(age);
}

async function doDeposit(pool: Pool, signer: Awaited<ReturnType<typeof deployPoolFixture>>["alice"], value: bigint = ONE_ETH): Promise<bigint> {
  const c = randomCommitment();
  await pool.connect(signer).deposit(c, { value });
  return c;
}

/**
 * Pre-fill operationsPerBlock[nextBlock] to `count` via direct storage manipulation,
 * so that the next transaction in that block sees the counter already at `count`.
 */
async function prefillBlockCounter(pool: Pool, count: bigint): Promise<void> {
  const poolAddr = await pool.getAddress();
  const nextBlock = (await ethers.provider.getBlockNumber()) + 1;
  const storageKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256"],
      [nextBlock, OPERATIONS_PER_BLOCK_SLOT]
    )
  );
  await network.provider.send("hardhat_setStorageAt", [
    poolAddr,
    storageKey,
    ethers.zeroPadValue(ethers.toBeHex(count), 32),
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Rate Limit Interactions", function () {
  // -------------------------------------------------------------------------
  // Cooldown + deposit limit
  // -------------------------------------------------------------------------

  describe("Cooldown + deposit limit", function () {
    it("cooldown applies even when under deposit limit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await setCooldown(pool, BigInt(COOLDOWN));
      await setDepositLimit(pool, DEPOSIT_LIMIT);

      // First deposit succeeds
      await doDeposit(pool, alice);
      expect(await pool.depositsPerAddress(alice.address)).to.equal(1n);

      // Immediate second deposit is below deposit limit (limit is 3) but hits cooldown
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");
    });

    it("deposit limit applies even when cooldown has passed", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await setCooldown(pool, BigInt(COOLDOWN));
      await setDepositLimit(pool, 1n);

      // First deposit uses the single allowed slot
      await doDeposit(pool, alice);

      // Wait out the cooldown
      await time.increase(COOLDOWN + 1);

      // Cooldown has passed but deposit limit is exhausted
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");
    });

    it("both cooldown and limit can block simultaneously", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await setCooldown(pool, BigInt(COOLDOWN));
      await setDepositLimit(pool, 1n);

      // Fill the deposit limit
      await doDeposit(pool, alice);

      // Immediate next deposit: cooldown is active AND limit is reached.
      // Contract checks deposit limit before cooldown (per source order in deposit()),
      // so we expect the deposit limit revert.
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown + batchDeposit
  // -------------------------------------------------------------------------

  describe("Cooldown + batchDeposit", function () {
    it("cooldown blocks batchDeposit if too soon after a prior deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await setCooldown(pool, BigInt(COOLDOWN));

      // Single deposit starts the cooldown timer
      await doDeposit(pool, alice);

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 2n })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");
    });

    it("batchDeposit updates lastDepositTime so subsequent deposit respects new cooldown start", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await setCooldown(pool, BigInt(COOLDOWN));

      // Wait past any residual cooldown, then do a batchDeposit
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 2n });

      const batchTime = await pool.lastDepositTime(alice.address);

      // Immediate single deposit after batch must be blocked (cooldown reset by batch)
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");

      // After waiting the cooldown, single deposit succeeds and timestamp advances
      await time.increase(COOLDOWN + 1);
      await doDeposit(pool, alice);
      const afterTime = await pool.lastDepositTime(alice.address);
      expect(afterTime).to.be.greaterThan(batchTime);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit + deposit
  // -------------------------------------------------------------------------

  describe("Rate limit + deposit", function () {
    it("maxOperationsPerBlock blocks excess deposits in same block", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(BLOCK_LIMIT);

      // Pre-fill the counter for the next block to the limit
      await prefillBlockCounter(pool, BLOCK_LIMIT);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: block operation limit");
    });

    it("rate limit resets on a new block", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(1n);

      // First deposit: counter goes to 1 (at limit for that block)
      const tx1 = await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      const r1 = await tx1.wait();

      // Second deposit is mined in a new block (automining is on), counter resets to 0 then 1
      const tx2 = await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      const r2 = await tx2.wait();

      expect(r1!.blockNumber).to.not.equal(r2!.blockNumber);
      expect(await pool.operationsPerBlock(r2!.blockNumber)).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit + batchDeposit
  // -------------------------------------------------------------------------

  describe("Rate limit + batchDeposit", function () {
    it("batchDeposit of 3 counts as 3 operations", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH, ONE_ETH];
      const tx = await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: ONE_ETH * 3n,
      });
      const receipt = await tx.wait();
      expect(await pool.operationsPerBlock(receipt!.blockNumber)).to.equal(3n);
    });

    it("batchDeposit exceeding block limit reverts", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      // Limit is 2, batch of 3 exceeds it
      await pool.connect(owner).setMaxOperationsPerBlock(2n);

      const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH, ONE_ETH];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 3n })
      ).to.be.revertedWith("ConfidentialPool: block operation limit");
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit + transfer
  // -------------------------------------------------------------------------

  describe("Rate limit + transfer", function () {
    // We use MockFalseTransferVerifier so the proof always fails.
    // The rate-limit check runs BEFORE the proof check, so when the block counter
    // is already at the limit the revert must be the block-limit error, not the proof error.

    it("transfer counts as 1 operation toward the block limit", async function () {
      // We can't forge a valid proof, so we verify indirectly:
      // set limit = 1, pre-fill counter to 1, then call transfer.
      // If the block-limit check fires before the proof check, we get the rate-limit revert.
      const { pool, owner, alice } = await loadFixture(deployPoolFalseTransferFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(1n);

      // Deposit a note to populate the tree (allowlist is off by default)
      const commitment = randomCommitment();
      await pool.connect(owner).deposit(commitment, { value: ONE_ETH });
      const root = await pool.getLastRoot();

      // Pre-fill block counter to the limit for the next block
      await prefillBlockCounter(pool, 1n);

      const ZERO_PROOF = {
        pA: [0n, 0n] as [bigint, bigint],
        pB: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
        pC: [0n, 0n] as [bigint, bigint],
      };

      // Must revert with block-limit error, not proof error
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
      ).to.be.revertedWith("ConfidentialPool: block operation limit");
    });

    it("rate limit applies to transfer: transfer after limit is set but counter below limit reaches proof check", async function () {
      // counter is 0, limit is 1 → transfer is allowed past rate limit,
      // then fails at proof (MockFalseTransferVerifier returns false).
      const { pool, owner, alice } = await loadFixture(deployPoolFalseTransferFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(1n);

      const commitment = randomCommitment();
      await pool.connect(owner).deposit(commitment, { value: ONE_ETH });
      const root = await pool.getLastRoot();

      const ZERO_PROOF = {
        pA: [0n, 0n] as [bigint, bigint],
        pB: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
        pC: [0n, 0n] as [bigint, bigint],
      };

      // Block counter is 0 < limit 1 → passes rate limit, fails at proof
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
  // Rate limit + withdraw
  // -------------------------------------------------------------------------

  describe("Rate limit + withdraw", function () {
    it("withdrawal counts as 1 operation: block-limit revert fires before proof check", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFalseWithdrawFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(1n);

      // Deposit to populate the tree
      await pool.connect(owner).deposit(randomCommitment(), { value: ONE_ETH });
      const root = await pool.getLastRoot();

      // Pre-fill block counter to the limit for the next block
      await prefillBlockCounter(pool, 1n);

      const ZERO_PROOF = {
        pA: [0n, 0n] as [bigint, bigint],
        pB: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
        pC: [0n, 0n] as [bigint, bigint],
      };

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
      ).to.be.revertedWith("ConfidentialPool: block operation limit");
    });
  });

  // -------------------------------------------------------------------------
  // minDepositAge + withdrawal
  // -------------------------------------------------------------------------

  describe("minDepositAge + withdrawal", function () {
    it("minDepositAge blocks withdrawal right after deposit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFalseWithdrawFixture);
      await setMinDepositAge(pool, MIN_AGE);

      // Deposit in the current block (updates lastDepositBlock)
      await pool.connect(owner).deposit(randomCommitment(), { value: ONE_ETH });
      const root = await pool.getLastRoot();

      const ZERO_PROOF = {
        pA: [0n, 0n] as [bigint, bigint],
        pB: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
        pC: [0n, 0n] as [bigint, bigint],
      };

      // Withdraw is in the same or immediately next block — too soon
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
      ).to.be.revertedWith("ConfidentialPool: withdrawal too soon after last deposit");
    });

    it("withdrawal reaches proof check after minDepositAge blocks have passed", async function () {
      // After enough blocks the minDepositAge check passes; then it fails at proof
      // (MockFalseWithdrawVerifier). This confirms the age gate is no longer blocking.
      const { pool, owner, alice } = await loadFixture(deployPoolFalseWithdrawFixture);
      await setMinDepositAge(pool, MIN_AGE);

      await pool.connect(owner).deposit(randomCommitment(), { value: ONE_ETH });
      const depositBlock = await ethers.provider.getBlockNumber();
      const root = await pool.getLastRoot();

      // Mine enough blocks to satisfy minDepositAge
      const blocksNeeded = Number(MIN_AGE);
      for (let i = 0; i < blocksNeeded; i++) {
        await network.provider.send("evm_mine", []);
      }

      const currentBlock = await ethers.provider.getBlockNumber();
      expect(currentBlock).to.be.gte(depositBlock + blocksNeeded);

      const ZERO_PROOF = {
        pA: [0n, 0n] as [bigint, bigint],
        pB: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]],
        pC: [0n, 0n] as [bigint, bigint],
      };

      // Age check passes; fails at proof verification instead
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
  // All limits combined
  // -------------------------------------------------------------------------

  describe("All limits combined", function () {
    it("deposit passes cooldown + limit + denomination + allowlist only when all conditions are met", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      // Enable allowlist and add alice
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);

      // Set deposit limit and cooldown (both require timelock)
      await setCooldown(pool, BigInt(COOLDOWN));
      await setDepositLimit(pool, DEPOSIT_LIMIT);

      // Add a denomination
      await addDenomination(pool, ONE_ETH);

      // All conditions satisfied: first deposit succeeds
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.emit(pool, "Deposit");

      expect(await pool.depositsPerAddress(alice.address)).to.equal(1n);

      // Wrong denomination fails the denomination check
      await time.increase(COOLDOWN + 1);
      const wrongAmount = ethers.parseEther("0.5");
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: wrongAmount })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");

      // Correct denomination but cooldown not elapsed fails the cooldown check
      // (first do a deposit to reset the timer)
      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");

      // Remove alice from allowlist: blocked by allowlist before reaching other checks
      await time.increase(COOLDOWN + 1);
      await pool.connect(owner).setAllowlisted(alice.address, false);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  });
});
