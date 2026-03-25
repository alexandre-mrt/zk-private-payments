import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types/contracts/ConfidentialPool.sol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32
const DEPOSIT_AMOUNT = ethers.parseEther("1");
const WITHDRAW_AMOUNT = ethers.parseEther("0.5");

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
  return ethers.toBigInt(ethers.randomBytes(31));
}

// Helper: deposit and return current root
async function depositNote(
  pool: ConfidentialPool,
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  commitment: bigint,
  value: bigint = DEPOSIT_AMOUNT
) {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

// Helper: withdraw using the dummy verifier (always returns true)
async function doWithdraw(
  pool: ConfidentialPool,
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: `0x${string}`,
  changeCommitment = 0n
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
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

// Helper: transfer using the dummy verifier (always returns true)
async function doTransfer(
  pool: ConfidentialPool,
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
// Fixtures
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = await Lens.deploy();

  return { pool, lens, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// State Consistency
// ---------------------------------------------------------------------------

describe("State Consistency", function () {
  // -------------------------------------------------------------------------
  // After deposit: all views agree
  // -------------------------------------------------------------------------

  it("after deposit: getPoolStats, getActiveNoteCount, balance, isCommitted, root are consistent", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await depositNote(pool, alice, commitment);

    // getPoolStats
    const [totalDeposited, totalWithdrawn, totalTransfers, depositCount, withdrawalCount, uniqueDepositors, poolBalance] =
      await pool.getPoolStats();
    expect(totalDeposited).to.equal(DEPOSIT_AMOUNT);
    expect(totalWithdrawn).to.equal(0n);
    expect(totalTransfers).to.equal(0n);
    expect(depositCount).to.equal(1n);
    expect(withdrawalCount).to.equal(0n);
    expect(uniqueDepositors).to.equal(1n);
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT);

    // contract balance matches
    const contractBalance = await ethers.provider.getBalance(await pool.getAddress());
    expect(contractBalance).to.equal(DEPOSIT_AMOUNT);
    expect(poolBalance).to.equal(contractBalance);

    // active note count: 1 deposit, 0 withdrawals, 0 transfers
    expect(await pool.getActiveNoteCount()).to.equal(1n);

    // commitment is stored
    expect(await pool.isCommitted(commitment)).to.be.true;

    // root is non-zero and known
    const root = await pool.getLastRoot();
    expect(root).to.be.greaterThan(0n);
    expect(await pool.isKnownRoot(root)).to.be.true;

    // tree utilization > 0
    expect(await pool.getTreeUtilization()).to.equal((1n * 100n) / TREE_CAPACITY);
    expect(await pool.hasCapacity()).to.be.true;
  });

  it("after deposit: getCommitmentIndex, indexToCommitment, and getCommitments(0,1) agree", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await depositNote(pool, alice, commitment);

    const idx = await pool.getCommitmentIndex(commitment);
    expect(idx).to.equal(0n);
    expect(await pool.indexToCommitment(idx)).to.equal(commitment);
    expect(await pool.commitmentIndex(commitment)).to.equal(idx);

    const page = await pool.getCommitments(0, 1);
    expect(page.length).to.equal(1);
    expect(page[0]).to.equal(commitment);
  });

  it("after deposit: getDepositCount equals getPoolStats.depositCount", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await depositNote(pool, alice, randomCommitment());
    await depositNote(pool, alice, randomCommitment());

    const [, , , depositCount] = await pool.getPoolStats();
    expect(await pool.getDepositCount()).to.equal(Number(depositCount));
  });

  // -------------------------------------------------------------------------
  // After transfer: output commitments indexed, nullifier spent, activeNoteCount correct
  // -------------------------------------------------------------------------

  it("after transfer: output commitments are indexed and nullifier is spent", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const inputCommitment = randomCommitment();
    const root = await depositNote(pool, alice, inputCommitment);

    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    await doTransfer(pool, root, nullifier, out1, out2);

    // Nullifier is spent
    expect(await pool.isSpent(nullifier)).to.be.true;

    // Both output commitments are stored
    expect(await pool.isCommitted(out1)).to.be.true;
    expect(await pool.isCommitted(out2)).to.be.true;

    // Correct indices
    const idx1 = await pool.getCommitmentIndex(out1);
    const idx2 = await pool.getCommitmentIndex(out2);
    expect(idx1).to.not.equal(idx2);
    expect(await pool.indexToCommitment(idx1)).to.equal(out1);
    expect(await pool.indexToCommitment(idx2)).to.equal(out2);

    // Stats: 1 deposit + 1 transfer → totalTransfers = 1
    const [, , totalTransfers, depositCount] = await pool.getPoolStats();
    expect(totalTransfers).to.equal(1n);
    // nextIndex = 3 (1 deposit + 2 transfer outputs)
    expect(depositCount).to.equal(3n);
  });

  it("after transfer: activeNoteCount decrements by net 1 (spend 1, add 2)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    const root = await depositNote(pool, alice, commitment);

    // Before transfer: 1 active note
    expect(await pool.getActiveNoteCount()).to.equal(1n);

    const nullifier = randomCommitment();
    await doTransfer(pool, root, nullifier, randomCommitment(), randomCommitment());

    // After transfer: 1 - 1 (spent) + 2 (outputs) = 2 active notes
    // getActiveNoteCount = nextIndex - (withdrawalCount + totalTransfers)
    // = 3 - (0 + 1) = 2
    expect(await pool.getActiveNoteCount()).to.equal(2n);
  });

  it("after transfer: getPoolHealth reflects updated tree utilization", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const root = await depositNote(pool, alice, randomCommitment());
    await doTransfer(pool, root, randomCommitment(), randomCommitment(), randomCommitment());

    // 3 leaves in tree now
    const expectedUtilization = (3n * 100n) / TREE_CAPACITY;
    expect(await pool.getTreeUtilization()).to.equal(expectedUtilization);

    const [activeNotes, treeUtilization] = await pool.getPoolHealth();
    expect(activeNotes).to.equal(await pool.getActiveNoteCount());
    expect(treeUtilization).to.equal(expectedUtilization);
  });

  // -------------------------------------------------------------------------
  // After withdrawal: all views agree
  // -------------------------------------------------------------------------

  it("after withdrawal: stats, balance, isSpent, withdrawalRecords are consistent", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    const root = await depositNote(pool, alice, commitment);

    const nullifier = randomCommitment();
    const txResponse = await doWithdraw(
      pool,
      root,
      nullifier,
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`
    );
    const receipt = await txResponse.wait();

    // Nullifier is spent
    expect(await pool.isSpent(nullifier)).to.be.true;

    // getPoolStats
    const [, totalWithdrawn, , , withdrawalCount, , poolBalance] =
      await pool.getPoolStats();
    expect(totalWithdrawn).to.equal(WITHDRAW_AMOUNT);
    expect(withdrawalCount).to.equal(1n);
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT - WITHDRAW_AMOUNT);

    // withdrawal record
    expect(await pool.getWithdrawalRecordCount()).to.equal(1n);
    const record = await pool.getWithdrawalRecord(0n);
    expect(record.nullifier).to.equal(nullifier);
    expect(record.amount).to.equal(WITHDRAW_AMOUNT);
    expect(record.recipient.toLowerCase()).to.equal(bob.address.toLowerCase());
    expect(record.blockNumber).to.equal(BigInt(receipt!.blockNumber));
  });

  it("after withdrawal with change: changeCommitment is indexed and activeNoteCount reflects it", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    const root = await depositNote(pool, alice, commitment);

    const nullifier = randomCommitment();
    const changeCommitment = randomCommitment();

    await doWithdraw(
      pool,
      root,
      nullifier,
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`,
      changeCommitment
    );

    // changeCommitment is now in the tree
    expect(await pool.isCommitted(changeCommitment)).to.be.true;
    const changeIdx = await pool.getCommitmentIndex(changeCommitment);
    expect(await pool.indexToCommitment(changeIdx)).to.equal(changeCommitment);

    // activeNoteCount = nextIndex - (withdrawalCount + totalTransfers)
    // nextIndex = 2 (original deposit + change note)
    // withdrawalCount = 1, totalTransfers = 0
    // = 2 - 1 = 1
    expect(await pool.getActiveNoteCount()).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // After pause: paused flag consistent across all observers
  // -------------------------------------------------------------------------

  it("after pause: paused(), getPoolHealth.isPaused, PoolLens.isPaused all agree", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);

    await pool.connect(owner).pause();

    expect(await pool.paused()).to.be.true;

    const [, , , isPaused] = await pool.getPoolHealth();
    expect(isPaused).to.be.true;

    const snapshot = await lens.getSnapshot(await pool.getAddress());
    expect(snapshot.isPaused).to.be.true;
  });

  it("after unpause: all paused views revert to false", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);

    await pool.connect(owner).pause();
    await pool.connect(owner).unpause();

    expect(await pool.paused()).to.be.false;

    const [, , , isPaused] = await pool.getPoolHealth();
    expect(isPaused).to.be.false;

    const snapshot = await lens.getSnapshot(await pool.getAddress());
    expect(snapshot.isPaused).to.be.false;
  });

  // -------------------------------------------------------------------------
  // batchDeposit: all commitments indexed, receipts minted
  // -------------------------------------------------------------------------

  it("after batchDeposit: all commitments indexed and getPoolStats consistent", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    // All commitments are stored
    for (const c of commitments) {
      expect(await pool.isCommitted(c)).to.be.true;
    }

    // getDepositCount == 3
    expect(await pool.getDepositCount()).to.equal(3);

    // getCommitments(0,3) returns all three in order
    const page = await pool.getCommitments(0, 3);
    expect(page.length).to.equal(3);
    for (let i = 0; i < 3; i++) {
      expect(page[i]).to.equal(commitments[i]);
    }

    // getPoolStats
    const [totalDeposited, , , depositCount, , , poolBalance] = await pool.getPoolStats();
    expect(totalDeposited).to.equal(total);
    expect(depositCount).to.equal(3n);
    expect(poolBalance).to.equal(total);

    // activeNoteCount == 3
    expect(await pool.getActiveNoteCount()).to.equal(3n);
  });

  it("after batchDeposit with receipt: receipts minted match pool state", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const receipt = await DepositReceiptFactory.deploy(await pool.getAddress());
    await pool.setDepositReceipt(await receipt.getAddress());

    const commitments = [randomCommitment(), randomCommitment()];
    const amounts = [ethers.parseEther("1"), ethers.parseEther("2")];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    expect(await receipt.balanceOf(alice.address)).to.equal(2n);

    for (let i = 0; i < 2; i++) {
      expect(await receipt.tokenCommitment(BigInt(i))).to.equal(commitments[i]);
      expect(await receipt.tokenAmount(BigInt(i))).to.equal(amounts[i]);
      // Pool confirms commitment is stored
      expect(await pool.isCommitted(commitments[i])).to.be.true;
    }
  });

  // -------------------------------------------------------------------------
  // PoolLens snapshot matches individual calls
  // -------------------------------------------------------------------------

  it("PoolLens snapshot matches individual view calls after deposits", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      await depositNote(pool, alice, randomCommitment());
    }

    const poolAddress = await pool.getAddress();
    const snapshot = await lens.getSnapshot(poolAddress);

    const [totalDeposited, totalWithdrawn, totalTransfers, depositCount, withdrawalCount, uniqueDepositors, poolBalance] =
      await pool.getPoolStats();

    expect(snapshot.totalDeposited).to.equal(totalDeposited);
    expect(snapshot.totalWithdrawn).to.equal(totalWithdrawn);
    expect(snapshot.totalTransfers).to.equal(totalTransfers);
    expect(snapshot.depositCount).to.equal(depositCount);
    expect(snapshot.withdrawalCount).to.equal(withdrawalCount);
    expect(snapshot.uniqueDepositors).to.equal(uniqueDepositors);
    expect(snapshot.poolBalance).to.equal(poolBalance);
    expect(snapshot.activeNotes).to.equal(await pool.getActiveNoteCount());
    expect(snapshot.treeCapacity).to.equal(await pool.getTreeCapacity());
    expect(snapshot.treeUtilization).to.equal(await pool.getTreeUtilization());
    expect(snapshot.lastRoot).to.equal(await pool.getLastRoot());
    expect(snapshot.isPaused).to.equal(await pool.paused());
    expect(snapshot.allowlistEnabled).to.equal(await pool.allowlistEnabled());
    expect(snapshot.maxWithdrawAmount).to.equal(await pool.maxWithdrawAmount());
    expect(snapshot.minDepositAge).to.equal(await pool.minDepositAge());
    expect(snapshot.maxDepositsPerAddress).to.equal(await pool.maxDepositsPerAddress());
    expect(snapshot.owner).to.equal(await pool.owner());
  });

  it("PoolLens snapshot stays consistent after deposit → transfer → withdraw cycle", async function () {
    const { pool, lens, alice, bob } = await loadFixture(deployFixture);

    // Deposit
    const root1 = await depositNote(pool, alice, randomCommitment());

    // Transfer
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    await doTransfer(pool, root1, randomCommitment(), out1, out2);

    // Deposit again to get a valid root for withdrawal
    const root2 = await depositNote(pool, alice, randomCommitment());

    // Withdraw
    await doWithdraw(
      pool,
      root2,
      randomCommitment(),
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`
    );

    const poolAddress = await pool.getAddress();
    const snapshot = await lens.getSnapshot(poolAddress);

    const [totalDeposited, totalWithdrawn, totalTransfers, depositCount, withdrawalCount, uniqueDepositors, poolBalance] =
      await pool.getPoolStats();

    expect(snapshot.totalDeposited).to.equal(totalDeposited);
    expect(snapshot.totalWithdrawn).to.equal(totalWithdrawn);
    expect(snapshot.totalTransfers).to.equal(totalTransfers);
    expect(snapshot.depositCount).to.equal(depositCount);
    expect(snapshot.withdrawalCount).to.equal(withdrawalCount);
    expect(snapshot.uniqueDepositors).to.equal(uniqueDepositors);
    expect(snapshot.poolBalance).to.equal(poolBalance);
    expect(snapshot.activeNotes).to.equal(await pool.getActiveNoteCount());
  });

  // -------------------------------------------------------------------------
  // Withdrawal records match event data
  // -------------------------------------------------------------------------

  it("withdrawal record fields match the Withdrawal event emitted", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    const root = await depositNote(pool, alice, commitment);
    const nullifier = randomCommitment();

    const txResponse = await doWithdraw(
      pool,
      root,
      nullifier,
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`
    );
    const txReceipt = await txResponse.wait();

    // Parse event
    const poolInterface = pool.interface;
    let eventNullifier: bigint | undefined;
    let eventAmount: bigint | undefined;
    let eventRecipient: string | undefined;

    for (const log of txReceipt!.logs) {
      try {
        const parsed = poolInterface.parseLog(log);
        if (parsed?.name === "Withdrawal") {
          eventNullifier = parsed.args.nullifier as bigint;
          eventAmount = parsed.args.amount as bigint;
          eventRecipient = parsed.args.recipient as string;
        }
      } catch {
        // non-matching log
      }
    }

    expect(eventNullifier).to.not.be.undefined;
    expect(eventAmount).to.not.be.undefined;
    expect(eventRecipient).to.not.be.undefined;

    const record = await pool.getWithdrawalRecord(0n);
    expect(record.nullifier).to.equal(eventNullifier);
    expect(record.amount).to.equal(eventAmount);
    expect(record.recipient.toLowerCase()).to.equal(eventRecipient!.toLowerCase());
  });

  // -------------------------------------------------------------------------
  // Pool stats after full deposit → transfer → withdraw cycle
  // -------------------------------------------------------------------------

  it("pool stats after full deposit → transfer → withdraw cycle are internally consistent", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // Step 1: Deposit
    const depositCommitment = randomCommitment();
    const rootAfterDeposit = await depositNote(pool, alice, depositCommitment);

    // Step 2: Transfer (spend deposit, create 2 outputs)
    const transferNullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    await doTransfer(pool, rootAfterDeposit, transferNullifier, out1, out2);

    // Step 3: Deposit again to get a valid root for withdrawal
    const secondDeposit = randomCommitment();
    const rootAfterSecondDeposit = await depositNote(pool, alice, secondDeposit);

    // Step 4: Withdraw
    const withdrawNullifier = randomCommitment();
    await doWithdraw(
      pool,
      rootAfterSecondDeposit,
      withdrawNullifier,
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`
    );

    const [totalDeposited, totalWithdrawn, totalTransfers, depositCount, withdrawalCount, uniqueDepositors, poolBalance] =
      await pool.getPoolStats();

    expect(totalDeposited).to.equal(DEPOSIT_AMOUNT * 2n);
    expect(totalWithdrawn).to.equal(WITHDRAW_AMOUNT);
    expect(totalTransfers).to.equal(1n);
    expect(withdrawalCount).to.equal(1n);
    expect(uniqueDepositors).to.equal(1n); // alice deposited both times

    // poolBalance = 2 * DEPOSIT_AMOUNT - WITHDRAW_AMOUNT
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT * 2n - WITHDRAW_AMOUNT);

    // nextIndex = 1 (deposit) + 2 (transfer outputs) + 1 (second deposit) = 4
    expect(depositCount).to.equal(4n);
    expect(await pool.getDepositCount()).to.equal(4);

    // activeNoteCount = nextIndex - (withdrawalCount + totalTransfers)
    // = 4 - (1 + 1) = 2
    expect(await pool.getActiveNoteCount()).to.equal(2n);

    // All committed commitments present
    expect(await pool.isCommitted(depositCommitment)).to.be.true;
    expect(await pool.isCommitted(out1)).to.be.true;
    expect(await pool.isCommitted(out2)).to.be.true;
    expect(await pool.isCommitted(secondDeposit)).to.be.true;

    // Both nullifiers are spent
    expect(await pool.isSpent(transferNullifier)).to.be.true;
    expect(await pool.isSpent(withdrawNullifier)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // getPoolHealth internal consistency
  // -------------------------------------------------------------------------

  it("getPoolHealth values match their individual view counterparts", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await depositNote(pool, alice, randomCommitment());
    await depositNote(pool, alice, randomCommitment());

    const [activeNotes, treeUtilization, poolBalance, isPaused, isAllowlisted, currentMaxWithdraw, currentMinAge] =
      await pool.getPoolHealth();

    expect(activeNotes).to.equal(await pool.getActiveNoteCount());
    expect(treeUtilization).to.equal(await pool.getTreeUtilization());
    expect(poolBalance).to.equal(
      await ethers.provider.getBalance(await pool.getAddress())
    );
    expect(isPaused).to.equal(await pool.paused());
    expect(isAllowlisted).to.equal(await pool.allowlistEnabled());
    expect(currentMaxWithdraw).to.equal(await pool.maxWithdrawAmount());
    expect(currentMinAge).to.equal(await pool.minDepositAge());
  });

  // -------------------------------------------------------------------------
  // Multiple deposits: pagination consistency
  // -------------------------------------------------------------------------

  it("after 5 deposits: getCommitments pagination is consistent with indexToCommitment", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitments: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await depositNote(pool, alice, c);
    }

    // First page of 3
    const page0 = await pool.getCommitments(0, 3);
    expect(page0.length).to.equal(3);
    for (let i = 0; i < 3; i++) {
      expect(page0[i]).to.equal(commitments[i]);
      expect(await pool.indexToCommitment(BigInt(i))).to.equal(commitments[i]);
    }

    // Second page of 2
    const page1 = await pool.getCommitments(3, 2);
    expect(page1.length).to.equal(2);
    expect(page1[0]).to.equal(commitments[3]);
    expect(page1[1]).to.equal(commitments[4]);
  });

  it("after 5 deposits: uniqueDepositorCount reflects distinct depositors", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await depositNote(pool, alice, randomCommitment());
    await depositNote(pool, alice, randomCommitment());
    await depositNote(pool, bob, randomCommitment());

    const [, , , , , uniqueDepositors] = await pool.getPoolStats();
    // alice and bob are distinct
    expect(uniqueDepositors).to.equal(2n);
  });

  it("same depositor multiple times: uniqueDepositorCount stays at 1", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    for (let i = 0; i < 4; i++) {
      await depositNote(pool, alice, randomCommitment());
    }

    const [, , , , , uniqueDepositors] = await pool.getPoolStats();
    expect(uniqueDepositors).to.equal(1n);
  });
});
