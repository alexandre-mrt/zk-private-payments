import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";

const MERKLE_TREE_HEIGHT = 5;
const DEPOSIT_VALUE = ethers.parseEther("1");
const ROOT_HISTORY_SIZE = 30n;

// 31 random bytes stay well below FIELD_SIZE (BN254 prime)
function randomLeaf(): bigint {
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
}

async function deployPoolFixture() {
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

  return { pool };
}

describe("Merkle Tree Mathematical Properties — zk-private-payments", function () {
  // circomlibjs Poseidon instance, built once for the whole suite
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  // ---------------------------------------------------------------------------
  // Empty tree
  // ---------------------------------------------------------------------------

  it("empty tree root is deterministic (same across deployments)", async function () {
    // Deploy two independent instances and compare their initial roots
    const { pool: pool1 } = await deployPoolFixture();
    const { pool: pool2 } = await deployPoolFixture();

    const root1 = await pool1.getLastRoot();
    const root2 = await pool2.getLastRoot();

    expect(root1).to.equal(root2);
    expect(root1).to.not.equal(0n);
  });

  // ---------------------------------------------------------------------------
  // Root mutation on insertion
  // ---------------------------------------------------------------------------

  it("root changes after every insertion", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    const [, alice] = await ethers.getSigners();

    const roots: bigint[] = [await pool.getLastRoot()];

    for (let i = 0; i < 3; i++) {
      await pool.connect(alice).deposit(randomLeaf(), { value: DEPOSIT_VALUE });
      const newRoot = await pool.getLastRoot();
      expect(newRoot).to.not.equal(roots[roots.length - 1]);
      roots.push(newRoot);
    }

    // All collected roots must be distinct
    const unique = new Set(roots.map(String));
    expect(unique.size).to.equal(roots.length);
  });

  it("inserting the same leaf at different positions gives different roots", async function () {
    const [, alice] = await ethers.getSigners();

    const leaf = randomLeaf();

    // Pool A: leaf at position 0
    const { pool: poolA } = await deployPoolFixture();
    await poolA.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
    const rootAtPos0 = await poolA.getLastRoot();

    // Pool B: filler at position 0, same leaf at position 1
    const filler = randomLeaf();
    const { pool: poolB } = await deployPoolFixture();
    await poolB.connect(alice).deposit(filler, { value: DEPOSIT_VALUE });
    await poolB.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
    const rootAtPos1 = await poolB.getLastRoot();

    expect(rootAtPos0).to.not.equal(rootAtPos1);
  });

  // ---------------------------------------------------------------------------
  // hashLeftRight properties
  // ---------------------------------------------------------------------------

  it("hashLeftRight is not commutative: hash(a,b) != hash(b,a) for a != b", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const a = randomLeaf();
    const b = a + 1n;

    const ab = await pool.hashLeftRight(a, b);
    const ba = await pool.hashLeftRight(b, a);

    expect(ab).to.not.equal(ba);
  });

  it("hashLeftRight is deterministic: same inputs always produce the same output", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const a = randomLeaf();
    const b = randomLeaf();

    const first = await pool.hashLeftRight(a, b);
    const second = await pool.hashLeftRight(a, b);

    expect(first).to.equal(second);
  });

  // ---------------------------------------------------------------------------
  // Zero-value chain
  // ---------------------------------------------------------------------------

  it("zero values chain: zeros[i+1] = hash(zeros[i], zeros[i])", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    let currentZero = 0n;
    for (let i = 0; i < MERKLE_TREE_HEIGHT; i++) {
      const next = await pool.hashLeftRight(currentZero, currentZero);
      const offChain = F.toObject(poseidon([currentZero, currentZero]));
      expect(next).to.equal(offChain);
      currentZero = next;
    }

    // currentZero is now the expected empty-tree root
    const emptyRoot = await pool.getLastRoot();
    expect(emptyRoot).to.equal(currentZero);
  });

  // ---------------------------------------------------------------------------
  // Root after N insertions is independent of insertion timing
  // ---------------------------------------------------------------------------

  it("tree root after N insertions is independent of insertion timing", async function () {
    const [, alice] = await ethers.getSigners();

    const leaves = Array.from({ length: 4 }, () => randomLeaf());

    const { pool: poolA } = await deployPoolFixture();
    for (const leaf of leaves) {
      await poolA.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
    }
    const rootA = await poolA.getLastRoot();

    const { pool: poolB } = await deployPoolFixture();
    for (const leaf of leaves) {
      await poolB.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
    }
    const rootB = await poolB.getLastRoot();

    expect(rootA).to.equal(rootB);
  });

  // ---------------------------------------------------------------------------
  // Root history / isKnownRoot
  // ---------------------------------------------------------------------------

  it("isKnownRoot returns true for all roots within ROOT_HISTORY_SIZE window", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    const [, alice] = await ethers.getSigners();

    const collectedRoots: bigint[] = [await pool.getLastRoot()];

    // Insert ROOT_HISTORY_SIZE - 1 leaves (initial root occupies one slot)
    for (let i = 0; i < Number(ROOT_HISTORY_SIZE) - 1; i++) {
      await pool.connect(alice).deposit(randomLeaf(), { value: DEPOSIT_VALUE });
      collectedRoots.push(await pool.getLastRoot());
    }

    for (const root of collectedRoots) {
      expect(await pool.isKnownRoot(root)).to.equal(true);
    }
  });

  it("isKnownRoot returns false for evicted roots beyond the window", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    const [, alice] = await ethers.getSigners();

    // Capture the initial empty-tree root (slot 0)
    const evictedRoot = await pool.getLastRoot();

    // Insert ROOT_HISTORY_SIZE leaves to overwrite every slot in the ring buffer
    for (let i = 0; i < Number(ROOT_HISTORY_SIZE); i++) {
      await pool.connect(alice).deposit(randomLeaf(), { value: DEPOSIT_VALUE });
    }

    expect(await pool.isKnownRoot(evictedRoot)).to.equal(false);
  });

  it("getValidRootCount grows with deposits up to ROOT_HISTORY_SIZE", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    const [, alice] = await ethers.getSigners();

    // Initial state: 1 valid root (the empty-tree root stored at roots[0])
    expect(await pool.getValidRootCount()).to.equal(1n);

    // Each deposit adds one non-zero root to the ring buffer
    for (let i = 0; i < 3; i++) {
      await pool.connect(alice).deposit(randomLeaf(), { value: DEPOSIT_VALUE });
      const count = await pool.getValidRootCount();
      expect(count).to.equal(BigInt(i + 2));
    }

    // Once every slot is filled the count is capped at ROOT_HISTORY_SIZE
    for (let i = 4; i <= Number(ROOT_HISTORY_SIZE); i++) {
      await pool.connect(alice).deposit(randomLeaf(), { value: DEPOSIT_VALUE });
    }
    const saturatedCount = await pool.getValidRootCount();
    expect(saturatedCount).to.equal(ROOT_HISTORY_SIZE);
  });
});
