import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_DAY = 24 * 60 * 60;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Poseidon helpers — matching circuit logic exactly
// ---------------------------------------------------------------------------

/**
 * Compute note commitment: Poseidon(amount, blinding, ownerPubKeyX)
 */
async function computeCommitment(
  amount: bigint,
  blinding: bigint,
  ownerPubKeyX: bigint
): Promise<bigint> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([amount, blinding, ownerPubKeyX]));
}

/**
 * Compute nullifier: Poseidon(commitment, spendingKey)
 */
async function computeNullifier(
  commitment: bigint,
  spendingKey: bigint
): Promise<bigint> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([commitment, spendingKey]));
}

function randomFieldElement(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const signers = await ethers.getSigners();
  const [owner, alice, bob, charlie, relayer] = signers;

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

  return { pool, owner, alice, bob, charlie, relayer, signers };
}

// ---------------------------------------------------------------------------
// Timelock helper for denomination add
// ---------------------------------------------------------------------------

async function timelockAddDenomination(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  owner: Awaited<ReturnType<typeof deployPoolFixture>>["owner"],
  denomination: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["addDenomination", denomination]
    )
  );
  await pool.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await pool.connect(owner).addDenomination(denomination);
}

// ---------------------------------------------------------------------------
// Usage Scenarios
// ---------------------------------------------------------------------------

describe("Usage Scenarios", function () {
  // -------------------------------------------------------------------------
  // Scenario 1: deposit → transfer → withdraw full cycle with real hashes
  // -------------------------------------------------------------------------

  it("Scenario: deposit → transfer → withdraw full cycle with real hashes", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    // Alice deposits 2 ETH
    const aliceDepositAmount = ethers.parseEther("2");
    const aliceBlinding = randomFieldElement();
    const alicePubKeyX = randomFieldElement();
    const aliceSpendingKey = randomFieldElement();

    const aliceCommitment = await computeCommitment(
      aliceDepositAmount,
      aliceBlinding,
      alicePubKeyX
    );

    await pool.connect(alice).deposit(aliceCommitment, { value: aliceDepositAmount });
    const rootAfterDeposit = await pool.getLastRoot();

    // Alice transfers 1.5 ETH to Bob, keeps 0.5 ETH as change
    const transferAmount = ethers.parseEther("1.5");
    const changeAmount = ethers.parseEther("0.5");

    const bobPubKeyX = randomFieldElement();
    const bobCommitment = await computeCommitment(
      transferAmount,
      randomFieldElement(),
      bobPubKeyX
    );
    const aliceChangeCommitment = await computeCommitment(
      changeAmount,
      randomFieldElement(),
      alicePubKeyX
    );

    const aliceNullifier = await computeNullifier(aliceCommitment, aliceSpendingKey);

    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      rootAfterDeposit,
      aliceNullifier,
      bobCommitment,
      aliceChangeCommitment
    );

    expect(await pool.nullifiers(aliceNullifier)).to.be.true;
    expect(await pool.commitments(bobCommitment)).to.be.true;
    expect(await pool.commitments(aliceChangeCommitment)).to.be.true;

    const rootAfterTransfer = await pool.getLastRoot();

    // Bob withdraws 1.5 ETH
    const bobSpendingKey = randomFieldElement();
    const bobNullifier = await computeNullifier(bobCommitment, bobSpendingKey);

    const bobBefore = await ethers.provider.getBalance(bob.address);

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      rootAfterTransfer,
      bobNullifier,
      transferAmount,
      bob.address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    const bobAfter = await ethers.provider.getBalance(bob.address);
    expect(bobAfter - bobBefore).to.equal(transferAmount);

    // Pool retains Alice's 0.5 ETH change
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(changeAmount);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: batch deposit then individual withdrawals
  // -------------------------------------------------------------------------

  it("Scenario: batch deposit then individual withdrawals", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const spendingKeys = [
      randomFieldElement(),
      randomFieldElement(),
      randomFieldElement(),
    ];

    // Build 3 commitments
    const commitments = await Promise.all(
      amounts.map((amount) =>
        computeCommitment(amount, randomFieldElement(), randomFieldElement())
      )
    );

    const totalValue = amounts.reduce((a, b) => a + b, 0n);

    // Batch deposit all 3 notes in a single tx
    await pool
      .connect(alice)
      .batchDeposit(commitments, amounts, { value: totalValue });

    // Each commitment must be in the tree
    for (const c of commitments) {
      expect(await pool.commitments(c)).to.be.true;
    }
    expect(await pool.nextIndex()).to.equal(3);

    // Withdraw each note individually
    const recipients = [alice, bob, alice];

    for (let i = 0; i < 3; i++) {
      const root = await pool.getLastRoot();
      const nullifier = await computeNullifier(commitments[i], spendingKeys[i]);
      const recipientBefore = await ethers.provider.getBalance(
        recipients[i].address
      );

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        amounts[i],
        recipients[i].address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      const recipientAfter = await ethers.provider.getBalance(
        recipients[i].address
      );
      expect(recipientAfter - recipientBefore).to.equal(amounts[i]);
      expect(await pool.nullifiers(nullifier)).to.be.true;
    }

    // Pool is empty after all withdrawals
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: denomination-restricted deposits
  // -------------------------------------------------------------------------

  it("Scenario: denomination-restricted deposits", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    const allowedAmount = ethers.parseEther("1");
    const disallowedAmount = ethers.parseEther("0.5");

    // Add 1 ETH as the only allowed denomination via timelock
    await timelockAddDenomination(pool, owner, allowedAmount);

    // Deposit with disallowed amount (0.5 ETH) must revert
    await expect(
      pool
        .connect(alice)
        .deposit(randomCommitment(), { value: disallowedAmount })
    ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");

    // Deposit with the allowed denomination (1 ETH) must succeed
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: allowedAmount })
    ).to.emit(pool, "Deposit");
  });

  // -------------------------------------------------------------------------
  // Scenario 4: allowlisted deposit flow
  // -------------------------------------------------------------------------

  it("Scenario: allowlisted deposit flow", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    // Enable the allowlist
    await pool.connect(owner).setAllowlistEnabled(true);

    // Alice is not yet allowlisted — deposit must revert
    await expect(
      pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");

    // Owner adds Alice to the allowlist
    await pool.connect(owner).setAllowlisted(alice.address, true);

    // Alice's deposit now succeeds
    await expect(
      pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.emit(pool, "Deposit");

    // Bob (not on the allowlist) is still blocked
    await expect(
      pool
        .connect(bob)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
  });

  // -------------------------------------------------------------------------
  // Scenario 5: emergency pause and drain
  // -------------------------------------------------------------------------

  it("Scenario: emergency pause and drain", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    // 3 deposits
    const depositAmount = ethers.parseEther("1");
    for (let i = 0; i < 3; i++) {
      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: depositAmount });
    }

    const expectedPoolBalance = depositAmount * 3n;
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(expectedPoolBalance);

    // Owner pauses the pool
    await pool.connect(owner).pause();

    // Drain to owner
    const ownerBefore = await ethers.provider.getBalance(owner.address);

    const drainTx = await pool
      .connect(owner)
      .emergencyDrain(owner.address as unknown as Parameters<typeof pool.emergencyDrain>[0]);
    const drainReceipt = await drainTx.wait();
    const gasUsed = drainReceipt!.gasUsed * drainReceipt!.gasPrice;

    const ownerAfter = await ethers.provider.getBalance(owner.address);

    // Owner received the full pool balance minus gas cost
    expect(ownerAfter - ownerBefore + gasUsed).to.equal(expectedPoolBalance);

    // Pool balance is zero after drain
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(0n);
  });
});
