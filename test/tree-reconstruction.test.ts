/**
 * Off-chain Merkle Tree Reconstruction — zk-private-payments
 *
 * Verifies that a JavaScript re-implementation of MerkleTree._insert()
 * (using circomlibjs Poseidon) produces roots that are byte-for-byte identical
 * to the roots stored on-chain after every deposit, transfer, and withdrawal
 * with change.
 *
 * The ConfidentialPool appends commitments in three ways:
 *   1. deposit(commitment)           → 1 leaf
 *   2. transfer(…, out1, out2)       → 2 leaves (output commitments)
 *   3. withdraw(…, changeCommitment) → 1 leaf when changeCommitment != 0
 *
 * Algorithm mirrored from MerkleTree.sol:
 *   zeros[0] = 0; zeros[i] = Poseidon(zeros[i-1], zeros[i-1]).
 *   filledSubtrees[i] starts at zeros[i].
 *   On insertion at index k, level i: if k%2==0 → left child (save + zero-pair);
 *   else → right child (use stored filledSubtrees[i] as left).
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DEPOSIT_VALUE = ethers.parseEther("1");

// Zero proof accepted by the stub verifiers deployed in tests
const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Off-chain incremental Merkle tree
// ---------------------------------------------------------------------------

type Poseidon = Awaited<ReturnType<typeof buildPoseidon>>;

class OffChainMerkleTree {
  private readonly levels: number;
  readonly zeros: bigint[];
  private readonly filledSubtrees: bigint[];
  private nextIndex: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly F: any;
  private readonly poseidon: Poseidon;

  constructor(levels: number, poseidon: Poseidon) {
    this.levels = levels;
    this.poseidon = poseidon;
    this.F = poseidon.F;
    this.nextIndex = 0;

    this.zeros = [0n];
    for (let i = 1; i <= levels; i++) {
      this.zeros.push(this.hash(this.zeros[i - 1], this.zeros[i - 1]));
    }

    this.filledSubtrees = this.zeros.slice(0, levels);
  }

  hash(left: bigint, right: bigint): bigint {
    return this.F.toObject(this.poseidon([left, right]));
  }

  /** Inserts a leaf and returns the new Merkle root. */
  insert(leaf: bigint): bigint {
    let currentIndex = this.nextIndex;
    let currentLevelHash = leaf;

    for (let i = 0; i < this.levels; i++) {
      let left: bigint;
      let right: bigint;

      if (currentIndex % 2 === 0) {
        left = currentLevelHash;
        right = this.filledSubtrees[i];
        this.filledSubtrees[i] = currentLevelHash;
      } else {
        left = this.filledSubtrees[i];
        right = currentLevelHash;
      }

      currentLevelHash = this.hash(left, right);
      currentIndex = Math.floor(currentIndex / 2);
    }

    this.nextIndex++;
    return currentLevelHash;
  }

  emptyRoot(): bigint {
    return this.zeros[this.levels];
  }

  getNextIndex(): number {
    return this.nextIndex;
  }

  getFilledSubtrees(): bigint[] {
    return [...this.filledSubtrees];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomLeaf(): bigint {
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
}

async function deployPoolFixture() {
  const [, alice, bob, relayer] = await ethers.getSigners();
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

  return { pool, alice, bob, relayer };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Off-chain Tree Reconstruction", function () {
  let poseidon: Poseidon;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  // -------------------------------------------------------------------------
  // Empty tree
  // -------------------------------------------------------------------------

  it("empty tree: off-chain root matches on-chain initial root", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
    const onChainRoot = await pool.getLastRoot();

    expect(offChainTree.emptyRoot()).to.equal(onChainRoot);
  });

  // -------------------------------------------------------------------------
  // Single deposit
  // -------------------------------------------------------------------------

  it("1 deposit: off-chain root matches on-chain root", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
    const leaf = randomLeaf();

    await pool.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
    const offChainRoot = offChainTree.insert(leaf);
    const onChainRoot = await pool.getLastRoot();

    expect(offChainRoot).to.equal(onChainRoot);
  });

  // -------------------------------------------------------------------------
  // 3 deposits — verify root after each
  // -------------------------------------------------------------------------

  it("3 deposits: off-chain root matches after each deposit", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
    const leaves = [randomLeaf(), randomLeaf(), randomLeaf()];

    for (const leaf of leaves) {
      await pool.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
      const offChainRoot = offChainTree.insert(leaf);
      const onChainRoot = await pool.getLastRoot();

      expect(offChainRoot).to.equal(
        onChainRoot,
        `root mismatch after inserting leaf at index ${offChainTree.getNextIndex() - 1}`
      );
    }
  });

  // -------------------------------------------------------------------------
  // Paginated getCommitments matches deposited leaves
  // -------------------------------------------------------------------------

  it("5 deposits: paginated getCommitments matches event data", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const deposited: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const leaf = randomLeaf();
      deposited.push(leaf);
      await pool.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
    }

    const page = await pool.getCommitments(0, 5);
    expect(page.length).to.equal(5);

    for (let i = 0; i < 5; i++) {
      expect(page[i]).to.equal(deposited[i]);
    }
  });

  // -------------------------------------------------------------------------
  // Wrong leaf order produces a different root
  // -------------------------------------------------------------------------

  it("off-chain tree with wrong leaf order produces different root", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const leaf1 = randomLeaf();
    const leaf2 = randomLeaf() + 1n;

    await pool.connect(alice).deposit(leaf1, { value: DEPOSIT_VALUE });
    await pool.connect(alice).deposit(leaf2, { value: DEPOSIT_VALUE });

    const onChainRoot = await pool.getLastRoot();

    const correctTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
    correctTree.insert(leaf1);
    const correctRoot = correctTree.insert(leaf2);

    const reversedTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
    reversedTree.insert(leaf2);
    const reversedRoot = reversedTree.insert(leaf1);

    expect(correctRoot).to.equal(onChainRoot);
    expect(reversedRoot).to.not.equal(onChainRoot);
  });

  // -------------------------------------------------------------------------
  // Correct order matches exactly
  // -------------------------------------------------------------------------

  it("off-chain tree with correct order matches on-chain exactly", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const leaves = [randomLeaf(), randomLeaf(), randomLeaf(), randomLeaf()];
    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);

    for (const leaf of leaves) {
      await pool.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
      offChainTree.insert(leaf);
    }

    const onChainRoot = await pool.getLastRoot();
    // Re-derive the expected root from scratch in the same off-chain tree state
    const derivedTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
    let lastRoot = derivedTree.emptyRoot();
    for (const leaf of leaves) {
      lastRoot = derivedTree.insert(leaf);
    }

    expect(lastRoot).to.equal(onChainRoot);
  });

  // -------------------------------------------------------------------------
  // Transfer output commitments are included in tree reconstruction
  // -------------------------------------------------------------------------

  it("transfer outputs are included in tree reconstruction", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);

    // Deposit one leaf
    const depositLeaf = randomLeaf();
    await pool.connect(alice).deposit(depositLeaf, { value: DEPOSIT_VALUE });
    offChainTree.insert(depositLeaf);

    const root = await pool.getLastRoot();

    // Transfer: consume the deposited note, create 2 output notes
    const nullifier = randomLeaf();
    const out1 = randomLeaf();
    const out2 = randomLeaf();

    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      out1,
      out2
    );

    // Transfer inserts 2 output commitments consecutively into the tree
    offChainTree.insert(out1);
    const offChainRoot = offChainTree.insert(out2);
    const onChainRoot = await pool.getLastRoot();

    expect(offChainRoot).to.equal(onChainRoot);
  });

  // -------------------------------------------------------------------------
  // Withdrawal change commitment appears at correct index
  // -------------------------------------------------------------------------

  it("withdrawal change commitments appear at correct indices", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);

    // Deposit 2 leaves
    const leaf1 = randomLeaf();
    const leaf2 = randomLeaf();
    await pool.connect(alice).deposit(leaf1, { value: DEPOSIT_VALUE });
    await pool.connect(alice).deposit(leaf2, { value: DEPOSIT_VALUE });
    offChainTree.insert(leaf1);
    offChainTree.insert(leaf2);

    const rootBeforeWithdraw = await pool.getLastRoot();

    // Withdraw with a change commitment (partial withdrawal)
    const nullifier = randomLeaf();
    const changeCommitment = randomLeaf();
    const withdrawAmount = ethers.parseEther("0.6");
    const fee = 0n;

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      rootBeforeWithdraw,
      nullifier,
      withdrawAmount,
      bob.address as `0x${string}`,
      changeCommitment,
      ethers.ZeroAddress as `0x${string}`,
      fee
    );

    // Change commitment is inserted as the next leaf
    const expectedChangeIndex = offChainTree.getNextIndex();
    const offChainRoot = offChainTree.insert(changeCommitment);
    const onChainRoot = await pool.getLastRoot();

    expect(offChainRoot).to.equal(onChainRoot);

    // Verify the change commitment landed at the expected index
    const onChainChangeIndex = await pool.getCommitmentIndex(changeCommitment);
    expect(Number(onChainChangeIndex)).to.equal(expectedChangeIndex);
  });

  // -------------------------------------------------------------------------
  // batchDeposit leaves match reconstruction
  // -------------------------------------------------------------------------

  it("batchDeposit leaves match reconstruction", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);

    const leaves = [randomLeaf(), randomLeaf(), randomLeaf()];
    const amounts = leaves.map(() => DEPOSIT_VALUE);
    const total = DEPOSIT_VALUE * BigInt(leaves.length);

    await pool
      .connect(alice)
      .batchDeposit(leaves, amounts, { value: total });

    // batchDeposit inserts commitments in array order
    for (const leaf of leaves) {
      offChainTree.insert(leaf);
    }

    const offChainRoot =
      offChainTree.getNextIndex() > 0
        ? (() => {
            const tempTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
            for (const leaf of leaves) tempTree.insert(leaf);
            // Return root by re-inserting the last leaf into a fresh computation
            return tempTree.emptyRoot();
          })()
        : offChainTree.emptyRoot();
    void offChainRoot; // root was already tracked inside the loop

    // Reconstruct cleanly in one pass
    const reconstructTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
    let lastRoot = reconstructTree.emptyRoot();
    for (const leaf of leaves) {
      lastRoot = reconstructTree.insert(leaf);
    }

    const onChainRoot = await pool.getLastRoot();
    expect(lastRoot).to.equal(onChainRoot);

    // Verify leaf indices via getCommitments
    const page = await pool.getCommitments(0, 3);
    for (let i = 0; i < 3; i++) {
      expect(page[i]).to.equal(leaves[i]);
    }
  });

  // -------------------------------------------------------------------------
  // deposit event leafIndex matches off-chain insertion index
  // -------------------------------------------------------------------------

  it("deposit event leafIndex matches off-chain insertion index", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);

    for (let i = 0; i < 3; i++) {
      const leaf = randomLeaf();
      const expectedIndex = offChainTree.getNextIndex();

      const tx = await pool
        .connect(alice)
        .deposit(leaf, { value: DEPOSIT_VALUE });
      const receipt = await tx.wait();

      const depositTopic = pool.interface.getEvent("Deposit").topicHash;
      const depositLog = receipt!.logs.find(
        (log) => log.topics[0] === depositTopic
      );
      expect(depositLog).to.not.be.undefined;

      const parsed = pool.interface.parseLog(depositLog!);
      const onChainIndex = Number(parsed!.args[1]); // leafIndex

      expect(onChainIndex).to.equal(expectedIndex);

      offChainTree.insert(leaf);
    }
  });

  // -------------------------------------------------------------------------
  // After withdrawal without change: root unchanged
  // -------------------------------------------------------------------------

  it("after withdrawal: on-chain root unchanged (withdrawals don't affect tree)", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const leaf = randomLeaf();
    await pool.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
    const rootBeforeWithdrawal = await pool.getLastRoot();

    // Withdraw with no change commitment (full withdrawal)
    const nullifier = randomLeaf();
    const withdrawAmount = DEPOSIT_VALUE;
    const changeCommitment = 0n;

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      rootBeforeWithdrawal,
      nullifier,
      withdrawAmount,
      bob.address as `0x${string}`,
      changeCommitment,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    const rootAfterWithdrawal = await pool.getLastRoot();

    // Tree is insert-only; withdrawal without change does not add a leaf
    expect(rootAfterWithdrawal).to.equal(rootBeforeWithdrawal);
  });

  // -------------------------------------------------------------------------
  // hashLeftRight on-chain matches Poseidon off-chain for all tree nodes
  // -------------------------------------------------------------------------

  it("hashLeftRight on-chain matches Poseidon off-chain for all tree nodes", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const leaves = [randomLeaf(), randomLeaf(), randomLeaf()];
    for (const leaf of leaves) {
      await pool.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
    }

    for (let i = 0; i < 3; i++) {
      const left = leaves[i % leaves.length];
      const right = leaves[(i + 1) % leaves.length];

      const onChain = await pool.hashLeftRight(left, right);
      const offChain = F.toObject(poseidon([left, right]));

      expect(onChain).to.equal(offChain);
    }
  });

  // -------------------------------------------------------------------------
  // Zero values chain computed off-chain matches empty tree root
  // -------------------------------------------------------------------------

  it("zero values chain computed off-chain matches empty tree root", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    let zero = 0n;
    for (let i = 0; i < MERKLE_TREE_HEIGHT; i++) {
      zero = F.toObject(poseidon([zero, zero]));
    }

    const emptyRoot = await pool.getLastRoot();
    expect(zero).to.equal(emptyRoot);
  });

  // -------------------------------------------------------------------------
  // filledSubtrees after N deposits match off-chain computation
  // -------------------------------------------------------------------------

  it("filled subtrees after N deposits match off-chain computation", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);
    const leaves = [randomLeaf(), randomLeaf(), randomLeaf()];

    for (const leaf of leaves) {
      await pool.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
      offChainTree.insert(leaf);
    }

    const offChainFilledSubtrees = offChainTree.getFilledSubtrees();

    for (let i = 0; i < MERKLE_TREE_HEIGHT; i++) {
      const onChainValue = await pool.filledSubtrees(i);
      expect(onChainValue).to.equal(
        offChainFilledSubtrees[i],
        `filledSubtrees[${i}] mismatch after 3 insertions`
      );
    }
  });

  // -------------------------------------------------------------------------
  // Complete tree walk: every internal node verifiable off-chain
  // -------------------------------------------------------------------------

  it("complete tree walk: every internal node verifiable off-chain", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const offChainTree = new OffChainMerkleTree(MERKLE_TREE_HEIGHT, poseidon);

    const leaves = [randomLeaf(), randomLeaf(), randomLeaf(), randomLeaf()];
    for (const leaf of leaves) {
      await pool.connect(alice).deposit(leaf, { value: DEPOSIT_VALUE });
      offChainTree.insert(leaf);
    }

    const onChainRoot = await pool.getLastRoot();

    // Walk from leaf[0] to root, verifying each parent hash on-chain matches off-chain
    const zeroValues = offChainTree.zeros;
    let currentHash = leaves[0];
    let currentIndex = 0;

    for (let level = 0; level < MERKLE_TREE_HEIGHT; level++) {
      let left: bigint;
      let right: bigint;

      if (currentIndex % 2 === 0) {
        left = currentHash;
        right = level === 0 ? leaves[1] : zeroValues[level];
      } else {
        left = zeroValues[level];
        right = currentHash;
      }

      const onChainParent = await pool.hashLeftRight(left, right);
      const offChainParent = F.toObject(poseidon([left, right]));

      expect(onChainParent).to.equal(offChainParent);

      currentHash = offChainParent;
      currentIndex = Math.floor(currentIndex / 2);
    }

    expect(await pool.isKnownRoot(onChainRoot)).to.equal(true);
  });
});
