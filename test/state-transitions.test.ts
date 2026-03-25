import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types/contracts/ConfidentialPool.sol";
import type { DepositReceipt } from "../typechain-types";

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
// Types
// ---------------------------------------------------------------------------

interface PoolState {
  // MerkleTree
  nextIndex: bigint;
  currentRootIndex: bigint;
  lastRoot: bigint;
  validRootCount: bigint;
  treeUtilization: bigint;
  hasCapacity: boolean;
  // Pool accounting
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  totalTransfers: bigint;
  depositCount: bigint;
  withdrawalCount: bigint;
  uniqueDepositorCount: bigint;
  balance: bigint;
  // Derived
  activeNoteCount: bigint;
  withdrawalRecordCount: bigint;
  // Config (should not change in normal ops)
  paused: boolean;
  allowlistEnabled: boolean;
  maxWithdrawAmount: bigint;
  minDepositAge: bigint;
  maxDepositsPerAddress: bigint;
  depositCooldown: bigint;
  maxOperationsPerBlock: bigint;
  owner: string;
  // Pending action
  pendingActionHash: string;
  pendingActionExecuteAfter: bigint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

async function capturePoolState(pool: ConfidentialPool): Promise<PoolState> {
  const [
    totalDeposited,
    totalWithdrawn,
    totalTransfers,
    depositCount,
    withdrawalCount,
    uniqueDepositorCount,
    balance,
  ] = await pool.getPoolStats();

  const [pendingHash, pendingExecuteAfter] = await pool.pendingAction();

  return {
    nextIndex: BigInt(await pool.getDepositCount()),
    currentRootIndex: BigInt(await pool.currentRootIndex()),
    lastRoot: await pool.getLastRoot(),
    validRootCount: BigInt(await pool.getValidRootCount()),
    treeUtilization: await pool.getTreeUtilization(),
    hasCapacity: await pool.hasCapacity(),
    totalDeposited,
    totalWithdrawn,
    totalTransfers,
    depositCount,
    withdrawalCount,
    uniqueDepositorCount,
    balance,
    activeNoteCount: await pool.getActiveNoteCount(),
    withdrawalRecordCount: await pool.getWithdrawalRecordCount(),
    paused: await pool.paused(),
    allowlistEnabled: await pool.allowlistEnabled(),
    maxWithdrawAmount: await pool.maxWithdrawAmount(),
    minDepositAge: await pool.minDepositAge(),
    maxDepositsPerAddress: await pool.maxDepositsPerAddress(),
    depositCooldown: await pool.depositCooldown(),
    maxOperationsPerBlock: await pool.maxOperationsPerBlock(),
    owner: await pool.owner(),
    pendingActionHash: pendingHash,
    pendingActionExecuteAfter: pendingExecuteAfter,
  };
}

async function depositNote(
  pool: ConfidentialPool,
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  commitment: bigint,
  value: bigint = DEPOSIT_AMOUNT
) {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

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

async function deployWithReceiptFixture() {
  const { pool, lens, owner, alice, bob } = await deployFixture();

  const DepositReceiptFactory =
    await ethers.getContractFactory("DepositReceipt");
  const receiptContract = (await DepositReceiptFactory.deploy(
    await pool.getAddress()
  )) as unknown as DepositReceipt;

  await pool.connect(owner).setDepositReceipt(await receiptContract.getAddress());

  return { pool, lens, receiptContract, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------

describe("State Transitions", function () {
  // -------------------------------------------------------------------------
  // deposit transitions
  // -------------------------------------------------------------------------

  it("deposit: nextIndex +1, totalDeposited +amount, balance +amount, uniqueDepositorCount tracks first deposit", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    const before = await capturePoolState(pool);

    await depositNote(pool, alice, commitment);

    const after = await capturePoolState(pool);

    // Changed fields
    expect(after.nextIndex).to.equal(before.nextIndex + 1n);
    expect(after.currentRootIndex).to.equal(before.currentRootIndex + 1n);
    expect(after.lastRoot).to.not.equal(before.lastRoot);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DEPOSIT_AMOUNT);
    expect(after.balance).to.equal(before.balance + DEPOSIT_AMOUNT);
    expect(after.depositCount).to.equal(before.depositCount + 1n);
    expect(after.validRootCount).to.equal(before.validRootCount + 1n);
    expect(after.treeUtilization).to.be.greaterThan(before.treeUtilization);
    expect(after.activeNoteCount).to.equal(before.activeNoteCount + 1n);
    expect(after.uniqueDepositorCount).to.equal(before.uniqueDepositorCount + 1n);

    // commitment is stored
    expect(await pool.isCommitted(commitment)).to.be.true;

    // Unchanged fields
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.totalTransfers).to.equal(before.totalTransfers);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.withdrawalRecordCount).to.equal(before.withdrawalRecordCount);
    expect(after.paused).to.equal(before.paused);
    expect(after.allowlistEnabled).to.equal(before.allowlistEnabled);
    expect(after.maxWithdrawAmount).to.equal(before.maxWithdrawAmount);
    expect(after.owner).to.equal(before.owner);
  });

  it("deposit: second deposit from same address does not increment uniqueDepositorCount", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await depositNote(pool, alice, randomCommitment());
    const before = await capturePoolState(pool);

    await depositNote(pool, alice, randomCommitment());
    const after = await capturePoolState(pool);

    expect(after.uniqueDepositorCount).to.equal(before.uniqueDepositorCount);
    expect(after.nextIndex).to.equal(before.nextIndex + 1n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DEPOSIT_AMOUNT);
  });

  it("deposit: immutable fields unchanged (owner, paused, allowlistEnabled)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const before = await capturePoolState(pool);
    await depositNote(pool, alice, randomCommitment());
    const after = await capturePoolState(pool);

    expect(after.owner).to.equal(before.owner);
    expect(after.paused).to.equal(before.paused);
    expect(after.allowlistEnabled).to.equal(before.allowlistEnabled);
    expect(after.maxWithdrawAmount).to.equal(before.maxWithdrawAmount);
    expect(after.minDepositAge).to.equal(before.minDepositAge);
  });

  // -------------------------------------------------------------------------
  // transfer transitions
  // -------------------------------------------------------------------------

  it("transfer: nextIndex +2, totalTransfers +1, nullifiers[n]=true, balance unchanged", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const root = await depositNote(pool, alice, randomCommitment());
    const before = await capturePoolState(pool);

    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    await doTransfer(pool, root, nullifier, out1, out2);

    const after = await capturePoolState(pool);

    // Changed fields
    expect(after.nextIndex).to.equal(before.nextIndex + 2n);
    expect(after.totalTransfers).to.equal(before.totalTransfers + 1n);
    expect(after.depositCount).to.equal(before.depositCount + 2n); // nextIndex == depositCount
    expect(after.activeNoteCount).to.equal(before.activeNoteCount + 1n); // +2 outputs - 1 nullifier = +1
    expect(after.currentRootIndex).to.not.equal(before.currentRootIndex); // two insertions
    expect(after.lastRoot).to.not.equal(before.lastRoot);

    // Both output commitments stored
    expect(await pool.isCommitted(out1)).to.be.true;
    expect(await pool.isCommitted(out2)).to.be.true;
    // Nullifier spent
    expect(await pool.isSpent(nullifier)).to.be.true;

    // balance unchanged (no ETH moves)
    expect(after.balance).to.equal(before.balance);

    // Unchanged fields
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.withdrawalRecordCount).to.equal(before.withdrawalRecordCount);
    expect(after.uniqueDepositorCount).to.equal(before.uniqueDepositorCount);
    expect(after.paused).to.equal(before.paused);
    expect(after.owner).to.equal(before.owner);
  });

  it("transfer: does not change totalDeposited, totalWithdrawn, withdrawalCount", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const root = await depositNote(pool, alice, randomCommitment());
    const before = await capturePoolState(pool);

    await doTransfer(pool, root, randomCommitment(), randomCommitment(), randomCommitment());
    const after = await capturePoolState(pool);

    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
  });

  // -------------------------------------------------------------------------
  // withdraw transitions
  // -------------------------------------------------------------------------

  it("withdraw: withdrawalCount +1, totalWithdrawn +amount, balance -amount, nullifiers[n]=true, record appended", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const root = await depositNote(pool, alice, randomCommitment());
    const nullifier = randomCommitment();

    const before = await capturePoolState(pool);

    await doWithdraw(
      pool,
      root,
      nullifier,
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`
    );

    const after = await capturePoolState(pool);

    // Changed fields
    expect(after.withdrawalCount).to.equal(before.withdrawalCount + 1n);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn + WITHDRAW_AMOUNT);
    expect(after.balance).to.equal(before.balance - WITHDRAW_AMOUNT);
    expect(after.withdrawalRecordCount).to.equal(before.withdrawalRecordCount + 1n);
    expect(after.activeNoteCount).to.equal(before.activeNoteCount - 1n);
    expect(await pool.isSpent(nullifier)).to.be.true;

    // withdrawal record fields
    const record = await pool.getWithdrawalRecord(before.withdrawalRecordCount);
    expect(record.nullifier).to.equal(nullifier);
    expect(record.amount).to.equal(WITHDRAW_AMOUNT);
    expect(record.recipient.toLowerCase()).to.equal(bob.address.toLowerCase());

    // Unchanged fields
    expect(after.nextIndex).to.equal(before.nextIndex); // no change commitment
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalTransfers).to.equal(before.totalTransfers);
    expect(after.uniqueDepositorCount).to.equal(before.uniqueDepositorCount);
    expect(after.paused).to.equal(before.paused);
    expect(after.owner).to.equal(before.owner);
  });

  it("withdraw: nextIndex unchanged, totalDeposited unchanged, totalTransfers unchanged", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const root = await depositNote(pool, alice, randomCommitment());
    const before = await capturePoolState(pool);

    await doWithdraw(
      pool,
      root,
      randomCommitment(),
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`
    );

    const after = await capturePoolState(pool);

    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalTransfers).to.equal(before.totalTransfers);
    expect(after.lastRoot).to.equal(before.lastRoot); // no new insertion
    expect(after.currentRootIndex).to.equal(before.currentRootIndex);
  });

  it("withdrawal with change: nextIndex +1 (change commitment inserted), activeNoteCount unchanged", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const root = await depositNote(pool, alice, randomCommitment());
    const changeCommitment = randomCommitment();

    const before = await capturePoolState(pool);

    await doWithdraw(
      pool,
      root,
      randomCommitment(),
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`,
      changeCommitment
    );

    const after = await capturePoolState(pool);

    // change note inserted
    expect(after.nextIndex).to.equal(before.nextIndex + 1n);
    expect(after.lastRoot).to.not.equal(before.lastRoot);
    expect(await pool.isCommitted(changeCommitment)).to.be.true;

    // activeNoteCount: -1 (nullifier spent) +1 (change note) = unchanged
    expect(after.activeNoteCount).to.equal(before.activeNoteCount);

    // balance still decreases by full withdraw amount
    expect(after.balance).to.equal(before.balance - WITHDRAW_AMOUNT);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount + 1n);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn + WITHDRAW_AMOUNT);
  });

  // -------------------------------------------------------------------------
  // pause transitions
  // -------------------------------------------------------------------------

  it("pause: paused=true, nothing else changes", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    const before = await capturePoolState(pool);
    await pool.connect(owner).pause();
    const after = await capturePoolState(pool);

    // Changed
    expect(before.paused).to.be.false;
    expect(after.paused).to.be.true;

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.totalTransfers).to.equal(before.totalTransfers);
    expect(after.balance).to.equal(before.balance);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.activeNoteCount).to.equal(before.activeNoteCount);
    expect(after.allowlistEnabled).to.equal(before.allowlistEnabled);
    expect(after.maxWithdrawAmount).to.equal(before.maxWithdrawAmount);
    expect(after.owner).to.equal(before.owner);
  });

  it("unpause: paused=false, nothing else changes", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    await pool.connect(owner).pause();
    const before = await capturePoolState(pool);
    await pool.connect(owner).unpause();
    const after = await capturePoolState(pool);

    // Changed
    expect(before.paused).to.be.true;
    expect(after.paused).to.be.false;

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.balance).to.equal(before.balance);
    expect(after.owner).to.equal(before.owner);
  });

  // -------------------------------------------------------------------------
  // timelock transitions
  // -------------------------------------------------------------------------

  it("queueAction: pendingAction set, nothing else changes", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    const before = await capturePoolState(pool);
    expect(before.pendingActionHash).to.equal(ethers.ZeroHash);

    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 5]
      )
    );
    await pool.connect(owner).queueAction(actionHash);

    const after = await capturePoolState(pool);

    // Changed
    expect(after.pendingActionHash).to.equal(actionHash);
    expect(after.pendingActionExecuteAfter).to.be.greaterThan(0n);

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.balance).to.equal(before.balance);
    expect(after.paused).to.equal(before.paused);
    expect(after.maxDepositsPerAddress).to.equal(before.maxDepositsPerAddress);
  });

  it("cancelAction: pendingAction cleared, nothing else changes", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 5]
      )
    );
    await pool.connect(owner).queueAction(actionHash);

    const before = await capturePoolState(pool);
    await pool.connect(owner).cancelAction();
    const after = await capturePoolState(pool);

    // Changed
    expect(after.pendingActionHash).to.equal(ethers.ZeroHash);
    expect(after.pendingActionExecuteAfter).to.equal(0n);

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.balance).to.equal(before.balance);
    expect(after.paused).to.equal(before.paused);
    expect(after.maxDepositsPerAddress).to.equal(before.maxDepositsPerAddress);
  });

  it("executeAction (setMaxDepositsPerAddress): target parameter changes, pendingAction cleared", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    const newMax = 3n;
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", newMax]
      )
    );
    await pool.connect(owner).queueAction(actionHash);
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    const before = await capturePoolState(pool);
    await pool.connect(owner).setMaxDepositsPerAddress(newMax);
    const after = await capturePoolState(pool);

    // Changed
    expect(after.maxDepositsPerAddress).to.equal(newMax);
    expect(after.pendingActionHash).to.equal(ethers.ZeroHash);
    expect(after.pendingActionExecuteAfter).to.equal(0n);

    // Unchanged
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.balance).to.equal(before.balance);
    expect(after.paused).to.equal(before.paused);
    expect(after.owner).to.equal(before.owner);
  });

  // -------------------------------------------------------------------------
  // batchDeposit transitions
  // -------------------------------------------------------------------------

  it("batchDeposit(3): nextIndex +3, totalDeposited +sum, balance +sum, activeNoteCount +3", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const total = amounts.reduce((a, b) => a + b, 0n);

    const before = await capturePoolState(pool);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    const after = await capturePoolState(pool);

    // Changed fields
    expect(after.nextIndex).to.equal(before.nextIndex + 3n);
    expect(after.depositCount).to.equal(before.depositCount + 3n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + total);
    expect(after.balance).to.equal(before.balance + total);
    expect(after.activeNoteCount).to.equal(before.activeNoteCount + 3n);
    expect(after.treeUtilization).to.be.greaterThan(before.treeUtilization);

    // All commitments stored
    for (const c of commitments) {
      expect(await pool.isCommitted(c)).to.be.true;
    }

    // Unchanged fields
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.totalTransfers).to.equal(before.totalTransfers);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.paused).to.equal(before.paused);
    expect(after.owner).to.equal(before.owner);
  });

  it("batchDeposit: uniqueDepositorCount increments only once for new address", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const before = await capturePoolState(pool);

    const commitments = [randomCommitment(), randomCommitment()];
    const amounts = [DEPOSIT_AMOUNT, DEPOSIT_AMOUNT];
    await pool.connect(alice).batchDeposit(commitments, amounts, { value: DEPOSIT_AMOUNT * 2n });

    const after = await capturePoolState(pool);

    expect(after.uniqueDepositorCount).to.equal(before.uniqueDepositorCount + 1n);
  });

  // -------------------------------------------------------------------------
  // emergencyDrain transition
  // -------------------------------------------------------------------------

  it("emergencyDrain: balance=0, nothing else changes", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    await depositNote(pool, alice, randomCommitment());

    await pool.connect(owner).pause();

    const before = await capturePoolState(pool);
    expect(before.balance).to.be.greaterThan(0n);

    const ownerAddr = await owner.getAddress();
    await pool.connect(owner).emergencyDrain(ownerAddr as `0x${string}`);

    const after = await capturePoolState(pool);

    // Changed
    expect(after.balance).to.equal(0n);

    // Unchanged — pool data records are not modified by drain
    expect(after.nextIndex).to.equal(before.nextIndex);
    expect(after.totalDeposited).to.equal(before.totalDeposited);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.totalTransfers).to.equal(before.totalTransfers);
    expect(after.depositCount).to.equal(before.depositCount);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.withdrawalRecordCount).to.equal(before.withdrawalRecordCount);
    expect(after.activeNoteCount).to.equal(before.activeNoteCount);
    expect(after.uniqueDepositorCount).to.equal(before.uniqueDepositorCount);
    expect(after.paused).to.equal(before.paused); // still paused
    expect(after.owner).to.equal(before.owner);
    expect(after.lastRoot).to.equal(before.lastRoot);
    expect(after.currentRootIndex).to.equal(before.currentRootIndex);
  });

  // -------------------------------------------------------------------------
  // deposit with receipt
  // -------------------------------------------------------------------------

  it("deposit with receipt: all pool state changes + receipt.balanceOf +1", async function () {
    const { pool, receiptContract, alice } =
      await loadFixture(deployWithReceiptFixture);

    const commitment = randomCommitment();
    const aliceAddr = await alice.getAddress();

    const before = await capturePoolState(pool);
    const receiptBalanceBefore = await receiptContract.balanceOf(aliceAddr);

    await depositNote(pool, alice, commitment);

    const after = await capturePoolState(pool);
    const receiptBalanceAfter = await receiptContract.balanceOf(aliceAddr);

    // Pool state changes
    expect(after.nextIndex).to.equal(before.nextIndex + 1n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DEPOSIT_AMOUNT);
    expect(after.balance).to.equal(before.balance + DEPOSIT_AMOUNT);
    expect(after.activeNoteCount).to.equal(before.activeNoteCount + 1n);

    // Receipt minted
    expect(receiptBalanceAfter).to.equal(receiptBalanceBefore + 1n);
    const tokenId = receiptBalanceBefore;
    expect(await receiptContract.tokenCommitment(tokenId)).to.equal(commitment);

    // Unchanged
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.paused).to.equal(before.paused);
  });

  // -------------------------------------------------------------------------
  // multi-operation transitions
  // -------------------------------------------------------------------------

  it("5 deposits: all cumulative state correct", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const before = await capturePoolState(pool);

    for (let i = 0; i < 5; i++) {
      await depositNote(pool, alice, randomCommitment());
    }

    const after = await capturePoolState(pool);

    expect(after.nextIndex).to.equal(before.nextIndex + 5n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DEPOSIT_AMOUNT * 5n);
    expect(after.balance).to.equal(before.balance + DEPOSIT_AMOUNT * 5n);
    expect(after.depositCount).to.equal(before.depositCount + 5n);
    expect(after.activeNoteCount).to.equal(before.activeNoteCount + 5n);
    expect(after.treeUtilization).to.equal((5n * 100n) / TREE_CAPACITY);
    expect(after.uniqueDepositorCount).to.equal(before.uniqueDepositorCount + 1n);

    // Unchanged
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn);
    expect(after.totalTransfers).to.equal(before.totalTransfers);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount);
    expect(after.paused).to.equal(before.paused);
  });

  it("3 deposits + 2 withdrawals: final state matches", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const before = await capturePoolState(pool);

    for (let i = 0; i < 3; i++) {
      const root = await depositNote(pool, alice, randomCommitment());
      if (i < 2) {
        await doWithdraw(
          pool,
          root,
          randomCommitment(),
          WITHDRAW_AMOUNT,
          bob.address as `0x${string}`
        );
      }
    }

    const after = await capturePoolState(pool);

    expect(after.nextIndex).to.equal(before.nextIndex + 3n);
    expect(after.depositCount).to.equal(before.depositCount + 3n);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount + 2n);
    expect(after.withdrawalRecordCount).to.equal(before.withdrawalRecordCount + 2n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DEPOSIT_AMOUNT * 3n);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn + WITHDRAW_AMOUNT * 2n);
    expect(after.balance).to.equal(
      before.balance + DEPOSIT_AMOUNT * 3n - WITHDRAW_AMOUNT * 2n
    );
    // activeNoteCount = 3 (deposits) - 2 (withdrawals, no change commitments) = 1
    expect(after.activeNoteCount).to.equal(before.activeNoteCount + 1n);
  });

  it("full cycle: deposit → withdraw → deposit: all counters correct", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const before = await capturePoolState(pool);

    // First deposit
    const c1 = randomCommitment();
    const root1 = await depositNote(pool, alice, c1);

    const afterFirstDeposit = await capturePoolState(pool);
    expect(afterFirstDeposit.nextIndex).to.equal(before.nextIndex + 1n);
    expect(afterFirstDeposit.totalDeposited).to.equal(before.totalDeposited + DEPOSIT_AMOUNT);

    // Withdraw
    const nullifier = randomCommitment();
    await doWithdraw(
      pool,
      root1,
      nullifier,
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`
    );

    const afterWithdraw = await capturePoolState(pool);
    expect(afterWithdraw.nextIndex).to.equal(afterFirstDeposit.nextIndex); // no change commitment
    expect(afterWithdraw.withdrawalCount).to.equal(before.withdrawalCount + 1n);
    expect(afterWithdraw.totalWithdrawn).to.equal(before.totalWithdrawn + WITHDRAW_AMOUNT);
    expect(afterWithdraw.balance).to.equal(DEPOSIT_AMOUNT - WITHDRAW_AMOUNT);
    expect(afterWithdraw.activeNoteCount).to.equal(0n);

    // Second deposit
    const c2 = randomCommitment();
    await depositNote(pool, alice, c2);

    const afterSecondDeposit = await capturePoolState(pool);
    expect(afterSecondDeposit.nextIndex).to.equal(before.nextIndex + 2n);
    expect(afterSecondDeposit.totalDeposited).to.equal(before.totalDeposited + DEPOSIT_AMOUNT * 2n);
    expect(afterSecondDeposit.totalWithdrawn).to.equal(before.totalWithdrawn + WITHDRAW_AMOUNT);
    expect(afterSecondDeposit.balance).to.equal(DEPOSIT_AMOUNT * 2n - WITHDRAW_AMOUNT);
    expect(afterSecondDeposit.withdrawalCount).to.equal(before.withdrawalCount + 1n);
    expect(afterSecondDeposit.activeNoteCount).to.equal(1n);

    // Both commitments remain in tree
    expect(await pool.isCommitted(c1)).to.be.true;
    expect(await pool.isCommitted(c2)).to.be.true;
    expect(await pool.isSpent(nullifier)).to.be.true;
  });

  it("deposit → transfer → withdraw: all counters correct", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const before = await capturePoolState(pool);

    // Deposit
    const c1 = randomCommitment();
    const root1 = await depositNote(pool, alice, c1);

    // Transfer: spends c1, creates out1 + out2
    const transferNullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    await doTransfer(pool, root1, transferNullifier, out1, out2);

    // Second deposit so we have a valid root for withdrawal
    const c2 = randomCommitment();
    const root2 = await depositNote(pool, alice, c2);

    // Withdraw using c2's root
    const withdrawNullifier = randomCommitment();
    await doWithdraw(
      pool,
      root2,
      withdrawNullifier,
      WITHDRAW_AMOUNT,
      bob.address as `0x${string}`
    );

    const after = await capturePoolState(pool);

    // nextIndex: 1 (c1) + 2 (out1, out2) + 1 (c2) = 4
    expect(after.nextIndex).to.equal(before.nextIndex + 4n);
    expect(after.totalTransfers).to.equal(before.totalTransfers + 1n);
    expect(after.withdrawalCount).to.equal(before.withdrawalCount + 1n);
    expect(after.totalDeposited).to.equal(before.totalDeposited + DEPOSIT_AMOUNT * 2n);
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn + WITHDRAW_AMOUNT);
    // activeNoteCount = 4 - (1 transfer + 1 withdrawal) = 2
    expect(after.activeNoteCount).to.equal(before.activeNoteCount + 2n);

    expect(await pool.isSpent(transferNullifier)).to.be.true;
    expect(await pool.isSpent(withdrawNullifier)).to.be.true;
    expect(await pool.isCommitted(out1)).to.be.true;
    expect(await pool.isCommitted(out2)).to.be.true;
  });
});
