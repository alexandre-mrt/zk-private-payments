import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, PoolLens, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const TREE_CAPACITY = BigInt(2 ** TREE_HEIGHT); // 32

// Both verifiers in the test suite always return true for any proof input.
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

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

function randomNullifier(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31)) + 1n;
}

function makeCommitments(n: number): bigint[] {
  return Array.from({ length: n }, () => randomCommitment());
}

function makeAmounts(n: number, amount: bigint = ethers.parseEther("1")): bigint[] {
  return Array.from({ length: n }, () => amount);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployBaseFixture() {
  const [owner, alice, bob, recipient] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = (await Lens.deploy()) as unknown as PoolLens;

  return { pool, lens, owner, alice, bob, recipient };
}

async function deployWithReceiptFixture() {
  const base = await deployBaseFixture();

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await base.pool.getAddress()
  )) as unknown as DepositReceipt;

  await base.pool.connect(base.owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

// Helper: perform a withdrawal using dummy proof
async function doWithdraw(
  pool: ConfidentialPool,
  amount: bigint,
  recipientAddress: string,
  nullifier: bigint,
  changeCommitment: bigint = 0n
): Promise<void> {
  const root = await pool.getLastRoot();
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipientAddress as `0x${string}`,
    changeCommitment,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

// ---------------------------------------------------------------------------
// Combined Verification Tests
// ---------------------------------------------------------------------------

describe("Combined Verification", function () {
  // -----------------------------------------------------------------------
  // 1. Lens.depositCount == receipt count == event count after 3 deposits
  // -----------------------------------------------------------------------

  it("after 3 deposits: Lens.depositCount == receipt count == event count", async function () {
    const { pool, lens, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    const poolAddress = await pool.getAddress();

    const depositAmount = ethers.parseEther("1");
    for (let i = 0; i < 3; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
    }

    // Source 1: Lens snapshot
    const snapshot = await lens.getSnapshot(poolAddress);
    expect(snapshot.depositCount).to.equal(3n);

    // Source 2: DepositReceipt NFT balance
    const receiptBalance = await receipt.balanceOf(alice.address);
    expect(receiptBalance).to.equal(3n);

    // Source 3: Deposit events
    const depositEvents = await pool.queryFilter(pool.filters.Deposit());
    expect(depositEvents.length).to.equal(3);

    // All three data sources agree
    expect(snapshot.depositCount).to.equal(receiptBalance);
    expect(snapshot.depositCount).to.equal(BigInt(depositEvents.length));
  });

  // -----------------------------------------------------------------------
  // 2. Lens.withdrawalCount matches withdrawal record count
  // -----------------------------------------------------------------------

  it("after withdrawal: Lens.withdrawalCount matches withdrawal record count", async function () {
    const { pool, lens, alice, recipient } = await loadFixture(deployBaseFixture);

    const poolAddress = await pool.getAddress();

    // Two separate deposits so nextIndex >= withdrawalCount after two withdrawals.
    // (The test verifier always returns true — nullifiers do not need to correspond to real
    // committed notes, but nextIndex must stay >= withdrawalCount + totalTransfers.)
    const depositAmount = ethers.parseEther("3");
    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });

    const withdrawAmount = ethers.parseEther("1");
    const nullifier1 = randomNullifier();
    const nullifier2 = randomNullifier();

    await doWithdraw(pool, withdrawAmount, recipient.address, nullifier1);
    await doWithdraw(pool, withdrawAmount, recipient.address, nullifier2);

    // Source 1: Lens snapshot
    const snapshot = await lens.getSnapshot(poolAddress);
    expect(snapshot.withdrawalCount).to.equal(2n);

    // Source 2: on-chain withdrawal record count
    const recordCount = await pool.getWithdrawalRecordCount();
    expect(recordCount).to.equal(2n);

    // Source 3: Withdrawal events
    const withdrawalEvents = await pool.queryFilter(pool.filters.Withdrawal());
    expect(withdrawalEvents.length).to.equal(2);

    // All three agree
    expect(snapshot.withdrawalCount).to.equal(recordCount);
    expect(snapshot.withdrawalCount).to.equal(BigInt(withdrawalEvents.length));
  });

  // -----------------------------------------------------------------------
  // 3. Lens.poolBalance == provider.getBalance == totalDeposited - totalWithdrawn
  // -----------------------------------------------------------------------

  it("Lens.poolBalance == provider.getBalance == totalDeposited - totalWithdrawn", async function () {
    const { pool, lens, alice, recipient } = await loadFixture(deployBaseFixture);

    const poolAddress = await pool.getAddress();

    const depositAmount = ethers.parseEther("3");
    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });

    const withdrawAmount = ethers.parseEther("1");
    await doWithdraw(pool, withdrawAmount, recipient.address, randomNullifier());

    // Source 1: Lens snapshot poolBalance
    const snapshot = await lens.getSnapshot(poolAddress);
    const lensBalance = snapshot.poolBalance;

    // Source 2: ethers provider on-chain balance
    const providerBalance = await ethers.provider.getBalance(poolAddress);

    // Source 3: derived from totalDeposited - totalWithdrawn
    const computedBalance = snapshot.totalDeposited - snapshot.totalWithdrawn;

    expect(lensBalance).to.equal(providerBalance);
    expect(lensBalance).to.equal(computedBalance);
    expect(lensBalance).to.equal(depositAmount - withdrawAmount);
  });

  // -----------------------------------------------------------------------
  // 4. Lens.activeNotes == deposit insertions + transfer insertions - nullifiers spent
  // -----------------------------------------------------------------------

  it("Lens.activeNotes == deposit insertions + transfer insertions - nullifiers spent", async function () {
    const { pool, lens, alice, bob, recipient } = await loadFixture(deployBaseFixture);

    const poolAddress = await pool.getAddress();

    // 3 deposits
    const depositAmount = ethers.parseEther("5");
    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();
    await pool.connect(alice).deposit(c1, { value: depositAmount });
    await pool.connect(alice).deposit(c2, { value: depositAmount });
    await pool.connect(alice).deposit(c3, { value: depositAmount });

    // 1 transfer: spends 1 nullifier, inserts 2 output commitments
    const transferNullifier = randomNullifier();
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    const root = await pool.getLastRoot();
    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      transferNullifier,
      out1,
      out2
    );

    // 1 withdrawal: spends 1 nullifier (no change note)
    const withdrawNullifier = randomNullifier();
    await doWithdraw(pool, ethers.parseEther("1"), recipient.address, withdrawNullifier);

    // Source 1: Lens snapshot activeNotes
    const snapshot = await lens.getSnapshot(poolAddress);
    const lensActiveNotes = snapshot.activeNotes;

    // Source 2: manual computation
    // nextIndex = 3 deposits + 2 transfer outputs = 5 insertions
    // nullifiers spent = 1 transfer + 1 withdrawal = 2
    // activeNotes = 5 - 2 = 3
    const totalInsertions = BigInt(await pool.getDepositCount()); // nextIndex
    const nullifiersSpent = snapshot.withdrawalCount + snapshot.totalTransfers;
    const computedActiveNotes = totalInsertions - nullifiersSpent;

    // Source 3: direct contract getter
    const contractActiveNotes = await pool.getActiveNoteCount();

    expect(lensActiveNotes).to.equal(computedActiveNotes);
    expect(lensActiveNotes).to.equal(contractActiveNotes);
    expect(lensActiveNotes).to.equal(3n);
  });

  // -----------------------------------------------------------------------
  // 5. Withdrawal record count == Lens.withdrawalCount
  // -----------------------------------------------------------------------

  it("withdrawal record count == Lens.withdrawalCount after multiple withdrawals", async function () {
    const { pool, lens, alice, recipient } = await loadFixture(deployBaseFixture);

    const poolAddress = await pool.getAddress();

    // Deposit 4 separate commitments so nextIndex (4) >= withdrawalCount (4) after 4 withdrawals.
    const depositAmount = ethers.parseEther("10");
    for (let i = 0; i < 4; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
    }

    const withdrawAmount = ethers.parseEther("1");
    const nullifiers: bigint[] = [];

    for (let i = 0; i < 4; i++) {
      const n = randomNullifier();
      nullifiers.push(n);
      await doWithdraw(pool, withdrawAmount, recipient.address, n);
    }

    // Source 1: Lens snapshot
    const snapshot = await lens.getSnapshot(poolAddress);

    // Source 2: on-chain record count
    const recordCount = await pool.getWithdrawalRecordCount();

    // Source 3: verify each nullifier is marked spent
    let spentCount = 0n;
    for (const n of nullifiers) {
      if (await pool.isSpent(n)) spentCount++;
    }

    expect(snapshot.withdrawalCount).to.equal(4n);
    expect(snapshot.withdrawalCount).to.equal(recordCount);
    expect(snapshot.withdrawalCount).to.equal(spentCount);

    // Also verify individual records have correct nullifiers
    for (let i = 0; i < 4; i++) {
      const record = await pool.getWithdrawalRecord(BigInt(i));
      expect(record.nullifier).to.equal(nullifiers[i]);
      expect(record.amount).to.equal(withdrawAmount);
    }
  });

  // -----------------------------------------------------------------------
  // 6. PoolLens version matches contract VERSION
  // -----------------------------------------------------------------------

  it("PoolLens version matches contract VERSION", async function () {
    const { pool, lens } = await loadFixture(deployBaseFixture);

    const poolAddress = await pool.getAddress();

    // Source 1: Lens snapshot version field
    const snapshot = await lens.getSnapshot(poolAddress);
    const lensVersion = snapshot.version;

    // Source 2: direct contract call
    const contractVersion = await pool.getVersion();

    // Source 3: known constant from contract
    const expectedVersion = "1.0.0";

    expect(lensVersion).to.equal(contractVersion);
    expect(lensVersion).to.equal(expectedVersion);
  });

  // -----------------------------------------------------------------------
  // 7. batchDeposit: Lens stats, receipts, and events all agree
  // -----------------------------------------------------------------------

  it("batchDeposit: Lens stats, receipts, and events all agree", async function () {
    const { pool, lens, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    const poolAddress = await pool.getAddress();

    const batchSize = 4;
    const depositAmount = ethers.parseEther("1");
    const commitments = makeCommitments(batchSize);
    const amounts = makeAmounts(batchSize, depositAmount);
    const totalValue = depositAmount * BigInt(batchSize);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: totalValue });

    // Source 1: Lens snapshot
    const snapshot = await lens.getSnapshot(poolAddress);
    expect(snapshot.depositCount).to.equal(BigInt(batchSize));
    expect(snapshot.totalDeposited).to.equal(totalValue);
    expect(snapshot.poolBalance).to.equal(totalValue);

    // Source 2: DepositReceipt NFT balance
    const receiptBalance = await receipt.balanceOf(alice.address);
    expect(receiptBalance).to.equal(BigInt(batchSize));

    // Source 3: Deposit events (one per commitment in batch)
    const depositEvents = await pool.queryFilter(pool.filters.Deposit());
    expect(depositEvents.length).to.equal(batchSize);

    // Cross-reference: all three sources agree on count
    expect(snapshot.depositCount).to.equal(receiptBalance);
    expect(snapshot.depositCount).to.equal(BigInt(depositEvents.length));

    // Each event references a commitment that was in the batch
    for (const event of depositEvents) {
      expect(commitments).to.include(event.args.commitment);
    }

    // treeUtilization matches manual computation
    const expectedUtilization = (BigInt(batchSize) * 100n) / TREE_CAPACITY;
    expect(snapshot.treeUtilization).to.equal(expectedUtilization);
  });

  // -----------------------------------------------------------------------
  // 8. All view functions return identical values when called twice
  // -----------------------------------------------------------------------

  it("all view functions return identical values when called twice", async function () {
    const { pool, lens, alice, recipient } = await loadFixture(deployBaseFixture);

    const poolAddress = await pool.getAddress();

    const depositAmount = ethers.parseEther("2");
    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
    await doWithdraw(pool, ethers.parseEther("1"), recipient.address, randomNullifier());

    // Two consecutive Lens reads with no state changes between them
    const snapshot1 = await lens.getSnapshot(poolAddress);
    const snapshot2 = await lens.getSnapshot(poolAddress);

    expect(snapshot1.totalDeposited).to.equal(snapshot2.totalDeposited);
    expect(snapshot1.totalWithdrawn).to.equal(snapshot2.totalWithdrawn);
    expect(snapshot1.totalTransfers).to.equal(snapshot2.totalTransfers);
    expect(snapshot1.depositCount).to.equal(snapshot2.depositCount);
    expect(snapshot1.withdrawalCount).to.equal(snapshot2.withdrawalCount);
    expect(snapshot1.uniqueDepositors).to.equal(snapshot2.uniqueDepositors);
    expect(snapshot1.poolBalance).to.equal(snapshot2.poolBalance);
    expect(snapshot1.activeNotes).to.equal(snapshot2.activeNotes);
    expect(snapshot1.treeUtilization).to.equal(snapshot2.treeUtilization);
    expect(snapshot1.lastRoot).to.equal(snapshot2.lastRoot);

    // Also confirm direct getPoolStats is stable
    const [td1, tw1, tt1, dc1, wc1, ud1, pb1] = await pool.getPoolStats();
    const [td2, tw2, tt2, dc2, wc2, ud2, pb2] = await pool.getPoolStats();
    expect(td1).to.equal(td2);
    expect(tw1).to.equal(tw2);
    expect(tt1).to.equal(tt2);
    expect(dc1).to.equal(dc2);
    expect(wc1).to.equal(wc2);
    expect(ud1).to.equal(ud2);
    expect(pb1).to.equal(pb2);
  });

  // -----------------------------------------------------------------------
  // 9. Lens.treeUtilization matches manual computation
  // -----------------------------------------------------------------------

  it("Lens.treeUtilization matches manual computation", async function () {
    const { pool, lens, alice } = await loadFixture(deployBaseFixture);

    const poolAddress = await pool.getAddress();

    const depositCount = 6n;
    const depositAmount = ethers.parseEther("1");
    for (let i = 0n; i < depositCount; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });
    }

    const snapshot = await lens.getSnapshot(poolAddress);

    // Source 1: Lens treeUtilization
    const lensUtilization = snapshot.treeUtilization;

    // Source 2: manual formula — (nextIndex * 100) / treeCapacity
    // Note: transfers also insert commitments into the tree (they increment nextIndex)
    const nextIndex = BigInt(await pool.getDepositCount());
    const manualUtilization = (nextIndex * 100n) / TREE_CAPACITY;

    // Source 3: direct contract getter
    const contractUtilization = await pool.getTreeUtilization();

    expect(lensUtilization).to.equal(manualUtilization);
    expect(lensUtilization).to.equal(contractUtilization);
  });

  // -----------------------------------------------------------------------
  // 10. Full cycle: all data sources agree at every step
  // -----------------------------------------------------------------------

  it("full cycle: all data sources agree at every step", async function () {
    const { pool, lens, receipt, alice, bob, recipient } = await loadFixture(
      deployWithReceiptFixture
    );

    const poolAddress = await pool.getAddress();

    // --- Step 0: empty pool ---
    let snapshot = await lens.getSnapshot(poolAddress);
    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.withdrawalCount).to.equal(0n);
    expect(snapshot.totalTransfers).to.equal(0n);
    expect(snapshot.activeNotes).to.equal(0n);
    expect(snapshot.poolBalance).to.equal(await ethers.provider.getBalance(poolAddress));

    // --- Step 1: 3 deposits (2 by alice, 1 by bob) ---
    const depositAmount = ethers.parseEther("2");
    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    await pool.connect(alice).deposit(c1, { value: depositAmount });
    await pool.connect(alice).deposit(c2, { value: depositAmount });
    await pool.connect(bob).deposit(c3, { value: depositAmount });

    snapshot = await lens.getSnapshot(poolAddress);
    const [, , , dc, , ud] = await pool.getPoolStats();

    // Lens vs direct contract
    expect(snapshot.depositCount).to.equal(dc);
    expect(snapshot.depositCount).to.equal(3n);
    expect(snapshot.uniqueDepositors).to.equal(ud);
    expect(snapshot.uniqueDepositors).to.equal(2n);

    // Lens vs receipt NFT counts
    const aliceReceipts = await receipt.balanceOf(alice.address);
    const bobReceipts = await receipt.balanceOf(bob.address);
    expect(aliceReceipts + bobReceipts).to.equal(snapshot.depositCount);

    // Lens vs Deposit events
    let depositEvents = await pool.queryFilter(pool.filters.Deposit());
    expect(BigInt(depositEvents.length)).to.equal(snapshot.depositCount);

    // Balance consistency
    expect(snapshot.poolBalance).to.equal(await ethers.provider.getBalance(poolAddress));
    expect(snapshot.poolBalance).to.equal(depositAmount * 3n);

    // activeNotes after 3 deposits, 0 transfers, 0 withdrawals = 3
    expect(snapshot.activeNotes).to.equal(3n);
    expect(snapshot.activeNotes).to.equal(await pool.getActiveNoteCount());

    // --- Step 2: 1 confidential transfer ---
    const transferNullifier = randomNullifier();
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    const root = await pool.getLastRoot();
    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      transferNullifier,
      out1,
      out2
    );

    snapshot = await lens.getSnapshot(poolAddress);

    // totalTransfers incremented
    expect(snapshot.totalTransfers).to.equal(1n);

    // Transfer events
    const transferEvents = await pool.queryFilter(pool.filters.Transfer());
    expect(BigInt(transferEvents.length)).to.equal(snapshot.totalTransfers);

    // activeNotes: 3 deposits + 2 transfer outputs - 1 transfer nullifier = 4
    expect(snapshot.activeNotes).to.equal(4n);
    expect(snapshot.activeNotes).to.equal(await pool.getActiveNoteCount());

    // Balance unchanged (no ETH moved)
    expect(snapshot.poolBalance).to.equal(depositAmount * 3n);
    expect(snapshot.poolBalance).to.equal(await ethers.provider.getBalance(poolAddress));

    // --- Step 3: 1 withdrawal ---
    const withdrawAmount = ethers.parseEther("1");
    const withdrawNullifier = randomNullifier();
    await doWithdraw(pool, withdrawAmount, recipient.address, withdrawNullifier);

    snapshot = await lens.getSnapshot(poolAddress);

    // withdrawalCount
    expect(snapshot.withdrawalCount).to.equal(1n);

    // Lens withdrawal count vs record count
    const recordCount = await pool.getWithdrawalRecordCount();
    expect(snapshot.withdrawalCount).to.equal(recordCount);

    // Withdrawal events
    let withdrawalEvents = await pool.queryFilter(pool.filters.Withdrawal());
    expect(BigInt(withdrawalEvents.length)).to.equal(snapshot.withdrawalCount);

    // isSpent for nullifier
    expect(await pool.isSpent(withdrawNullifier)).to.equal(true);

    // activeNotes: 5 insertions (3 deps + 2 transfer) - 2 spent (1 transfer + 1 withdrawal) = 3
    expect(snapshot.activeNotes).to.equal(3n);
    expect(snapshot.activeNotes).to.equal(await pool.getActiveNoteCount());

    // Balance after withdrawal
    const expectedBalance = depositAmount * 3n - withdrawAmount;
    expect(snapshot.poolBalance).to.equal(expectedBalance);
    expect(snapshot.poolBalance).to.equal(await ethers.provider.getBalance(poolAddress));
    expect(snapshot.poolBalance).to.equal(snapshot.totalDeposited - snapshot.totalWithdrawn);

    // treeUtilization: nextIndex = 3 deposits + 2 transfer outputs = 5; utilization = 5*100/32 = 15
    const nextIndex = BigInt(await pool.getDepositCount());
    const expectedUtilization = (nextIndex * 100n) / TREE_CAPACITY;
    expect(snapshot.treeUtilization).to.equal(expectedUtilization);
    expect(snapshot.treeUtilization).to.equal(await pool.getTreeUtilization());
  });
});
