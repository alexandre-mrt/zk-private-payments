import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
  mine,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const ONE_DAY = 24 * 60 * 60;

// Placeholder proof values — stub verifiers always return true
const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomFieldElement(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

function makeActionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      [name, value]
    )
  );
}

async function queueAndWait(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  hash: string
): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Base fixture — fresh deployment, no configuration applied
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie, multisig] =
    await ethers.getSigners();

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

  const StealthRegistryFactory =
    await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistryFactory.deploy();

  return { pool, registry, owner, alice, bob, charlie, multisig };
}

// ---------------------------------------------------------------------------
// Protocol Lifecycle
// ---------------------------------------------------------------------------

describe("Protocol Lifecycle", function () {
  // -------------------------------------------------------------------------
  // Phase 1: Fresh deployment with all defaults
  // -------------------------------------------------------------------------

  it("Phase 1: Fresh deployment with all defaults", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    // Ownership
    expect(await pool.owner()).to.equal(await owner.getAddress());

    // Tree state
    expect(await pool.nextIndex()).to.equal(0);
    expect(await pool.levels()).to.equal(TREE_HEIGHT);

    // Analytics all zero
    expect(await pool.totalDeposited()).to.equal(0n);
    expect(await pool.totalWithdrawn()).to.equal(0n);
    expect(await pool.totalTransfers()).to.equal(0n);
    expect(await pool.withdrawalCount()).to.equal(0n);
    expect(await pool.uniqueDepositorCount()).to.equal(0n);

    // Security defaults
    expect(await pool.paused()).to.be.false;
    expect(await pool.allowlistEnabled()).to.be.false;
    expect(await pool.maxDepositsPerAddress()).to.equal(0n);
    expect(await pool.depositCooldown()).to.equal(0n);
    expect(await pool.maxWithdrawAmount()).to.equal(0n);
    expect(await pool.minDepositAge()).to.equal(0n);

    // No denominations configured — any non-zero amount is valid
    const denoms = await pool.getDenominations();
    expect(denoms.length).to.equal(0);

    // No pending governance action
    const pending = await pool.pendingAction();
    expect(pending.actionHash).to.equal(ethers.ZeroHash);
  });

  // -------------------------------------------------------------------------
  // Phase 2: Configure denominations and allowlist
  // -------------------------------------------------------------------------

  it("Phase 2: Configure denominations and allowlist", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    const denom1 = ethers.parseEther("1");
    const denom2 = ethers.parseEther("0.1");

    // addDenomination requires timelock
    const hash1 = makeActionHash("addDenomination", denom1);
    await queueAndWait(pool.connect(owner) as typeof pool, hash1);
    await expect(pool.connect(owner).addDenomination(denom1))
      .to.emit(pool, "DenominationAdded")
      .withArgs(denom1);

    const hash2 = makeActionHash("addDenomination", denom2);
    await queueAndWait(pool.connect(owner) as typeof pool, hash2);
    await pool.connect(owner).addDenomination(denom2);

    expect(await pool.allowedDenominations(denom1)).to.be.true;
    expect(await pool.allowedDenominations(denom2)).to.be.true;

    const list = await pool.getDenominations();
    expect(list.length).to.equal(2);

    // Enable the allowlist and whitelist alice
    await expect(pool.connect(owner).setAllowlistEnabled(true))
      .to.emit(pool, "AllowlistToggled")
      .withArgs(true);

    await pool.connect(owner).setAllowlisted(await alice.getAddress(), true);
    expect(await pool.allowlisted(await alice.getAddress())).to.be.true;
    expect(await pool.allowlistEnabled()).to.be.true;
  });

  // -------------------------------------------------------------------------
  // Phase 3: Users register viewing keys
  // -------------------------------------------------------------------------

  it("Phase 3: Users register viewing keys", async function () {
    const { registry, alice, bob } = await loadFixture(deployPoolFixture);

    const alicePubKeyX = randomFieldElement();
    const alicePubKeyY = randomFieldElement();
    const bobPubKeyX = randomFieldElement();
    const bobPubKeyY = randomFieldElement();

    await expect(
      registry.connect(alice).registerViewingKey(alicePubKeyX, alicePubKeyY)
    )
      .to.emit(registry, "ViewingKeyRegistered")
      .withArgs(await alice.getAddress(), alicePubKeyX, alicePubKeyY);

    await registry.connect(bob).registerViewingKey(bobPubKeyX, bobPubKeyY);

    const [ax, ay] = await registry.getViewingKey(await alice.getAddress());
    expect(ax).to.equal(alicePubKeyX);
    expect(ay).to.equal(alicePubKeyY);

    const [bx, by] = await registry.getViewingKey(await bob.getAddress());
    expect(bx).to.equal(bobPubKeyX);
    expect(by).to.equal(bobPubKeyY);
  });

  // -------------------------------------------------------------------------
  // Phase 4: Deposits create the UTXO pool
  // -------------------------------------------------------------------------

  it("Phase 4: Deposits create the UTXO pool", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const amount1 = ethers.parseEther("1");
    const amount2 = ethers.parseEther("0.5");
    const amount3 = ethers.parseEther("2");

    const c1 = randomFieldElement();
    const c2 = randomFieldElement();
    const c3 = randomFieldElement();

    await pool.connect(alice).deposit(c1, { value: amount1 });
    await pool.connect(bob).deposit(c2, { value: amount2 });
    await pool.connect(charlie).deposit(c3, { value: amount3 });

    // All three commitments are recorded
    expect(await pool.commitments(c1)).to.be.true;
    expect(await pool.commitments(c2)).to.be.true;
    expect(await pool.commitments(c3)).to.be.true;
    expect(await pool.nextIndex()).to.equal(3);

    // Cumulative stats
    expect(await pool.totalDeposited()).to.equal(amount1 + amount2 + amount3);
    expect(await pool.uniqueDepositorCount()).to.equal(3n);

    // Pool holds all deposited ETH
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(amount1 + amount2 + amount3);

    // Active note count: 3 deposits, 0 spends
    expect(await pool.getActiveNoteCount()).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // Phase 5: Transfers split and merge notes
  // -------------------------------------------------------------------------

  it("Phase 5: Transfers split and merge notes", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const inputCommitment = randomFieldElement();

    await pool.connect(alice).deposit(inputCommitment, { value: amount });

    const root = await pool.getLastRoot();
    const nullifier = randomFieldElement();
    const out1 = randomFieldElement();
    const out2 = randomFieldElement();

    await expect(
      pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      )
    ).to.emit(pool, "Transfer").withArgs(nullifier, out1, out2);

    // Input nullifier is spent
    expect(await pool.nullifiers(nullifier)).to.be.true;

    // Both output commitments are now in the tree
    expect(await pool.commitments(out1)).to.be.true;
    expect(await pool.commitments(out2)).to.be.true;

    // Tree has 3 leaves: 1 deposit + 2 outputs
    expect(await pool.nextIndex()).to.equal(3);

    // Transfer counter updated
    expect(await pool.totalTransfers()).to.equal(1n);

    // Active note count: 1 deposit + 2 transfer outputs - 1 nullified = 2
    // (deposit leaf still in tree; nullifier tracks that it was spent)
    expect(await pool.getActiveNoteCount()).to.equal(2n);

    // No ETH left the pool
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(amount);
  });

  // -------------------------------------------------------------------------
  // Phase 6: Withdrawals exit to plaintext
  // -------------------------------------------------------------------------

  it("Phase 6: Withdrawals exit to plaintext", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("2");
    const withdrawAmount = ethers.parseEther("1.5");
    const changeAmount = ethers.parseEther("0.5");

    const inputCommitment = randomFieldElement();
    await pool.connect(alice).deposit(inputCommitment, { value: depositAmount });

    const root = await pool.getLastRoot();
    const nullifier = randomFieldElement();
    const changeCommitment = randomFieldElement();

    const bobBefore = await ethers.provider.getBalance(bob.address);

    await expect(
      pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        withdrawAmount,
        bob.address,
        changeCommitment,
        ethers.ZeroAddress,
        0n
      )
    ).to.emit(pool, "Withdrawal");

    const bobAfter = await ethers.provider.getBalance(bob.address);

    // Bob received exactly the withdrawal amount
    expect(bobAfter - bobBefore).to.equal(withdrawAmount);

    // Nullifier is spent
    expect(await pool.nullifiers(nullifier)).to.be.true;

    // Change note is back in the tree
    expect(await pool.commitments(changeCommitment)).to.be.true;

    // Pool retains only the change amount
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(changeAmount);

    // Withdrawal record created
    expect(await pool.getWithdrawalRecordCount()).to.equal(1n);
    const record = await pool.getWithdrawalRecord(0);
    expect(record.amount).to.equal(withdrawAmount);
    expect(record.recipient).to.equal(bob.address);
  });

  // -------------------------------------------------------------------------
  // Phase 7: Pool stats reflect all operations
  // -------------------------------------------------------------------------

  it("Phase 7: Pool stats reflect all operations", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");

    // 3 deposits
    await pool.connect(alice).deposit(randomFieldElement(), { value: depositAmount });
    await pool.connect(bob).deposit(randomFieldElement(), { value: depositAmount });
    await pool.connect(charlie).deposit(randomFieldElement(), { value: depositAmount });

    // 1 transfer
    const rootAfterDeposits = await pool.getLastRoot();
    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      rootAfterDeposits,
      randomFieldElement(),
      randomFieldElement(),
      randomFieldElement()
    );

    // 1 withdrawal (no change)
    const rootAfterTransfer = await pool.getLastRoot();
    const withdrawAmount = ethers.parseEther("0.5");
    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      rootAfterTransfer,
      randomFieldElement(),
      withdrawAmount,
      alice.address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    const [
      totalDep,
      totalWith,
      totalTrans,
      depCount,
      withCount,
      uniqueDep,
      poolBalance,
    ] = await pool.getPoolStats();

    expect(totalDep).to.equal(depositAmount * 3n);
    expect(totalWith).to.equal(withdrawAmount);
    expect(totalTrans).to.equal(1n);
    // nextIndex = 3 deposits + 2 transfer output insertions = 5
    expect(depCount).to.equal(5n);
    expect(withCount).to.equal(1n);
    expect(uniqueDep).to.equal(3n);
    expect(poolBalance).to.equal(depositAmount * 3n - withdrawAmount);

    // getPoolHealth cross-check
    const [activeNotes, , healthBalance, isPaused, isAllowlisted] =
      await pool.getPoolHealth();
    expect(isPaused).to.be.false;
    expect(isAllowlisted).to.be.false;
    expect(healthBalance).to.equal(depositAmount * 3n - withdrawAmount);
    // active = nextIndex(5) - (totalTransfers(1) + withdrawalCount(1)) = 5 - 2 = 3
    expect(activeNotes).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // Phase 8: Emergency pause and drain
  // -------------------------------------------------------------------------

  it("Phase 8: Emergency pause and drain", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("2");
    await pool.connect(alice).deposit(randomFieldElement(), { value: depositAmount });

    // Owner pauses
    await expect(pool.connect(owner).pause()).to.emit(pool, "Paused");
    expect(await pool.paused()).to.be.true;

    // Operations blocked
    await expect(
      pool.connect(alice).deposit(randomFieldElement(), { value: depositAmount })
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");

    // Emergency drain to owner
    const ownerAddr = await owner.getAddress();
    const ownerBefore = await ethers.provider.getBalance(ownerAddr);

    await expect(pool.connect(owner).emergencyDrain(ownerAddr))
      .to.emit(pool, "EmergencyDrain")
      .withArgs(ownerAddr, depositAmount);

    const ownerAfter = await ethers.provider.getBalance(ownerAddr);
    // Owner receives depositAmount (minus gas — use a loose bound)
    expect(ownerAfter - ownerBefore).to.be.gt(depositAmount - ethers.parseEther("0.01"));

    // Pool is drained
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Phase 9: Unpause and resume operations
  // -------------------------------------------------------------------------

  it("Phase 9: Unpause and resume operations", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(owner).pause();

    // Unpause
    await expect(pool.connect(owner).unpause()).to.emit(pool, "Unpaused");
    expect(await pool.paused()).to.be.false;

    // Deposits work again
    const commitment = randomFieldElement();
    const depositAmount = ethers.parseEther("0.5");

    await expect(
      pool.connect(alice).deposit(commitment, { value: depositAmount })
    ).to.not.be.reverted;

    expect(await pool.commitments(commitment)).to.be.true;
    expect(await pool.nextIndex()).to.equal(1);
    expect(await pool.totalDeposited()).to.equal(depositAmount);
  });

  // -------------------------------------------------------------------------
  // Phase 10: Ownership transfer to multisig
  // -------------------------------------------------------------------------

  it("Phase 10: Ownership transfer to multisig", async function () {
    const { pool, owner, multisig } = await loadFixture(deployPoolFixture);

    const multisigAddr = await multisig.getAddress();

    // Transfer ownership to multisig
    await expect(pool.connect(owner).transferOwnership(multisigAddr))
      .to.emit(pool, "OwnershipTransferred");

    expect(await pool.owner()).to.equal(multisigAddr);

    // Old owner is locked out
    await expect(
      pool.connect(owner).pause()
    ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");

    // Multisig can queue and execute a timelocked action
    const hash = makeActionHash(
      "setMaxDepositsPerAddress",
      10n
    );
    await pool.connect(multisig).queueAction(hash);
    await time.increase(ONE_DAY + 1);

    await expect(
      pool.connect(multisig).setMaxDepositsPerAddress(10n)
    )
      .to.emit(pool, "MaxDepositsPerAddressUpdated")
      .withArgs(10n);

    expect(await pool.maxDepositsPerAddress()).to.equal(10n);
  });
});
