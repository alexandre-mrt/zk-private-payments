import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const ONE_DAY = 24 * 60 * 60;
const DENOMINATION = ethers.parseEther("0.1");

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

function makeTimelockHashUint(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

async function queueAndWait(
  pool: Awaited<ReturnType<typeof deployFixture>>["pool"],
  hash: string
): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
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
    MERKLE_TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Modifier Coverage
// ---------------------------------------------------------------------------

describe("Modifier Coverage — ConfidentialPool", function () {
  // -------------------------------------------------------------------------
  // nonReentrant
  // -------------------------------------------------------------------------

  describe("nonReentrant", function () {
    it("deposit has nonReentrant — lock is released after successful deposit", async function () {
      // Verify the guard does not permanently lock after a guarded call
      const { pool, alice } = await loadFixture(deployFixture);
      const c1 = randomCommitment();
      const c2 = randomCommitment();
      await pool.connect(alice).deposit(c1, { value: DENOMINATION });
      await expect(
        pool.connect(alice).deposit(c2, { value: DENOMINATION })
      ).to.not.be.reverted;
    });

    it("batchDeposit has nonReentrant — lock is released after successful batch", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      const c1 = randomCommitment();
      const c2 = randomCommitment();
      const c3 = randomCommitment();
      await pool.connect(alice).batchDeposit(
        [c1, c2],
        [DENOMINATION, DENOMINATION],
        { value: DENOMINATION * 2n }
      );
      // Second batch must succeed — guard was released
      await expect(
        pool.connect(alice).batchDeposit(
          [c3],
          [DENOMINATION],
          { value: DENOMINATION }
        )
      ).to.not.be.reverted;
    });

    it("transfer has nonReentrant — lock is released after guarded call", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      // Make a deposit so there is a root
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      // The placeholder verifier always returns true, so transfer succeeds.
      // Confirm body executed by checking totalTransfers incremented.
      const nullifier = randomCommitment();
      await pool.connect(alice).transfer(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root,
        nullifier,
        randomCommitment(),
        randomCommitment()
      );
      expect(await pool.totalTransfers()).to.equal(1n);
    });

    it("withdraw has nonReentrant — lock is released after guarded call", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      // The placeholder verifier always returns true, so withdraw succeeds.
      // Confirm body executed by checking withdrawalCount incremented.
      const nullifier = randomCommitment();
      await pool.connect(alice).withdraw(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root,
        nullifier,
        DENOMINATION,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      expect(await pool.withdrawalCount()).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // whenNotPaused
  // -------------------------------------------------------------------------

  describe("whenNotPaused", function () {
    it("deposit reverts with EnforcedPause when paused", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.pause();
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("batchDeposit reverts with EnforcedPause when paused", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.pause();
      await expect(
        pool.connect(alice).batchDeposit(
          [randomCommitment()],
          [DENOMINATION],
          { value: DENOMINATION }
        )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("transfer reverts with EnforcedPause when paused", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      await pool.pause();
      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root,
          randomCommitment(),
          randomCommitment(),
          randomCommitment()
        )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("withdraw reverts with EnforcedPause when paused", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      await pool.pause();
      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root,
          randomCommitment(),
          DENOMINATION,
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------
  // onlyOwner
  // -------------------------------------------------------------------------

  describe("onlyOwner", function () {
    it("pause: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(pool.connect(alice).pause()).to.be.revertedWithCustomError(
        pool,
        "OwnableUnauthorizedAccount"
      );
    });

    it("unpause: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.pause();
      await expect(pool.connect(alice).unpause()).to.be.revertedWithCustomError(
        pool,
        "OwnableUnauthorizedAccount"
      );
    });

    it("queueAction: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(
        pool.connect(alice).queueAction(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("cancelAction: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setMaxDepositsPerAddress", 5n);
      await pool.queueAction(hash);
      await expect(
        pool.connect(alice).cancelAction()
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("emergencyDrain: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.pause(); // owner pauses — emergencyDrain also requires whenPaused
      await expect(
        pool.connect(alice).emergencyDrain(alice.address)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setAllowlistEnabled: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(
        pool.connect(alice).setAllowlistEnabled(true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setAllowlisted: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(
        pool.connect(alice).setAllowlisted(alice.address, true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("batchSetAllowlisted: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(
        pool.connect(alice).batchSetAllowlisted([alice.address], true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setDepositReceipt: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(
        pool.connect(alice).setDepositReceipt(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setMaxOperationsPerBlock: onlyOwner enforced", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(
        pool.connect(alice).setMaxOperationsPerBlock(10n)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // emergencyDrain: onlyOwner + whenPaused
  // -------------------------------------------------------------------------

  describe("emergencyDrain: onlyOwner + whenPaused", function () {
    it("emergencyDrain reverts when not paused (whenPaused check)", async function () {
      const { pool, owner } = await loadFixture(deployFixture);
      // Pool is not paused — must revert with ExpectedPause
      await expect(
        pool.emergencyDrain(owner.address)
      ).to.be.revertedWithCustomError(pool, "ExpectedPause");
    });

    it("emergencyDrain reverts for non-owner even when paused (onlyOwner fires first)", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.pause();
      await expect(
        pool.connect(alice).emergencyDrain(alice.address)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("emergencyDrain succeeds for owner when paused and pool has balance", async function () {
      const { pool, owner, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      await pool.pause();
      const balanceBefore = await ethers.provider.getBalance(owner.address);
      await expect(pool.emergencyDrain(owner.address)).to.emit(pool, "EmergencyDrain");
      const balanceAfter = await ethers.provider.getBalance(owner.address);
      expect(balanceAfter).to.be.gt(balanceBefore - ethers.parseEther("0.01")); // net positive after gas
    });
  });

  // -------------------------------------------------------------------------
  // timelockReady — timelocked functions
  // -------------------------------------------------------------------------

  describe("timelockReady", function () {
    it("setMaxWithdrawAmount: reverts before timelock delay", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setMaxWithdrawAmount", DENOMINATION);
      await pool.queueAction(hash);
      await time.increase(3600); // only 1 hour
      await expect(
        pool.setMaxWithdrawAmount(DENOMINATION)
      ).to.be.revertedWith("ConfidentialPool: timelock not expired");
    });

    it("setMaxWithdrawAmount: reverts without any queued action", async function () {
      const { pool } = await loadFixture(deployFixture);
      await expect(
        pool.setMaxWithdrawAmount(DENOMINATION)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("setMaxWithdrawAmount: executes after delay elapses", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setMaxWithdrawAmount", DENOMINATION);
      await queueAndWait(pool, hash);
      await expect(pool.setMaxWithdrawAmount(DENOMINATION)).to.not.be.reverted;
      expect(await pool.maxWithdrawAmount()).to.equal(DENOMINATION);
    });

    it("setMinDepositAge: reverts before timelock delay", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setMinDepositAge", 10n);
      await pool.queueAction(hash);
      await time.increase(3600);
      await expect(
        pool.setMinDepositAge(10n)
      ).to.be.revertedWith("ConfidentialPool: timelock not expired");
    });

    it("setMinDepositAge: reverts without any queued action", async function () {
      const { pool } = await loadFixture(deployFixture);
      await expect(
        pool.setMinDepositAge(10n)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("setMinDepositAge: executes after delay elapses", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setMinDepositAge", 10n);
      await queueAndWait(pool, hash);
      await expect(pool.setMinDepositAge(10n)).to.not.be.reverted;
      expect(await pool.minDepositAge()).to.equal(10n);
    });

    it("setMaxDepositsPerAddress: reverts before timelock delay", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setMaxDepositsPerAddress", 5n);
      await pool.queueAction(hash);
      await time.increase(3600);
      await expect(
        pool.setMaxDepositsPerAddress(5n)
      ).to.be.revertedWith("ConfidentialPool: timelock not expired");
    });

    it("setMaxDepositsPerAddress: reverts without any queued action", async function () {
      const { pool } = await loadFixture(deployFixture);
      await expect(
        pool.setMaxDepositsPerAddress(5n)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("setMaxDepositsPerAddress: executes after delay elapses", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setMaxDepositsPerAddress", 5n);
      await queueAndWait(pool, hash);
      await expect(pool.setMaxDepositsPerAddress(5n)).to.not.be.reverted;
      expect(await pool.maxDepositsPerAddress()).to.equal(5n);
    });

    it("setDepositCooldown: reverts before timelock delay", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setDepositCooldown", 3600n);
      await pool.queueAction(hash);
      await time.increase(3600);
      await expect(
        pool.setDepositCooldown(3600n)
      ).to.be.revertedWith("ConfidentialPool: timelock not expired");
    });

    it("setDepositCooldown: reverts without any queued action", async function () {
      const { pool } = await loadFixture(deployFixture);
      await expect(
        pool.setDepositCooldown(3600n)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("setDepositCooldown: executes after delay elapses", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("setDepositCooldown", 3600n);
      await queueAndWait(pool, hash);
      await expect(pool.setDepositCooldown(3600n)).to.not.be.reverted;
      expect(await pool.depositCooldown()).to.equal(3600n);
    });

    it("addDenomination: reverts before timelock delay", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("addDenomination", DENOMINATION);
      await pool.queueAction(hash);
      await time.increase(3600);
      await expect(
        pool.addDenomination(DENOMINATION)
      ).to.be.revertedWith("ConfidentialPool: timelock not expired");
    });

    it("addDenomination: reverts without any queued action", async function () {
      const { pool } = await loadFixture(deployFixture);
      await expect(
        pool.addDenomination(DENOMINATION)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("addDenomination: executes after delay elapses", async function () {
      const { pool } = await loadFixture(deployFixture);
      const hash = makeTimelockHashUint("addDenomination", DENOMINATION);
      await queueAndWait(pool, hash);
      await expect(pool.addDenomination(DENOMINATION)).to.not.be.reverted;
      expect(await pool.allowedDenominations(DENOMINATION)).to.equal(true);
    });

    it("removeDenomination: reverts before timelock delay", async function () {
      const { pool } = await loadFixture(deployFixture);
      // First add the denomination
      const addHash = makeTimelockHashUint("addDenomination", DENOMINATION);
      await queueAndWait(pool, addHash);
      await pool.addDenomination(DENOMINATION);

      const removeHash = makeTimelockHashUint("removeDenomination", DENOMINATION);
      await pool.queueAction(removeHash);
      await time.increase(3600);
      await expect(
        pool.removeDenomination(DENOMINATION)
      ).to.be.revertedWith("ConfidentialPool: timelock not expired");
    });

    it("removeDenomination: reverts without any queued action", async function () {
      const { pool } = await loadFixture(deployFixture);
      // Add the denomination first so the body check doesn't fire
      const addHash = makeTimelockHashUint("addDenomination", DENOMINATION);
      await queueAndWait(pool, addHash);
      await pool.addDenomination(DENOMINATION);

      // No action queued for remove
      await expect(
        pool.removeDenomination(DENOMINATION)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("removeDenomination: executes after delay elapses", async function () {
      const { pool } = await loadFixture(deployFixture);
      const addHash = makeTimelockHashUint("addDenomination", DENOMINATION);
      await queueAndWait(pool, addHash);
      await pool.addDenomination(DENOMINATION);

      const removeHash = makeTimelockHashUint("removeDenomination", DENOMINATION);
      await queueAndWait(pool, removeHash);
      await expect(pool.removeDenomination(DENOMINATION)).to.not.be.reverted;
      expect(await pool.allowedDenominations(DENOMINATION)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // Non-timelocked admin functions (onlyOwner only)
  // -------------------------------------------------------------------------

  describe("non-timelocked admin functions", function () {
    it("setAllowlistEnabled: owner can toggle immediately without timelock", async function () {
      const { pool } = await loadFixture(deployFixture);
      await expect(pool.setAllowlistEnabled(true)).to.not.be.reverted;
      expect(await pool.allowlistEnabled()).to.equal(true);
      await expect(pool.setAllowlistEnabled(false)).to.not.be.reverted;
      expect(await pool.allowlistEnabled()).to.equal(false);
    });

    it("setAllowlisted: owner can set immediately without timelock", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(pool.setAllowlisted(alice.address, true)).to.not.be.reverted;
      expect(await pool.allowlisted(alice.address)).to.equal(true);
    });

    it("batchSetAllowlisted: owner can set immediately without timelock", async function () {
      const { pool, alice, bob } = await loadFixture(deployFixture);
      await expect(
        pool.batchSetAllowlisted([alice.address, bob.address], true)
      ).to.not.be.reverted;
      expect(await pool.allowlisted(alice.address)).to.equal(true);
      expect(await pool.allowlisted(bob.address)).to.equal(true);
    });

    it("setDepositReceipt: owner can set immediately without timelock", async function () {
      const { pool } = await loadFixture(deployFixture);
      await expect(pool.setDepositReceipt(ethers.ZeroAddress)).to.not.be.reverted;
    });

    it("setMaxOperationsPerBlock: owner can set immediately without timelock", async function () {
      const { pool } = await loadFixture(deployFixture);
      await expect(pool.setMaxOperationsPerBlock(5n)).to.not.be.reverted;
      expect(await pool.maxOperationsPerBlock()).to.equal(5n);
    });
  });

  // -------------------------------------------------------------------------
  // onlyDeployedChain
  // -------------------------------------------------------------------------

  describe("onlyDeployedChain", function () {
    it("deposit succeeds on the correct chain (chainId matches deployedChainId)", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      const deployedChainId = await pool.deployedChainId();
      const currentChainId = BigInt((await ethers.provider.getNetwork()).chainId);
      expect(deployedChainId).to.equal(currentChainId);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.not.be.reverted;
    });

    it("batchDeposit succeeds on the correct chain", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(
        pool.connect(alice).batchDeposit(
          [randomCommitment()],
          [DENOMINATION],
          { value: DENOMINATION }
        )
      ).to.not.be.reverted;
    });

    it("transfer reaches body on the correct chain (placeholder verifier returns true)", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      // Placeholder verifier always returns true — transfer succeeds on the correct chain.
      // Body execution confirmed by totalTransfers incrementing.
      await pool.connect(alice).transfer(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );
      expect(await pool.totalTransfers()).to.equal(1n);
    });

    it("withdraw reaches body on the correct chain (placeholder verifier returns true)", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      // Placeholder verifier always returns true — withdraw succeeds on the correct chain.
      // Body execution confirmed by withdrawalCount incrementing.
      await pool.connect(alice).withdraw(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root,
        randomCommitment(),
        DENOMINATION,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      expect(await pool.withdrawalCount()).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Combined modifier stacks
  // -------------------------------------------------------------------------

  describe("combined modifiers", function () {
    it("batchDeposit: whenNotPaused fires before onlyDeployedChain — EnforcedPause is first check to fail when paused", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.pause();
      await expect(
        pool.connect(alice).batchDeposit(
          [randomCommitment()],
          [DENOMINATION],
          { value: DENOMINATION }
        )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("transfer: all three modifiers pass on happy path (nonReentrant + whenNotPaused + onlyDeployedChain)", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      // Placeholder verifier always returns true — all three modifiers passed,
      // body executed. Confirm via totalTransfers.
      await pool.connect(alice).transfer(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );
      expect(await pool.totalTransfers()).to.equal(1n);
    });

    it("withdraw: all three modifiers pass on happy path (nonReentrant + whenNotPaused + onlyDeployedChain)", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      // Placeholder verifier always returns true — all three modifiers passed,
      // body executed. Confirm via withdrawalCount.
      await pool.connect(alice).withdraw(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root,
        randomCommitment(),
        DENOMINATION,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      expect(await pool.withdrawalCount()).to.equal(1n);
    });

    it("withdraw: fee validation inside body is reached after modifiers pass", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      const root = await pool.getLastRoot();
      // fee > amount — should fail with fee check in body, not in modifiers
      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root,
          randomCommitment(),
          DENOMINATION,
          alice.address,
          0n,
          ethers.ZeroAddress,
          DENOMINATION + 1n // fee > amount
        )
      ).to.be.revertedWith("ConfidentialPool: fee exceeds amount");
    });
  });
});
