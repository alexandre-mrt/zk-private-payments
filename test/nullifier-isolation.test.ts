import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// BN254 scalar field prime — all Poseidon inputs/outputs live in [0, FIELD_SIZE).
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const TREE_HEIGHT = 5;
const ONE_ETH = ethers.parseEther("1");

// Zero-value dummy proof — the test verifier accepts any proof.
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
function computeNullifier(commitment: bigint, spendingKey: bigint): bigint {
  return F.toObject(poseidon([commitment, spendingKey]));
}

function rand(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Note {
  commitment: bigint;
  nullifier: bigint;
  amount: bigint;
}

function makeNote(amount: bigint = ONE_ETH): Note {
  const blinding = rand();
  const ownerPubKeyX = rand();
  const spendingKey = rand();
  const commitment = computeCommitment(amount, blinding, ownerPubKeyX);
  const nullifier = computeNullifier(commitment, spendingKey);
  return { commitment, nullifier, amount };
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
    TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie };
}

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function depositNote(
  pool: Pool,
  signer: Signer,
  note: Note
): Promise<bigint> {
  await pool.connect(signer).deposit(note.commitment, { value: note.amount });
  return pool.getLastRoot();
}

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Nullifier Isolation — zk-private-payments", function () {
  // -------------------------------------------------------------------------
  // 1. Each nullifier is independent — spending one does not affect others
  // -------------------------------------------------------------------------

  it("each nullifier is independent (spending one doesn't affect others)", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const noteA = makeNote();
    const noteB = makeNote();

    await depositNote(pool, alice, noteA);
    await depositNote(pool, alice, noteB);
    const root = await pool.getLastRoot();

    await doWithdraw(pool, root, noteA.nullifier, noteA.amount, bob.address);

    expect(await pool.isSpent(noteA.nullifier)).to.be.true;
    expect(await pool.isSpent(noteB.nullifier)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 2. Nullifier not spent before withdrawal
  // -------------------------------------------------------------------------

  it("nullifier not spent before withdrawal", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const note = makeNote();
    await depositNote(pool, alice, note);

    expect(await pool.isSpent(note.nullifier)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 3. Nullifier is spent after withdrawal
  // -------------------------------------------------------------------------

  it("nullifier is spent after withdrawal", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const note = makeNote();
    const root = await depositNote(pool, alice, note);

    await doWithdraw(pool, root, note.nullifier, note.amount, bob.address);

    expect(await pool.isSpent(note.nullifier)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 4. Same nullifier cannot be used in two withdrawals (double-spend)
  // -------------------------------------------------------------------------

  it("same nullifier cannot be used in two withdrawals", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const note = makeNote();
    const root = await depositNote(pool, alice, note);

    await doWithdraw(pool, root, note.nullifier, note.amount, bob.address);

    await expect(
      doWithdraw(pool, root, note.nullifier, note.amount, bob.address)
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
  });

  // -------------------------------------------------------------------------
  // 5. Different nullifiers from same depositor both work
  // -------------------------------------------------------------------------

  it("different nullifiers from same depositor both work", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const noteA = makeNote();
    const noteB = makeNote();

    await depositNote(pool, alice, noteA);
    await depositNote(pool, alice, noteB);
    const root = await pool.getLastRoot();

    await doWithdraw(pool, root, noteA.nullifier, noteA.amount, bob.address);
    await doWithdraw(pool, root, noteB.nullifier, noteB.amount, bob.address);

    expect(await pool.isSpent(noteA.nullifier)).to.be.true;
    expect(await pool.isSpent(noteB.nullifier)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 6. isSpent returns false for a random value never used
  // -------------------------------------------------------------------------

  it("isSpent returns false for random value", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const randomNullifier = rand();
    expect(await pool.isSpent(randomNullifier)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 7. isSpent returns true only after withdrawal with that exact nullifier
  // -------------------------------------------------------------------------

  it("isSpent returns true only after withdrawal with that nullifier", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const noteA = makeNote();
    const noteB = makeNote();

    await depositNote(pool, alice, noteA);
    await depositNote(pool, alice, noteB);
    const root = await pool.getLastRoot();

    await doWithdraw(pool, root, noteA.nullifier, noteA.amount, bob.address);

    expect(await pool.isSpent(noteA.nullifier)).to.be.true;
    expect(await pool.isSpent(noteB.nullifier)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 8. 10 unique nullifiers can all be spent independently
  // -------------------------------------------------------------------------

  it("10 unique nullifiers can all be spent independently", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const notes: Note[] = [];
    for (let i = 0; i < 10; i++) {
      const note = makeNote();
      notes.push(note);
      await pool.connect(alice).deposit(note.commitment, { value: note.amount });
    }

    const root = await pool.getLastRoot();

    for (const note of notes) {
      await doWithdraw(pool, root, note.nullifier, note.amount, bob.address);
    }

    for (const note of notes) {
      expect(await pool.isSpent(note.nullifier)).to.be.true;
    }
  });

  // -------------------------------------------------------------------------
  // 9. Nullifier state persists across blocks
  // -------------------------------------------------------------------------

  it("nullifier state persists across blocks", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const note = makeNote();
    const root = await depositNote(pool, alice, note);

    await doWithdraw(pool, root, note.nullifier, note.amount, bob.address);

    // Mine several blocks
    await ethers.provider.send("hardhat_mine", ["0x64"]); // 100 blocks

    expect(await pool.isSpent(note.nullifier)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 10. Nullifier hash is a field element (strictly less than FIELD_SIZE)
  // -------------------------------------------------------------------------

  it("nullifier is a field element (< FIELD_SIZE)", function () {
    const COUNT = 20;
    for (let i = 0; i < COUNT; i++) {
      // computeNullifier uses Poseidon — output is always < FIELD_SIZE
      const commitment = rand();
      const spendingKey = rand();
      const nullifier = computeNullifier(commitment, spendingKey);
      expect(nullifier).to.be.lessThan(FIELD_SIZE);
      expect(nullifier).to.be.greaterThan(0n);
    }
  });

  // -------------------------------------------------------------------------
  // 11. Nullifier spent in transfer cannot be reused in withdraw
  // -------------------------------------------------------------------------

  it("nullifier spent in transfer cannot be reused in withdraw", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const note = makeNote();
    const root = await depositNote(pool, alice, note);

    const out1 = makeNote(ethers.parseEther("0.5"));
    const out2 = makeNote(ethers.parseEther("0.5"));

    // Spend the nullifier via transfer
    await doTransfer(pool, root, note.nullifier, out1.commitment, out2.commitment);

    expect(await pool.isSpent(note.nullifier)).to.be.true;

    // Attempting to spend the same nullifier via withdraw must revert
    const root2 = await pool.getLastRoot();
    await expect(
      doWithdraw(pool, root2, note.nullifier, note.amount, bob.address)
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
  });

  // -------------------------------------------------------------------------
  // 12. Nullifier spent in withdraw cannot be reused in transfer
  // -------------------------------------------------------------------------

  it("nullifier spent in withdraw cannot be reused in transfer", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const note = makeNote();
    const root = await depositNote(pool, alice, note);

    // Spend the nullifier via withdraw
    await doWithdraw(pool, root, note.nullifier, note.amount, bob.address);

    expect(await pool.isSpent(note.nullifier)).to.be.true;

    // Attempting to spend the same nullifier via transfer must revert
    const out1 = makeNote(ethers.parseEther("0.5"));
    const out2 = makeNote(ethers.parseEther("0.5"));

    await expect(
      doTransfer(pool, root, note.nullifier, out1.commitment, out2.commitment)
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
  });

  // -------------------------------------------------------------------------
  // 13. Transfer and withdrawal use independent nullifier checks (distinct notes)
  // -------------------------------------------------------------------------

  it("transfer and withdrawal use independent nullifier checks", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const noteForTransfer = makeNote();
    const noteForWithdraw = makeNote();

    await depositNote(pool, alice, noteForTransfer);
    await depositNote(pool, alice, noteForWithdraw);
    const root = await pool.getLastRoot();

    // Both nullifiers unspent before any operation
    expect(await pool.isSpent(noteForTransfer.nullifier)).to.be.false;
    expect(await pool.isSpent(noteForWithdraw.nullifier)).to.be.false;

    const out1 = makeNote(ethers.parseEther("0.5"));
    const out2 = makeNote(ethers.parseEther("0.5"));

    // Spend noteForTransfer via transfer, noteForWithdraw via withdraw
    await doTransfer(
      pool,
      root,
      noteForTransfer.nullifier,
      out1.commitment,
      out2.commitment
    );
    await doWithdraw(
      pool,
      root,
      noteForWithdraw.nullifier,
      noteForWithdraw.amount,
      bob.address
    );

    // Each operation marks only its own nullifier
    expect(await pool.isSpent(noteForTransfer.nullifier)).to.be.true;
    expect(await pool.isSpent(noteForWithdraw.nullifier)).to.be.true;

    // Re-using either nullifier in any operation must fail
    await expect(
      doTransfer(pool, root, noteForTransfer.nullifier, out1.commitment, out2.commitment)
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");

    await expect(
      doWithdraw(pool, root, noteForWithdraw.nullifier, noteForWithdraw.amount, bob.address)
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
  });
});
