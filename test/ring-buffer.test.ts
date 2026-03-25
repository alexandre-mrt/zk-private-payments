import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// Tree height 6 → capacity 64.
// Height 5 (capacity 32) is insufficient: tests require up to 60 deposits
// for double-wrap and 39 for saturation. Height 6 gives capacity 64.
const MERKLE_TREE_HEIGHT = 6;
const ROOT_HISTORY_SIZE = 30;
const DEPOSIT_AMOUNT = ethers.parseEther("1");

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

async function deployPoolFixture() {
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

async function makeDeposits(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  alice: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  count: number
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await pool
      .connect(alice)
      .deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
  }
}

describe("Root History Ring Buffer", function () {
  it("initial state: currentRootIndex == 0, roots[0] is empty tree root", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const idx = await pool.currentRootIndex();
    expect(idx).to.equal(0n);

    // roots[0] must be the non-zero empty-tree root stored by the constructor
    const emptyRoot = await pool.roots(0);
    expect(emptyRoot).to.be.greaterThan(0n);

    // getLastRoot must point to roots[0]
    const lastRoot = await pool.getLastRoot();
    expect(lastRoot).to.equal(emptyRoot);
  });

  it("after 1 deposit: currentRootIndex == 1", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await makeDeposits(pool, alice, 1);

    expect(await pool.currentRootIndex()).to.equal(1n);
  });

  it("after 29 deposits: currentRootIndex == 29", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await makeDeposits(pool, alice, 29);

    expect(await pool.currentRootIndex()).to.equal(29n);
  });

  it("after 30 deposits: currentRootIndex wraps to 0", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await makeDeposits(pool, alice, 30);

    expect(await pool.currentRootIndex()).to.equal(0n);
  });

  it("after 31 deposits: currentRootIndex == 1 (wrapped)", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await makeDeposits(pool, alice, 31);

    expect(await pool.currentRootIndex()).to.equal(1n);
  });

  it("all roots within the current window are known", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    // Collect the root after each deposit
    const collectedRoots: bigint[] = [];
    for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
      collectedRoots.push(await pool.getLastRoot());
    }

    // Every root in the window must be recognised
    for (const root of collectedRoots) {
      expect(await pool.isKnownRoot(root)).to.equal(
        true,
        `Root ${root} should be known`
      );
    }
  });

  it("root at currentRootIndex - ROOT_HISTORY_SIZE is evicted", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    // Capture the very first root written (after deposit #1 → slot 1)
    await makeDeposits(pool, alice, 1);
    const firstDepositRoot = await pool.getLastRoot();

    // Advance the ring buffer by ROOT_HISTORY_SIZE more deposits so that
    // the slot holding firstDepositRoot is overwritten
    await makeDeposits(pool, alice, ROOT_HISTORY_SIZE);

    expect(await pool.isKnownRoot(firstDepositRoot)).to.equal(false);
  });

  it("getLastRoot always returns roots[currentRootIndex]", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    // Check across several deposits including a wrap-around
    for (let i = 0; i < 35; i++) {
      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

      const idx = await pool.currentRootIndex();
      const rootAtIdx = await pool.roots(idx);
      const lastRoot = await pool.getLastRoot();

      expect(lastRoot).to.equal(
        rootAtIdx,
        `Mismatch at deposit ${i + 1}: getLastRoot != roots[currentRootIndex]`
      );
    }
  });

  it("root history is circular: 60 deposits wraps twice", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    // 60 deposits = exactly 2 full revolutions of a 30-slot ring buffer.
    // Starting at index 0, after 60 deposits: (0 + 60) % 30 = 0.
    await makeDeposits(pool, alice, 60);

    expect(await pool.currentRootIndex()).to.equal(0n);
  });

  it("getRootHistory returns exactly 30 entries", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await makeDeposits(pool, alice, 5);

    const history = await pool.getRootHistory();
    expect(history.length).to.equal(ROOT_HISTORY_SIZE);
  });

  it("getValidRootCount saturates at 30", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    // Initially roots[0] is set → count is 1
    expect(await pool.getValidRootCount()).to.equal(1n);

    // After 29 deposits all 30 slots are filled
    await makeDeposits(pool, alice, 29);
    expect(await pool.getValidRootCount()).to.equal(30n);

    // Further deposits overwrite existing slots — count stays at 30
    await makeDeposits(pool, alice, 10);
    expect(await pool.getValidRootCount()).to.equal(30n);
  });

  it("evicted root is no longer known via isKnownRoot", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    // The empty-tree root sits at slot 0 initially
    const emptyTreeRoot = await pool.roots(0n);

    // 30 deposits: slot 0 is overwritten on the 30th deposit
    // (newRootIndex = (29+1) % 30 = 0)
    await makeDeposits(pool, alice, 30);

    // The empty-tree root is no longer in the ring buffer
    expect(await pool.isKnownRoot(emptyTreeRoot)).to.equal(false);
  });
});
