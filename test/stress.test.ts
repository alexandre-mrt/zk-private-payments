import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
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

// Small tree for fast stress tests — 2^3 = 8 leaf capacity
const SMALL_TREE_HEIGHT = 3;

// Height-5 tree for root-history wrap-around test
const MEDIUM_TREE_HEIGHT = 5;

const ROOT_HISTORY_SIZE = 30;

const DEPOSIT_VALUE = ethers.parseEther("1");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

type Pool = Awaited<ReturnType<typeof deploySmallTree>>["pool"];
type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(
  pool: Pool,
  signer: Signer,
  commitment?: bigint,
  value: bigint = DEPOSIT_VALUE
) {
  const c = commitment ?? randomCommitment();
  await pool.connect(signer).deposit(c, { value });
  return { commitment: c };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deploySmallTree() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    SMALL_TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob, relayer };
}

async function deployMediumTree() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MEDIUM_TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob, relayer };
}

// ---------------------------------------------------------------------------
// Stress Tests
// ---------------------------------------------------------------------------

describe("Stress Tests", function () {
  const SMALL_CAPACITY = 2 ** SMALL_TREE_HEIGHT; // 8

  it("fills tree to capacity (8 deposits)", async function () {
    const { pool, alice } = await loadFixture(deploySmallTree);

    const commitments: bigint[] = [];
    for (let i = 0; i < SMALL_CAPACITY; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await doDeposit(pool, alice, c);
    }

    expect(await pool.nextIndex()).to.equal(BigInt(SMALL_CAPACITY));

    // All commitments must be tracked
    for (const c of commitments) {
      expect(await pool.commitments(c)).to.be.true;
    }
  });

  it("reverts on deposit when tree is full", async function () {
    const { pool, alice } = await loadFixture(deploySmallTree);

    // Fill tree to capacity
    for (let i = 0; i < SMALL_CAPACITY; i++) {
      await doDeposit(pool, alice);
    }

    // One more deposit must revert
    await expect(doDeposit(pool, alice)).to.be.revertedWith(
      "MerkleTree: tree is full"
    );
  });

  it("root changes on every deposit", async function () {
    const { pool, alice } = await loadFixture(deploySmallTree);

    const roots: Set<bigint> = new Set();

    // Capture initial root before any deposit
    roots.add(await pool.getLastRoot());

    for (let i = 0; i < SMALL_CAPACITY; i++) {
      await doDeposit(pool, alice);
      const root = await pool.getLastRoot();
      roots.add(root);
    }

    // Each deposit must produce a unique root
    expect(roots.size).to.equal(SMALL_CAPACITY + 1);
  });

  it("root history wraps correctly when > ROOT_HISTORY_SIZE deposits", async function () {
    const { pool, alice } = await loadFixture(deployMediumTree);

    // Deposit ROOT_HISTORY_SIZE + 1 times to trigger wrap-around
    const TOTAL_DEPOSITS = ROOT_HISTORY_SIZE + 1;
    const rootsInOrder: bigint[] = [];

    for (let i = 0; i < TOTAL_DEPOSITS; i++) {
      await doDeposit(pool, alice);
      rootsInOrder.push(await pool.getLastRoot());
    }

    // Root from deposit #1 should be evicted from the ring buffer
    const firstRoot = rootsInOrder[0];
    expect(await pool.isKnownRoot(firstRoot)).to.be.false;

    // Most recent root must still be known
    const lastRoot = rootsInOrder[TOTAL_DEPOSITS - 1];
    expect(await pool.isKnownRoot(lastRoot)).to.be.true;

    // Root at position ROOT_HISTORY_SIZE - 1 (just inside the window) must be known
    const rootJustBeforeWrap = rootsInOrder[ROOT_HISTORY_SIZE - 1];
    expect(await pool.isKnownRoot(rootJustBeforeWrap)).to.be.true;
  });

  it("transfer still works after many deposits", async function () {
    const { pool, alice } = await loadFixture(deployMediumTree);

    // Make 20 deposits to build up tree state
    for (let i = 0; i < 20; i++) {
      await doDeposit(pool, alice);
    }

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

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
    ).to.emit(pool, "Transfer");

    // Nullifier must be marked spent
    expect(await pool.nullifiers(nullifier)).to.be.true;

    // Both output commitments must be inserted into the tree
    expect(await pool.commitments(out1)).to.be.true;
    expect(await pool.commitments(out2)).to.be.true;
  });
});
