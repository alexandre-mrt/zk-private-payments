import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
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

// ---------------------------------------------------------------------------
// Poseidon helpers — initialised once via before() to avoid rebuilding per-test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidon: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;

before(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

/**
 * Compute note commitment: Poseidon(amount, blinding, ownerPubKeyX)
 * Mirrors the circuit constraint exactly.
 */
function computeCommitment(
  amount: bigint,
  blinding: bigint,
  ownerPubKeyX: bigint
): bigint {
  return F.toObject(poseidon([amount, blinding, ownerPubKeyX]));
}

/**
 * Compute nullifier: Poseidon(commitment, spendingKey)
 * Mirrors the circuit constraint exactly.
 */
function computeNullifier(commitment: bigint, key: bigint): bigint {
  return F.toObject(poseidon([commitment, key]));
}

/** Returns a random 31-byte field element (guaranteed < FIELD_SIZE). */
function rand(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5, // 32-leaf tree — sufficient for all tests
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/** Deposits a Poseidon commitment and returns the post-deposit Merkle root. */
async function depositNote(
  pool: Pool,
  signer: Signer,
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

/** Executes a transfer using the ZERO_PROOF (verifier always accepts in test network). */
async function doTransfer(
  pool: Pool,
  root: bigint,
  nullifier: bigint,
  out1: bigint,
  out2: bigint
) {
  return pool.transfer(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    out1,
    out2
  );
}

/** Executes a withdrawal using the ZERO_PROOF. */
async function doWithdraw(
  pool: Pool,
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment: bigint = 0n
) {
  return pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient,
    changeCommitment,
    ethers.ZeroAddress,
    0n
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Transfer Patterns", function () {
  // =========================================================================
  // Basic transfers — split ratios
  // =========================================================================

  it("50/50 split: equal output amounts", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("2");
    const halfAmount = ethers.parseEther("1");
    const spendingKey = rand();

    const inputCommitment = computeCommitment(depositAmount, rand(), rand());
    const root = await depositNote(pool, alice, inputCommitment, depositAmount);
    const nullifier = computeNullifier(inputCommitment, spendingKey);

    const out1 = computeCommitment(halfAmount, rand(), rand());
    const out2 = computeCommitment(halfAmount, rand(), rand());

    await doTransfer(pool, root, nullifier, out1, out2);

    expect(await pool.commitments(out1)).to.be.true;
    expect(await pool.commitments(out2)).to.be.true;
    expect(await pool.nullifiers(nullifier)).to.be.true;
  });

  it("90/10 split: asymmetric outputs", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const spendingKey = rand();

    const inputCommitment = computeCommitment(depositAmount, rand(), rand());
    const root = await depositNote(pool, alice, inputCommitment, depositAmount);
    const nullifier = computeNullifier(inputCommitment, spendingKey);

    const out1 = computeCommitment(ethers.parseEther("0.9"), rand(), rand());
    const out2 = computeCommitment(ethers.parseEther("0.1"), rand(), rand());

    await doTransfer(pool, root, nullifier, out1, out2);

    expect(await pool.commitments(out1)).to.be.true;
    expect(await pool.commitments(out2)).to.be.true;
  });

  it("full amount to recipient, zero change (encoded as dust commitment)", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const spendingKey = rand();

    const inputCommitment = computeCommitment(depositAmount, rand(), rand());
    const root = await depositNote(pool, alice, inputCommitment, depositAmount);
    const nullifier = computeNullifier(inputCommitment, spendingKey);

    // Recipient gets the full amount; change encodes 0 wei but commitment must be non-zero
    const recipientCommitment = computeCommitment(depositAmount, rand(), rand());
    const dustChangeCommitment = computeCommitment(1n, rand(), rand());

    await doTransfer(pool, root, nullifier, recipientCommitment, dustChangeCommitment);

    expect(await pool.commitments(recipientCommitment)).to.be.true;
    expect(await pool.commitments(dustChangeCommitment)).to.be.true;
  });

  it("1 wei to recipient, rest as change", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const spendingKey = rand();

    const inputCommitment = computeCommitment(depositAmount, rand(), rand());
    const root = await depositNote(pool, alice, inputCommitment, depositAmount);
    const nullifier = computeNullifier(inputCommitment, spendingKey);

    const out1 = computeCommitment(1n, rand(), rand());
    const out2 = computeCommitment(depositAmount - 1n, rand(), rand());

    await doTransfer(pool, root, nullifier, out1, out2);

    expect(await pool.commitments(out1)).to.be.true;
    expect(await pool.commitments(out2)).to.be.true;
  });

  // =========================================================================
  // Sequential transfers — chain of UTXOs
  // =========================================================================

  it("A deposits, A transfers to B, B transfers to C", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("3");
    const transferAmount = ethers.parseEther("2");
    const changeAmount = depositAmount - transferAmount;

    // A deposits
    const aliceSpendingKey = rand();
    const alicePubKeyX = rand();
    const aliceInputCommitment = computeCommitment(depositAmount, rand(), alicePubKeyX);
    const root0 = await depositNote(pool, alice, aliceInputCommitment, depositAmount);

    // A → B: Alice spends her deposit, creates Bob's note + her change note
    const aliceNullifier = computeNullifier(aliceInputCommitment, aliceSpendingKey);
    const bobSpendingKey = rand();
    const bobPubKeyX = rand();
    const bobCommitment = computeCommitment(transferAmount, rand(), bobPubKeyX);
    const aliceChangeCommitment = computeCommitment(changeAmount, rand(), alicePubKeyX);

    await doTransfer(pool, root0, aliceNullifier, bobCommitment, aliceChangeCommitment);

    const root1 = await pool.getLastRoot();
    expect(await pool.commitments(bobCommitment)).to.be.true;

    // B → C: Bob spends his note, creates Charlie's note + a dust note back to Bob
    const bobNullifier = computeNullifier(bobCommitment, bobSpendingKey);
    const charlieCommitment = computeCommitment(transferAmount, rand(), rand());
    const bobDustCommitment = computeCommitment(1n, rand(), bobPubKeyX);

    await doTransfer(pool, root1, bobNullifier, charlieCommitment, bobDustCommitment);

    expect(await pool.commitments(charlieCommitment)).to.be.true;
    expect(await pool.nullifiers(aliceNullifier)).to.be.true;
    expect(await pool.nullifiers(bobNullifier)).to.be.true;
  });

  it("A deposits, transfers, then transfers again using output commitment", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("2");
    const firstTransferAmount = ethers.parseEther("1.5");
    const secondTransferAmount = ethers.parseEther("1");

    const depositSpendingKey = rand();
    const pubKeyX = rand();

    // Deposit
    const depositCommitment = computeCommitment(depositAmount, rand(), pubKeyX);
    const root0 = await depositNote(pool, alice, depositCommitment, depositAmount);

    // First transfer: spend deposit, produce intermediate note + change
    const depositNullifier = computeNullifier(depositCommitment, depositSpendingKey);
    const intermediateSpendingKey = rand();
    const intermediateCommitment = computeCommitment(firstTransferAmount, rand(), pubKeyX);
    const firstChangeCommitment = computeCommitment(
      depositAmount - firstTransferAmount,
      rand(),
      pubKeyX
    );

    await doTransfer(
      pool,
      root0,
      depositNullifier,
      intermediateCommitment,
      firstChangeCommitment
    );

    const root1 = await pool.getLastRoot();
    expect(await pool.commitments(intermediateCommitment)).to.be.true;

    // Second transfer: spend the intermediate output
    const intermediateNullifier = computeNullifier(
      intermediateCommitment,
      intermediateSpendingKey
    );
    const finalOut1 = computeCommitment(secondTransferAmount, rand(), rand());
    const finalOut2 = computeCommitment(
      firstTransferAmount - secondTransferAmount,
      rand(),
      pubKeyX
    );

    await doTransfer(pool, root1, intermediateNullifier, finalOut1, finalOut2);

    expect(await pool.commitments(finalOut1)).to.be.true;
    expect(await pool.commitments(finalOut2)).to.be.true;
    expect(await pool.nullifiers(depositNullifier)).to.be.true;
    expect(await pool.nullifiers(intermediateNullifier)).to.be.true;
  });

  // =========================================================================
  // Multiple independent transfers
  // =========================================================================

  it("3 users deposit, each transfers independently", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");

    const aliceSpendingKey = rand();
    const bobSpendingKey = rand();
    const charlieSpendingKey = rand();

    const aliceCommitment = computeCommitment(depositAmount, rand(), rand());
    const bobCommitment = computeCommitment(depositAmount, rand(), rand());
    const charlieCommitment = computeCommitment(depositAmount, rand(), rand());

    await depositNote(pool, alice, aliceCommitment, depositAmount);
    await depositNote(pool, bob, bobCommitment, depositAmount);
    await depositNote(pool, charlie, charlieCommitment, depositAmount);

    const aliceNullifier = computeNullifier(aliceCommitment, aliceSpendingKey);
    const aliceOut1 = computeCommitment(ethers.parseEther("0.6"), rand(), rand());
    const aliceOut2 = computeCommitment(ethers.parseEther("0.4"), rand(), rand());
    const root0 = await pool.getLastRoot();
    await doTransfer(pool, root0, aliceNullifier, aliceOut1, aliceOut2);

    const bobNullifier = computeNullifier(bobCommitment, bobSpendingKey);
    const bobOut1 = computeCommitment(ethers.parseEther("0.7"), rand(), rand());
    const bobOut2 = computeCommitment(ethers.parseEther("0.3"), rand(), rand());
    const root1 = await pool.getLastRoot();
    await doTransfer(pool, root1, bobNullifier, bobOut1, bobOut2);

    const charlieNullifier = computeNullifier(charlieCommitment, charlieSpendingKey);
    const charlieOut1 = computeCommitment(ethers.parseEther("0.5"), rand(), rand());
    const charlieOut2 = computeCommitment(ethers.parseEther("0.5"), rand(), rand());
    const root2 = await pool.getLastRoot();
    await doTransfer(pool, root2, charlieNullifier, charlieOut1, charlieOut2);

    expect(await pool.nullifiers(aliceNullifier)).to.be.true;
    expect(await pool.nullifiers(bobNullifier)).to.be.true;
    expect(await pool.nullifiers(charlieNullifier)).to.be.true;

    // 3 deposits + 6 transfer outputs = 9 leaves
    expect(await pool.nextIndex()).to.equal(9n);
  });

  it("same user transfers from 2 different deposits", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const spendingKey1 = rand();
    const spendingKey2 = rand();

    const commitment1 = computeCommitment(depositAmount, rand(), rand());
    const commitment2 = computeCommitment(depositAmount, rand(), rand());

    await depositNote(pool, alice, commitment1, depositAmount);
    await depositNote(pool, alice, commitment2, depositAmount);

    const root = await pool.getLastRoot();

    // Spend first deposit
    const nullifier1 = computeNullifier(commitment1, spendingKey1);
    const out1a = computeCommitment(ethers.parseEther("0.8"), rand(), rand());
    const out1b = computeCommitment(ethers.parseEther("0.2"), rand(), rand());
    await doTransfer(pool, root, nullifier1, out1a, out1b);

    // Spend second deposit
    const root2 = await pool.getLastRoot();
    const nullifier2 = computeNullifier(commitment2, spendingKey2);
    const out2a = computeCommitment(ethers.parseEther("0.9"), rand(), rand());
    const out2b = computeCommitment(ethers.parseEther("0.1"), rand(), rand());
    await doTransfer(pool, root2, nullifier2, out2a, out2b);

    expect(await pool.nullifiers(nullifier1)).to.be.true;
    expect(await pool.nullifiers(nullifier2)).to.be.true;
    // 2 deposits + 4 transfer outputs
    expect(await pool.nextIndex()).to.equal(6n);
  });

  // =========================================================================
  // Transfer + other operations in sequence
  // =========================================================================

  it("deposit then transfer in sequence", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const spendingKey = rand();
    const inputCommitment = computeCommitment(depositAmount, rand(), rand());

    const root = await depositNote(pool, alice, inputCommitment, depositAmount);
    const nullifier = computeNullifier(inputCommitment, spendingKey);
    const out1 = computeCommitment(ethers.parseEther("0.6"), rand(), rand());
    const out2 = computeCommitment(ethers.parseEther("0.4"), rand(), rand());

    await expect(
      doTransfer(pool, root, nullifier, out1, out2)
    ).to.emit(pool, "Transfer");

    expect(await pool.totalTransfers()).to.equal(1n);
    // 1 deposit + 2 transfer outputs
    expect(await pool.nextIndex()).to.equal(3n);
  });

  it("transfer then withdraw in sequence", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("2");
    const transferAmount = ethers.parseEther("1.5");
    const changeAmount = depositAmount - transferAmount;

    // Deposit
    const depositSpendingKey = rand();
    const depositCommitment = computeCommitment(depositAmount, rand(), rand());
    const root0 = await depositNote(pool, alice, depositCommitment, depositAmount);

    // Transfer: spend deposit, create recipient note and change note
    const depositNullifier = computeNullifier(depositCommitment, depositSpendingKey);
    const recipientSpendingKey = rand();
    const recipientCommitment = computeCommitment(transferAmount, rand(), rand());
    const changeCommitment = computeCommitment(changeAmount, rand(), rand());

    await doTransfer(pool, root0, depositNullifier, recipientCommitment, changeCommitment);

    const root1 = await pool.getLastRoot();
    expect(await pool.commitments(recipientCommitment)).to.be.true;

    // Withdraw using the recipient note
    const recipientNullifier = computeNullifier(recipientCommitment, recipientSpendingKey);
    const bobBefore = await ethers.provider.getBalance(bob.address);

    await doWithdraw(pool, root1, recipientNullifier, transferAmount, bob.address, 0n);

    const bobAfter = await ethers.provider.getBalance(bob.address);
    expect(bobAfter - bobBefore).to.equal(transferAmount);

    // Pool retains change amount
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(changeAmount);
  });

  it("transfer doesn't affect pool ETH balance", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const inputCommitment = computeCommitment(depositAmount, rand(), rand());
    const root = await depositNote(pool, alice, inputCommitment, depositAmount);

    const balanceBefore = await ethers.provider.getBalance(
      await pool.getAddress()
    );

    const out1 = computeCommitment(ethers.parseEther("0.6"), rand(), rand());
    const out2 = computeCommitment(ethers.parseEther("0.4"), rand(), rand());
    await doTransfer(pool, root, rand(), out1, out2);

    const balanceAfter = await ethers.provider.getBalance(
      await pool.getAddress()
    );
    expect(balanceAfter).to.equal(balanceBefore);
  });

  // =========================================================================
  // Transfer edge cases
  // =========================================================================

  it("transfer with zero-commitment output reverts", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const inputCommitment = computeCommitment(depositAmount, rand(), rand());
    const root = await depositNote(pool, alice, inputCommitment, depositAmount);
    const validOut = computeCommitment(ethers.parseEther("0.5"), rand(), rand());

    // outputCommitment1 = 0 must revert
    await expect(
      doTransfer(pool, root, rand(), 0n, validOut)
    ).to.be.revertedWith("ConfidentialPool: zero output commitment");

    // outputCommitment2 = 0 must revert
    await expect(
      doTransfer(pool, root, rand(), validOut, 0n)
    ).to.be.revertedWith("ConfidentialPool: zero output commitment");
  });

  it("transfer with unknown root reverts", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const fakeRoot = rand();

    await expect(
      doTransfer(pool, fakeRoot, rand(), rand(), rand())
    ).to.be.revertedWith("ConfidentialPool: unknown root");
  });

  it("transfer with spent nullifier reverts", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const spendingKey = rand();
    const inputCommitment = computeCommitment(depositAmount, rand(), rand());
    const root = await depositNote(pool, alice, inputCommitment, depositAmount);

    const nullifier = computeNullifier(inputCommitment, spendingKey);
    const out1 = computeCommitment(ethers.parseEther("0.6"), rand(), rand());
    const out2 = computeCommitment(ethers.parseEther("0.4"), rand(), rand());

    await doTransfer(pool, root, nullifier, out1, out2);

    // Use the updated root for the second attempt
    const rootAfterTransfer = await pool.getLastRoot();

    await expect(
      doTransfer(pool, rootAfterTransfer, nullifier, rand(), rand())
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
  });

  it("transfer creates 2 new indexed commitments", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const inputCommitment = computeCommitment(depositAmount, rand(), rand());
    const root = await depositNote(pool, alice, inputCommitment, depositAmount);

    // nextIndex is 1 after deposit
    expect(await pool.nextIndex()).to.equal(1n);

    const out1 = computeCommitment(ethers.parseEther("0.6"), rand(), rand());
    const out2 = computeCommitment(ethers.parseEther("0.4"), rand(), rand());

    await doTransfer(pool, root, rand(), out1, out2);

    // nextIndex must now be 3 (1 deposit + 2 transfer outputs)
    expect(await pool.nextIndex()).to.equal(3n);

    // Reverse index lookups must resolve correctly
    const index1 = await pool.commitmentIndex(out1);
    const index2 = await pool.commitmentIndex(out2);
    expect(index2).to.equal(index1 + 1n);

    expect(await pool.indexToCommitment(index1)).to.equal(out1);
    expect(await pool.indexToCommitment(index2)).to.equal(out2);
  });
});
