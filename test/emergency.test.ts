import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

const ONE_ETH = ethers.parseEther("1");
const THREE_ETH = ethers.parseEther("3");
const FIVE_ETH = ethers.parseEther("5");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
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

// ---------------------------------------------------------------------------
// Emergency Scenarios — incident response workflows
// ---------------------------------------------------------------------------

describe("Emergency Scenarios", function () {
  // -------------------------------------------------------------------------
  // Exploit detected: pause halts all state-mutating operations
  // -------------------------------------------------------------------------

  it("exploit detected: pause immediately stops deposits", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(owner).pause();

    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("exploit detected: pause immediately stops withdrawals", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    // Deposit before pause to have a valid root
    await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
    const root = await pool.getLastRoot();

    await pool.connect(owner).pause();

    await expect(
      pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        ONE_ETH,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      )
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("transfer blocked during pause", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
    const root = await pool.getLastRoot();

    await pool.connect(owner).pause();

    await expect(
      pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      )
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("batchDeposit blocked during pause", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(owner).pause();

    const commitments = [randomCommitment(), randomCommitment()];
    const amounts = [ONE_ETH, ONE_ETH];

    await expect(
      pool.connect(alice).batchDeposit(commitments, amounts, {
        value: ethers.parseEther("2"),
      })
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("pause doesn't affect read-only operations (getPoolStats, getPoolHealth, getLastRoot)", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
    const rootBefore = await pool.getLastRoot();
    const statsBefore = await pool.getPoolStats();

    await pool.connect(owner).pause();

    const rootAfter = await pool.getLastRoot();
    const statsAfter = await pool.getPoolStats();
    const health = await pool.getPoolHealth();
    const depositCount = await pool.getDepositCount();
    const version = await pool.getVersion();

    expect(rootAfter).to.equal(rootBefore);
    expect(statsAfter[3]).to.equal(statsBefore[3]); // depositCount unchanged
    expect(health[3]).to.be.true; // isPaused = true
    expect(depositCount).to.equal(1n);
    expect(version).to.equal("1.0.0");
  });

  it("false alarm: unpause resumes all operations", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    await pool.connect(owner).pause();
    await pool.connect(owner).unpause();

    expect(await pool.paused()).to.be.false;

    // Deposit must succeed after unpause
    const commitment = randomCommitment();
    await expect(
      pool.connect(alice).deposit(commitment, { value: ONE_ETH })
    ).to.not.be.reverted;

    // Transfer call must not revert with EnforcedPause (proof failure is acceptable)
    const root = await pool.getLastRoot();
    await expect(
      pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      )
    ).to.not.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("ownership transfer under emergency: new owner can unpause", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(owner).pause();
    expect(await pool.paused()).to.be.true;

    // Transfer ownership to alice
    await pool.connect(owner).transferOwnership(alice.address);
    expect(await pool.owner()).to.equal(alice.address);

    // New owner must be able to unpause
    await pool.connect(alice).unpause();
    expect(await pool.paused()).to.be.false;

    // Old owner must no longer control the contract
    await expect(
      pool.connect(owner).pause()
    ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
  });

  it("rapid pause/unpause cycles don't corrupt state", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
    const depositCountBefore = await pool.getDepositCount();
    const statsBefore = await pool.getPoolStats();

    for (let i = 0; i < 5; i++) {
      await pool.connect(owner).pause();
      await pool.connect(owner).unpause();
    }

    expect(await pool.paused()).to.be.false;
    expect(await pool.getDepositCount()).to.equal(depositCountBefore);
    expect((await pool.getPoolStats())[0]).to.equal(statsBefore[0]); // totalDeposited unchanged

    // New deposit must still be accepted after all cycles
    const c2 = randomCommitment();
    await pool.connect(alice).deposit(c2, { value: ONE_ETH });
    expect(await pool.getDepositCount()).to.equal(depositCountBefore + 1n);
  });

  it("deposit in-flight during pause: reverts on execution", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(owner).pause();

    const commitment = randomCommitment();
    await expect(
      pool.connect(alice).deposit(commitment, { value: ONE_ETH })
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");

    // Commitment must NOT have been inserted
    expect(await pool.isCommitted(commitment)).to.be.false;
    expect(await pool.getDepositCount()).to.equal(0n);
  });

  it("funds are safe during pause (balance unchanged)", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: THREE_ETH });

    const balanceBefore = await ethers.provider.getBalance(
      await pool.getAddress()
    );
    expect(balanceBefore).to.equal(THREE_ETH);

    await pool.connect(owner).pause();

    const balanceDuringPause = await ethers.provider.getBalance(
      await pool.getAddress()
    );
    expect(balanceDuringPause).to.equal(THREE_ETH);

    // Failed deposit attempt must not alter balance
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");

    const balanceAfterFailedDeposit = await ethers.provider.getBalance(
      await pool.getAddress()
    );
    expect(balanceAfterFailedDeposit).to.equal(THREE_ETH);
  });

  it("after unpause: all historical roots still valid", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    await pool.connect(alice).deposit(c1, { value: ONE_ETH });
    const root1 = await pool.getLastRoot();

    await pool.connect(alice).deposit(c2, { value: ONE_ETH });
    const root2 = await pool.getLastRoot();

    await pool.connect(owner).pause();
    await pool.connect(owner).unpause();

    await pool.connect(alice).deposit(c3, { value: ONE_ETH });
    const root3 = await pool.getLastRoot();

    expect(await pool.isKnownRoot(root1)).to.be.true;
    expect(await pool.isKnownRoot(root2)).to.be.true;
    expect(await pool.isKnownRoot(root3)).to.be.true;
  });

  it("after unpause: new deposits get correct leaf indices", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    const c1 = randomCommitment();
    await pool.connect(alice).deposit(c1, { value: ONE_ETH });

    await pool.connect(owner).pause();
    await pool.connect(owner).unpause();

    const c2 = randomCommitment();
    const tx = await pool.connect(alice).deposit(c2, { value: ONE_ETH });
    const receipt = await tx.wait();

    const depositEvent = receipt?.logs
      .map((log) => {
        try {
          return pool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "Deposit");

    expect(depositEvent).to.not.be.undefined;
    // Index 0 taken by c1, c2 must be at index 1
    expect(depositEvent?.args.leafIndex).to.equal(1n);
    expect(await pool.commitmentIndex(c2)).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // Emergency drain
  // -------------------------------------------------------------------------

  it("emergencyDrain sends all ETH to specified address", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: FIVE_ETH });
    await pool.connect(owner).pause();

    const bobBefore = await ethers.provider.getBalance(bob.address);
    await pool.connect(owner).emergencyDrain(bob.address);
    const bobAfter = await ethers.provider.getBalance(bob.address);

    expect(bobAfter - bobBefore).to.equal(FIVE_ETH);
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(0n);
  });

  it("drain amount matches pool balance exactly", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    // Deposit several amounts so balance is non-trivial
    await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
    await pool.connect(alice).deposit(randomCommitment(), { value: THREE_ETH });

    const poolBalance = await ethers.provider.getBalance(
      await pool.getAddress()
    );
    expect(poolBalance).to.equal(ONE_ETH + THREE_ETH);

    await pool.connect(owner).pause();

    const tx = await pool.connect(owner).emergencyDrain(owner.address);
    await expect(tx)
      .to.emit(pool, "EmergencyDrain")
      .withArgs(owner.address, ONE_ETH + THREE_ETH);

    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(0n);
  });

  it("drain then deposit in new era works", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    // Era 1: deposit, pause, drain
    await pool.connect(alice).deposit(randomCommitment(), { value: THREE_ETH });
    await pool.connect(owner).pause();
    await pool.connect(owner).emergencyDrain(owner.address);

    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(0n);

    // Unpause — new era begins
    await pool.connect(owner).unpause();
    expect(await pool.paused()).to.be.false;

    // Era 2: deposit must succeed and state must accumulate correctly
    const c2 = randomCommitment();
    await expect(
      pool.connect(alice).deposit(c2, { value: ONE_ETH })
    ).to.not.be.reverted;

    expect(await pool.isCommitted(c2)).to.be.true;
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(ONE_ETH);
  });

  it("allowlist can be toggled during emergency (while paused)", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    await pool.connect(owner).pause();

    // Toggle allowlist while paused — admin state changes must never require the pool to be unpaused
    await pool.connect(owner).setAllowlistEnabled(true);
    expect(await pool.allowlistEnabled()).to.be.true;

    await pool.connect(owner).setAllowlisted(alice.address, true);
    expect(await pool.allowlisted(alice.address)).to.be.true;

    await pool.connect(owner).setAllowlisted(bob.address, false);
    expect(await pool.allowlisted(bob.address)).to.be.false;

    // Disable allowlist while still paused
    await pool.connect(owner).setAllowlistEnabled(false);
    expect(await pool.allowlistEnabled()).to.be.false;

    // Pool is still paused — deposits must still revert with EnforcedPause, not allowlist error
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });
});
