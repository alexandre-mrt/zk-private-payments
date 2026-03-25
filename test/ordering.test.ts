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
// Poseidon helpers — initialised once to avoid rebuilding per-test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidon: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;

before(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

/** Compute note commitment: Poseidon(amount, blinding, ownerPubKeyX) */
function computeCommitment(
  amount: bigint,
  blinding: bigint,
  ownerPubKeyX: bigint
): bigint {
  return F.toObject(poseidon([amount, blinding, ownerPubKeyX]));
}

/** Compute nullifier: Poseidon(commitment, spendingKey) */
function computeNullifier(commitment: bigint, spendingKey: bigint): bigint {
  return F.toObject(poseidon([commitment, spendingKey]));
}

/** Random 31-byte field element, guaranteed < FIELD_SIZE. */
function rand(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5, // 32-leaf tree
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie, relayer };
}

// ---------------------------------------------------------------------------
// Typed helpers wrapping the pool operations
// ---------------------------------------------------------------------------

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function deposit(
  pool: Pool,
  signer: Signer,
  commitment: bigint,
  amount: bigint
): Promise<void> {
  await pool.connect(signer).deposit(commitment, { value: amount });
}

async function transfer(
  pool: Pool,
  root: bigint,
  nullifier: bigint,
  out1: bigint,
  out2: bigint
): Promise<void> {
  await pool.transfer(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    out1,
    out2
  );
}

async function withdraw(
  pool: Pool,
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment = 0n
): Promise<void> {
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient as `0x${string}`,
    changeCommitment,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Operation Ordering", function () {
  // -------------------------------------------------------------------------
  // 1. Deposit A then B has same set membership as deposit B then A
  // -------------------------------------------------------------------------

  it("deposit A then B has same set membership as deposit B then A (set, not order)", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const cA = computeCommitment(rand(), rand(), rand());
    const cB = computeCommitment(rand(), rand(), rand());
    const amtA = ethers.parseEther("1");
    const amtB = ethers.parseEther("2");

    await deposit(pool, alice, cA, amtA);
    await deposit(pool, bob, cB, amtB);
    const rootAB = await pool.getLastRoot();

    // Fresh instance with reversed order
    const { pool: pool2, alice: a2, bob: b2 } = await loadFixture(deployPoolFixture);
    await deposit(pool2, b2, cB, amtB);
    await deposit(pool2, a2, cA, amtA);
    const rootBA = await pool2.getLastRoot();

    // Both commitments must exist in each pool
    expect(await pool.commitments(cA)).to.be.true;
    expect(await pool.commitments(cB)).to.be.true;
    expect(await pool2.commitments(cA)).to.be.true;
    expect(await pool2.commitments(cB)).to.be.true;

    // Insertion order determines the Merkle root — the roots differ
    expect(rootAB).to.not.equal(rootBA);
  });

  // -------------------------------------------------------------------------
  // 2. Withdrawal order doesn't affect final pool balance
  // -------------------------------------------------------------------------

  it("withdrawal order doesn't affect final pool balance", async function () {
    const { pool, alice, bob, charlie, relayer } =
      await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");

    const cA = computeCommitment(amt, rand(), rand());
    const cB = computeCommitment(amt, rand(), rand());
    const cC = computeCommitment(amt, rand(), rand());

    await deposit(pool, alice, cA, amt);
    await deposit(pool, bob, cB, amt);
    await deposit(pool, charlie, cC, amt);

    const root = await pool.getLastRoot();
    const poolAddr = await pool.getAddress();
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(amt * 3n);

    const nA = computeNullifier(cA, rand());
    const nB = computeNullifier(cB, rand());
    const nC = computeNullifier(cC, rand());

    // Withdraw in reverse order: C, A, B
    const recipientAddr = relayer.address;
    await withdraw(pool, root, nC, amt, recipientAddr);
    await withdraw(pool, root, nA, amt, recipientAddr);
    await withdraw(pool, root, nB, amt, recipientAddr);

    expect(await ethers.provider.getBalance(poolAddr)).to.equal(0n);

    const stats = await pool.getPoolStats();
    expect(stats._totalWithdrawn).to.equal(amt * 3n);
    expect(stats._withdrawalCount).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // 3. Three deposits + 3 withdrawals in any order: balance always correct
  // -------------------------------------------------------------------------

  it("3 deposits + 3 withdrawals in any order: balance always correct", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");
    const cA = computeCommitment(amt, rand(), rand());
    const cB = computeCommitment(amt, rand(), rand());
    const cC = computeCommitment(amt, rand(), rand());

    await deposit(pool, alice, cA, amt);
    await deposit(pool, bob, cB, amt);
    await deposit(pool, charlie, cC, amt);

    const root = await pool.getLastRoot();
    const poolAddr = await pool.getAddress();

    const nA = computeNullifier(cA, rand());
    const nB = computeNullifier(cB, rand());
    const nC = computeNullifier(cC, rand());
    const recipientAddr = alice.address;

    // Verify balance decrements correctly at each step (out-of-deposit order)
    await withdraw(pool, root, nB, amt, recipientAddr);
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(amt * 2n);

    await withdraw(pool, root, nC, amt, recipientAddr);
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(amt * 1n);

    await withdraw(pool, root, nA, amt, recipientAddr);
    expect(await ethers.provider.getBalance(poolAddr)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // 4. Deposit then transfer then deposit: all indices correct
  // -------------------------------------------------------------------------

  it("deposit then transfer then deposit: all indices correct", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");
    const cA = computeCommitment(amt, rand(), rand());
    const cB = computeCommitment(amt, rand(), rand());

    // Deposit A at index 0
    await deposit(pool, alice, cA, amt);
    expect(await pool.commitmentIndex(cA)).to.equal(0n);

    const rootAfterDeposit = await pool.getLastRoot();
    const nA = computeNullifier(cA, rand());
    const out1 = computeCommitment(rand(), rand(), rand());
    const out2 = computeCommitment(rand(), rand(), rand());

    // Transfer: spends A, creates out1 at index 1 and out2 at index 2
    await transfer(pool, rootAfterDeposit, nA, out1, out2);
    expect(await pool.commitmentIndex(out1)).to.equal(1n);
    expect(await pool.commitmentIndex(out2)).to.equal(2n);

    // New deposit B at index 3 (after the two transfer outputs)
    await deposit(pool, bob, cB, amt);
    expect(await pool.commitmentIndex(cB)).to.equal(3n);
    expect(await pool.nextIndex()).to.equal(4n);
  });

  // -------------------------------------------------------------------------
  // 5. Transfer output indices follow after deposit indices
  // -------------------------------------------------------------------------

  it("transfer output indices follow after deposit indices", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amt1 = ethers.parseEther("2");
    const amt2 = ethers.parseEther("3");
    const cA = computeCommitment(amt1, rand(), rand());
    const cB = computeCommitment(amt2, rand(), rand());

    // Two deposits: indices 0 and 1
    await deposit(pool, alice, cA, amt1);
    await deposit(pool, bob, cB, amt2);
    expect(await pool.nextIndex()).to.equal(2n);

    const root = await pool.getLastRoot();
    const nA = computeNullifier(cA, rand());
    const out1 = computeCommitment(rand(), rand(), rand());
    const out2 = computeCommitment(rand(), rand(), rand());

    // Transfer outputs go to indices 2 and 3
    await transfer(pool, root, nA, out1, out2);
    expect(await pool.commitmentIndex(out1)).to.equal(2n);
    expect(await pool.commitmentIndex(out2)).to.equal(3n);
    expect(await pool.nextIndex()).to.equal(4n);
  });

  // -------------------------------------------------------------------------
  // 6. batchDeposit followed by single deposit: indices continuous
  // -------------------------------------------------------------------------

  it("batchDeposit followed by single deposit: indices continuous", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");
    const cA = computeCommitment(amt, rand(), rand());
    const cB = computeCommitment(amt, rand(), rand());
    const cC = computeCommitment(amt, rand(), rand());
    const cD = computeCommitment(amt, rand(), rand());

    // Batch of 3 (indices 0, 1, 2)
    await pool
      .connect(alice)
      .batchDeposit([cA, cB, cC], [amt, amt, amt], { value: amt * 3n });

    expect(await pool.commitmentIndex(cA)).to.equal(0n);
    expect(await pool.commitmentIndex(cB)).to.equal(1n);
    expect(await pool.commitmentIndex(cC)).to.equal(2n);
    expect(await pool.nextIndex()).to.equal(3n);

    // Single deposit after batch lands at index 3
    await deposit(pool, bob, cD, amt);
    expect(await pool.commitmentIndex(cD)).to.equal(3n);
    expect(await pool.nextIndex()).to.equal(4n);
  });

  // -------------------------------------------------------------------------
  // 7. Withdrawal change commitment gets next index after transfers
  // -------------------------------------------------------------------------

  it("withdrawal change commitment gets next index after transfers", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const depositAmt = ethers.parseEther("2");
    const withdrawAmt = ethers.parseEther("1.5");
    const changeAmt = ethers.parseEther("0.5");

    const cA = computeCommitment(depositAmt, rand(), rand());
    const cB = computeCommitment(depositAmt, rand(), rand());

    // Two deposits: indices 0 and 1
    await deposit(pool, alice, cA, depositAmt);
    await deposit(pool, bob, cB, depositAmt);

    const rootAfterDeposits = await pool.getLastRoot();
    const nA = computeNullifier(cA, rand());

    // Transfer B: spends B, outputs at indices 2 and 3
    const nB = computeNullifier(cB, rand());
    const out1 = computeCommitment(rand(), rand(), rand());
    const out2 = computeCommitment(rand(), rand(), rand());
    await transfer(pool, rootAfterDeposits, nB, out1, out2);
    expect(await pool.nextIndex()).to.equal(4n);

    // Withdraw A with change — change note lands at index 4
    const changeCommitment = computeCommitment(changeAmt, rand(), rand());
    const rootAfterTransfer = await pool.getLastRoot();
    await withdraw(pool, rootAfterTransfer, nA, withdrawAmt, alice.address, changeCommitment);

    expect(await pool.commitments(changeCommitment)).to.be.true;
    expect(await pool.commitmentIndex(changeCommitment)).to.equal(4n);
    expect(await pool.nextIndex()).to.equal(5n);
  });

  // -------------------------------------------------------------------------
  // 8. Mixed deposit/transfer/withdraw: all stats consistent at every step
  // -------------------------------------------------------------------------

  it("mixed deposit/transfer/withdraw: all stats consistent at every step", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");
    const cA = computeCommitment(amt, rand(), rand());
    const cB = computeCommitment(amt, rand(), rand());
    const cC = computeCommitment(amt, rand(), rand());

    // Step 1: 3 deposits
    await deposit(pool, alice, cA, amt);
    await deposit(pool, bob, cB, amt);
    await deposit(pool, charlie, cC, amt);

    let stats = await pool.getPoolStats();
    expect(stats._depositCount).to.equal(3n);
    expect(stats._totalDeposited).to.equal(amt * 3n);
    expect(stats._totalTransfers).to.equal(0n);
    expect(stats._withdrawalCount).to.equal(0n);
    expect(stats._poolBalance).to.equal(amt * 3n);

    // Step 2: transfer A → out1, out2
    const root1 = await pool.getLastRoot();
    const nA = computeNullifier(cA, rand());
    const out1 = computeCommitment(rand(), rand(), rand());
    const out2 = computeCommitment(rand(), rand(), rand());
    await transfer(pool, root1, nA, out1, out2);

    stats = await pool.getPoolStats();
    // nextIndex = 3 deposits + 2 transfer outputs = 5
    expect(stats._depositCount).to.equal(5n);
    expect(stats._totalTransfers).to.equal(1n);
    expect(stats._totalDeposited).to.equal(amt * 3n); // no ETH entered on transfer
    expect(stats._poolBalance).to.equal(amt * 3n);

    // Step 3: withdraw B (full, no change)
    const root2 = await pool.getLastRoot();
    const nB = computeNullifier(cB, rand());
    await withdraw(pool, root2, nB, amt, bob.address);

    stats = await pool.getPoolStats();
    expect(stats._withdrawalCount).to.equal(1n);
    expect(stats._totalWithdrawn).to.equal(amt);
    expect(stats._poolBalance).to.equal(amt * 2n);

    // Step 4: withdraw C (full, no change)
    const root3 = await pool.getLastRoot();
    const nC = computeNullifier(cC, rand());
    await withdraw(pool, root3, nC, amt, charlie.address);

    stats = await pool.getPoolStats();
    expect(stats._withdrawalCount).to.equal(2n);
    expect(stats._totalWithdrawn).to.equal(amt * 2n);
    expect(stats._poolBalance).to.equal(amt * 1n);

    // Active note count: nextIndex - (withdrawals + transfers) = 5 - (2 + 1) = 2
    // (out1 and out2 from the transfer are still unspent)
    expect(await pool.getActiveNoteCount()).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // 9. Pause between deposits doesn't affect tree integrity
  // -------------------------------------------------------------------------

  it("pause between deposits doesn't affect tree integrity", async function () {
    const { pool, owner, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");
    const c0 = computeCommitment(amt, rand(), rand());
    const c1 = computeCommitment(amt, rand(), rand());
    const c2 = computeCommitment(amt, rand(), rand());

    await deposit(pool, alice, c0, amt); // index 0

    await pool.connect(owner).pause();
    await pool.connect(owner).unpause();

    await deposit(pool, bob, c1, amt);    // index 1
    await deposit(pool, charlie, c2, amt); // index 2

    expect(await pool.nextIndex()).to.equal(3n);
    expect(await pool.indexToCommitment(0)).to.equal(c0);
    expect(await pool.indexToCommitment(1)).to.equal(c1);
    expect(await pool.indexToCommitment(2)).to.equal(c2);
    expect(await pool.commitmentIndex(c0)).to.equal(0n);
    expect(await pool.commitmentIndex(c1)).to.equal(1n);
    expect(await pool.commitmentIndex(c2)).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // 10. Two deposits in same fixture produce different roots
  // -------------------------------------------------------------------------

  it("two deposits in same fixture produce different roots", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");
    await deposit(pool, alice, computeCommitment(amt, rand(), rand()), amt);
    const rootAfterFirst = await pool.getLastRoot();

    await deposit(pool, bob, computeCommitment(amt, rand(), rand()), amt);
    const rootAfterSecond = await pool.getLastRoot();

    expect(rootAfterFirst).to.not.equal(rootAfterSecond);
    expect(await pool.isKnownRoot(rootAfterFirst)).to.be.true;
    expect(await pool.isKnownRoot(rootAfterSecond)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 11. Withdrawal with older root still works after new deposits
  // -------------------------------------------------------------------------

  it("withdrawal with older root still works after new deposits", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");
    const c0 = computeCommitment(amt, rand(), rand());
    await deposit(pool, alice, c0, amt);
    const oldRoot = await pool.getLastRoot();

    // More deposits to advance the root
    await deposit(pool, bob, computeCommitment(amt, rand(), rand()), amt);
    await deposit(pool, charlie, computeCommitment(amt, rand(), rand()), amt);

    // Old root must still be valid (within ROOT_HISTORY_SIZE = 30)
    expect(await pool.isKnownRoot(oldRoot)).to.be.true;

    // Spend c0 using the old root
    const n0 = computeNullifier(c0, rand());
    await expect(
      withdraw(pool, oldRoot, n0, amt, alice.address)
    ).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // 12. getCommitments order matches deposit+transfer order regardless of timing
  // -------------------------------------------------------------------------

  it("getCommitments order matches deposit + transfer order regardless of timing", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    const amt = ethers.parseEther("1");
    const c0 = computeCommitment(amt, rand(), rand());
    const c1 = computeCommitment(amt, rand(), rand());

    await deposit(pool, alice, c0, amt); // index 0

    // Pause/unpause timing variation
    await pool.connect(owner).pause();
    await pool.connect(owner).unpause();

    await deposit(pool, bob, c1, amt); // index 1

    const rootAfterDeposits = await pool.getLastRoot();
    const n0 = computeNullifier(c0, rand());
    const out1 = computeCommitment(rand(), rand(), rand());
    const out2 = computeCommitment(rand(), rand(), rand());
    await transfer(pool, rootAfterDeposits, n0, out1, out2); // indices 2, 3

    const all = await pool.getCommitments(0, 4);
    expect(all.length).to.equal(4);
    expect(all[0]).to.equal(c0);
    expect(all[1]).to.equal(c1);
    expect(all[2]).to.equal(out1);
    expect(all[3]).to.equal(out2);
  });
});
