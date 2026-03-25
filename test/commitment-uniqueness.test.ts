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

const FIELD_MAX = FIELD_SIZE - 1n;

const MERKLE_TREE_HEIGHT = 5;
const ONE_ETH = ethers.parseEther("1");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a 31-byte random bigint, guaranteed to stay strictly below FIELD_SIZE. */
function randomField(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice] = await ethers.getSigners();

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

  return { pool, owner, alice };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Commitment Uniqueness — zk-private-payments", function () {
  // circomlibjs Poseidon instance — built once for the whole suite.
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  /**
   * Compute off-chain commitment = Poseidon(amount, blinding, ownerPubKeyX).
   * This mirrors the on-chain design documented in ConfidentialPool:
   *   commitment = Poseidon(amount, blinding, ownerPubKeyX)
   */
  function noteCommitment(
    amount: bigint,
    blinding: bigint,
    ownerPubKeyX: bigint
  ): bigint {
    return F.toObject(poseidon([amount, blinding, ownerPubKeyX]));
  }

  // -------------------------------------------------------------------------
  // 1. Two random commitments are distinct
  // -------------------------------------------------------------------------

  it("two random commitments are distinct", function () {
    const c1 = noteCommitment(randomField(), randomField(), randomField());
    const c2 = noteCommitment(randomField(), randomField(), randomField());

    expect(c1).to.not.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 2. 100 random notes have unique commitments (no collisions)
  // -------------------------------------------------------------------------

  it("100 random notes have unique commitments (no collisions)", function () {
    const commitments: bigint[] = [];
    for (let i = 0; i < 100; i++) {
      commitments.push(
        noteCommitment(randomField(), randomField(), randomField())
      );
    }

    const unique = new Set(commitments.map(String));
    expect(unique.size).to.equal(100);
  });

  // -------------------------------------------------------------------------
  // 3. Changing amount changes commitment
  // -------------------------------------------------------------------------

  it("commitment = Poseidon(amount, blinding, ownerPubKeyX) — changing amount changes commitment", function () {
    const blinding = randomField();
    const ownerPubKeyX = randomField();
    const amount1 = randomField();
    const amount2 = amount1 + 1n;

    const c1 = noteCommitment(amount1, blinding, ownerPubKeyX);
    const c2 = noteCommitment(amount2, blinding, ownerPubKeyX);

    expect(c1).to.not.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 4. Changing blinding changes commitment
  // -------------------------------------------------------------------------

  it("commitment = Poseidon(amount, blinding, ownerPubKeyX) — changing blinding changes commitment", function () {
    const amount = randomField();
    const ownerPubKeyX = randomField();
    const blinding1 = randomField();
    const blinding2 = blinding1 + 1n;

    const c1 = noteCommitment(amount, blinding1, ownerPubKeyX);
    const c2 = noteCommitment(amount, blinding2, ownerPubKeyX);

    expect(c1).to.not.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 5. Changing ownerPubKeyX changes commitment
  // -------------------------------------------------------------------------

  it("commitment = Poseidon(amount, blinding, ownerPubKeyX) — changing ownerPubKeyX changes commitment", function () {
    const amount = randomField();
    const blinding = randomField();
    const ownerPubKeyX1 = randomField();
    const ownerPubKeyX2 = ownerPubKeyX1 + 1n;

    const c1 = noteCommitment(amount, blinding, ownerPubKeyX1);
    const c2 = noteCommitment(amount, blinding, ownerPubKeyX2);

    expect(c1).to.not.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 6. Same commitment cannot be deposited twice
  // -------------------------------------------------------------------------

  it("same commitment cannot be deposited twice", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const c = noteCommitment(randomField(), randomField(), randomField());

    await pool.connect(alice).deposit(c, { value: ONE_ETH });

    await expect(
      pool.connect(alice).deposit(c, { value: ONE_ETH })
    ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
  });

  // -------------------------------------------------------------------------
  // 7. Commitments at field boundaries are valid but distinct
  // -------------------------------------------------------------------------

  it("commitment with inputs 1 and FIELD_SIZE-1 are both valid but different", function () {
    const cMin = noteCommitment(1n, 1n, 1n);
    const cMax = noteCommitment(FIELD_MAX, FIELD_MAX, FIELD_MAX);

    expect(cMin).to.not.equal(cMax);
    // Both must be valid field elements.
    expect(cMin).to.be.lessThan(FIELD_SIZE);
    expect(cMax).to.be.lessThan(FIELD_SIZE);
  });

  // -------------------------------------------------------------------------
  // 8. Poseidon(3 inputs) is collision-resistant for sequential inputs
  // -------------------------------------------------------------------------

  it("Poseidon hash is collision-resistant for sequential inputs (3 inputs)", function () {
    const COUNT = 20;
    const results: bigint[] = [];

    for (let i = 0; i < COUNT; i++) {
      results.push(noteCommitment(BigInt(i), BigInt(i), BigInt(i)));
    }

    const unique = new Set(results.map(String));
    expect(unique.size).to.equal(COUNT);
  });

  // -------------------------------------------------------------------------
  // 9. On-chain hashLeftRight matches off-chain for boundary values
  // -------------------------------------------------------------------------

  it("on-chain hashLeftRight matches off-chain for boundary values", async function () {
    const { pool } = await loadFixture(deployFixture);

    const pairs: [bigint, bigint][] = [
      [1n, 1n],
      [FIELD_MAX, 1n],
      [1n, FIELD_MAX],
      [FIELD_MAX, FIELD_MAX],
    ];

    for (const [left, right] of pairs) {
      const onChain = await pool.hashLeftRight(left, right);
      const offChain = F.toObject(poseidon([left, right]));
      expect(onChain, `hashLeftRight(${left}, ${right})`).to.equal(offChain);
    }
  });

  // -------------------------------------------------------------------------
  // 10. Two notes with equal amounts but different blindings are distinct
  // -------------------------------------------------------------------------

  it("two notes with same amount but different blindings produce distinct commitments", function () {
    // This is a critical privacy property: even if amount and ownerPubKeyX are
    // identical, the random blinding factor must make commitments unlinkable.
    const amount = ethers.parseEther("1");
    const ownerPubKeyX = randomField();
    const blinding1 = randomField();
    const blinding2 = randomField();

    // With overwhelming probability two independent random blindings differ.
    const c1 = noteCommitment(amount, blinding1, ownerPubKeyX);
    const c2 = noteCommitment(amount, blinding2, ownerPubKeyX);

    expect(c1).to.not.equal(c2);
  });
});
