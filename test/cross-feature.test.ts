import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, DepositReceipt, PoolLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_AMOUNT = ethers.parseEther("1");
const WITHDRAW_AMOUNT = ethers.parseEther("0.5");
const MERKLE_TREE_HEIGHT = 5;

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
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
}

type Pool = Awaited<ReturnType<typeof deployBaseFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doWithdraw(
  pool: Pool,
  nullifier: bigint,
  amount: bigint,
  recipient: Signer,
  changeCommitment = 0n
) {
  const root = await pool.getLastRoot();
  return pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient.address as `0x${string}`,
    changeCommitment,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

async function doTransfer(
  pool: Pool,
  nullifier: bigint,
  out1: bigint,
  out2: bigint
) {
  const root = await pool.getLastRoot();
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

async function deployBaseFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

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

  const LensFactory = await ethers.getContractFactory("PoolLens");
  const lens = (await LensFactory.deploy()) as unknown as PoolLens;

  return { pool, lens, owner, alice, bob, relayer };
}

async function deployWithReceiptFixture() {
  const base = await deployBaseFixture();
  const { pool, owner } = base;

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await pool.getAddress()
  )) as unknown as DepositReceipt;

  // In ConfidentialPool, setDepositReceipt does NOT require a timelock
  await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Cross-Feature Verification
// ---------------------------------------------------------------------------

describe("Cross-Feature Verification", function () {
  // -------------------------------------------------------------------------
  // Withdrawal record <-> Withdrawal event
  // -------------------------------------------------------------------------

  it("withdrawal record fields match Withdrawal event args", async function () {
    const { pool, alice, bob } = await loadFixture(deployBaseFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const nullifier = randomCommitment();
    const tx = await doWithdraw(pool, nullifier, WITHDRAW_AMOUNT, bob);
    const rxReceipt = await tx.wait();

    const poolAddress = await pool.getAddress();
    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const withdrawalLog = rxReceipt!.logs.find(
      (log) =>
        log.address.toLowerCase() === poolAddress.toLowerCase() &&
        log.topics[0] === withdrawalTopic
    );
    expect(withdrawalLog).to.not.be.undefined;

    const parsed = pool.interface.parseLog(withdrawalLog!);
    const eventNullifier: bigint = parsed!.args[0];
    const eventAmount: bigint = parsed!.args[1];
    const eventRecipient: string = parsed!.args[2];

    // Cross-check against withdrawal record stored on-chain
    const record = await pool.getWithdrawalRecord(0n);
    expect(record.nullifier).to.equal(eventNullifier);
    expect(record.amount).to.equal(eventAmount);
    expect(record.recipient.toLowerCase()).to.equal(eventRecipient.toLowerCase());

    // Nullifier is also marked spent in state
    expect(await pool.isSpent(eventNullifier)).to.be.true;
  });

  it("withdrawal record count matches getWithdrawalRecordCount and getPoolStats.withdrawalCount", async function () {
    const { pool, alice, bob } = await loadFixture(deployBaseFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    await doWithdraw(pool, randomCommitment(), WITHDRAW_AMOUNT, bob);
    await doWithdraw(pool, randomCommitment(), WITHDRAW_AMOUNT, bob);

    const recordCount = await pool.getWithdrawalRecordCount();
    const [, , , , withdrawalCount] = await pool.getPoolStats();

    expect(recordCount).to.equal(2n);
    expect(withdrawalCount).to.equal(recordCount);
  });

  // -------------------------------------------------------------------------
  // Receipt tokenAmount <-> Deposit event amount
  // -------------------------------------------------------------------------

  it("receipt tokenAmount matches Deposit event amount", async function () {
    const { pool, alice, receipt } = await loadFixture(deployWithReceiptFixture);

    const commitment = randomCommitment();
    const amount = ethers.parseEther("2");

    const tx = await pool.connect(alice).deposit(commitment, { value: amount });
    const rxReceipt = await tx.wait();

    const poolAddress = await pool.getAddress();
    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const depositLog = rxReceipt!.logs.find(
      (log) =>
        log.address.toLowerCase() === poolAddress.toLowerCase() &&
        log.topics[0] === depositTopic
    );
    expect(depositLog).to.not.be.undefined;

    const parsed = pool.interface.parseLog(depositLog!);
    const eventAmount: bigint = parsed!.args[2]; // amount is args[2] in Deposit event

    // Receipt stores the same amount
    const tokenAmount = await receipt.tokenAmount(0n);
    expect(tokenAmount).to.equal(eventAmount);
    expect(tokenAmount).to.equal(amount);
  });

  it("receipt tokenCommitment matches Deposit event commitment", async function () {
    const { pool, alice, receipt } = await loadFixture(deployWithReceiptFixture);

    const commitment = randomCommitment();
    const tx = await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });
    const rxReceipt = await tx.wait();

    const poolAddress = await pool.getAddress();
    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const depositLog = rxReceipt!.logs.find(
      (log) =>
        log.address.toLowerCase() === poolAddress.toLowerCase() &&
        log.topics[0] === depositTopic
    );

    const parsed = pool.interface.parseLog(depositLog!);
    const eventCommitment: bigint = parsed!.args[0];

    // Cross-check receipt and contract state
    expect(await receipt.tokenCommitment(0n)).to.equal(eventCommitment);
    expect(await pool.isCommitted(eventCommitment)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // PoolLens activeNotes <-> getActiveNoteCount
  // -------------------------------------------------------------------------

  it("PoolLens activeNotes matches getActiveNoteCount", async function () {
    const { pool, lens, alice, bob } = await loadFixture(deployBaseFixture);
    const poolAddress = await pool.getAddress();

    // Initial state
    const snap0 = await lens.getSnapshot(poolAddress);
    expect(snap0.activeNotes).to.equal(await pool.getActiveNoteCount());
    expect(snap0.activeNotes).to.equal(0n);

    // After deposit
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    const snap1 = await lens.getSnapshot(poolAddress);
    expect(snap1.activeNotes).to.equal(await pool.getActiveNoteCount());
    expect(snap1.activeNotes).to.equal(2n);

    // After withdrawal (spends 1 note, optionally inserts change — we pass 0 change)
    await doWithdraw(pool, randomCommitment(), WITHDRAW_AMOUNT, bob);
    const snap2 = await lens.getSnapshot(poolAddress);
    expect(snap2.activeNotes).to.equal(await pool.getActiveNoteCount());
    // 2 deposits - 1 withdrawal - 0 transfers = 1
    expect(snap2.activeNotes).to.equal(1n);

    // After transfer (spends 1 note, inserts 2 output notes: net +1)
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    await doTransfer(pool, randomCommitment(), out1, out2);
    const snap3 = await lens.getSnapshot(poolAddress);
    expect(snap3.activeNotes).to.equal(await pool.getActiveNoteCount());
  });

  // -------------------------------------------------------------------------
  // Transfer event outputs <-> indexed commitments
  // -------------------------------------------------------------------------

  it("Transfer event outputs match indexed commitments in tree", async function () {
    const { pool, alice } = await loadFixture(deployBaseFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const out1 = randomCommitment();
    const out2 = randomCommitment();
    const nullifier = randomCommitment();

    const tx = await doTransfer(pool, nullifier, out1, out2);
    const rxReceipt = await tx.wait();

    const poolAddress = await pool.getAddress();
    const transferTopic = pool.interface.getEvent("Transfer").topicHash;
    const transferLog = rxReceipt!.logs.find(
      (log) =>
        log.address.toLowerCase() === poolAddress.toLowerCase() &&
        log.topics[0] === transferTopic
    );
    expect(transferLog).to.not.be.undefined;

    const parsed = pool.interface.parseLog(transferLog!);
    const eventOut1: bigint = parsed!.args[1];
    const eventOut2: bigint = parsed!.args[2];

    expect(eventOut1).to.equal(out1);
    expect(eventOut2).to.equal(out2);

    // Both output commitments are now committed in the tree
    expect(await pool.isCommitted(eventOut1)).to.be.true;
    expect(await pool.isCommitted(eventOut2)).to.be.true;

    // Their indices are sequential (deposit used index 0, transfer uses 1 and 2)
    const idx1 = await pool.getCommitmentIndex(eventOut1);
    const idx2 = await pool.getCommitmentIndex(eventOut2);
    expect(idx2).to.equal(idx1 + 1n);

    // Reverse lookup agrees
    expect(await pool.indexToCommitment(idx1)).to.equal(eventOut1);
    expect(await pool.indexToCommitment(idx2)).to.equal(eventOut2);
  });

  // -------------------------------------------------------------------------
  // batchDeposit receipts <-> batch Deposit events
  // -------------------------------------------------------------------------

  it("batchDeposit receipts match batch Deposit events", async function () {
    const { pool, alice, receipt } = await loadFixture(deployWithReceiptFixture);

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("0.5"),
    ];
    const totalAmount = amounts.reduce((a, b) => a + b, 0n);

    const tx = await pool
      .connect(alice)
      .batchDeposit(commitments, amounts, { value: totalAmount });
    const rxReceipt = await tx.wait();

    const poolAddress = await pool.getAddress();
    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const depositLogs = rxReceipt!.logs.filter(
      (log) =>
        log.address.toLowerCase() === poolAddress.toLowerCase() &&
        log.topics[0] === depositTopic
    );

    expect(depositLogs).to.have.length(3);

    for (let i = 0; i < commitments.length; i++) {
      const parsed = pool.interface.parseLog(depositLogs[i]);
      const eventCommitment: bigint = parsed!.args[0];
      const eventAmount: bigint = parsed!.args[2];

      // Event commitment matches what we submitted
      expect(eventCommitment).to.equal(commitments[i]);
      expect(eventAmount).to.equal(amounts[i]);

      // Receipt stores the same commitment and amount
      const tokenId = BigInt(i);
      expect(await receipt.tokenCommitment(tokenId)).to.equal(eventCommitment);
      expect(await receipt.tokenAmount(tokenId)).to.equal(eventAmount);

      // Contract state agrees
      expect(await pool.isCommitted(eventCommitment)).to.be.true;
    }
  });

  // -------------------------------------------------------------------------
  // Deposit event leafIndex <-> getCommitmentIndex
  // -------------------------------------------------------------------------

  it("Deposit event leafIndex matches getCommitmentIndex in contract state", async function () {
    const { pool, alice } = await loadFixture(deployBaseFixture);

    const poolAddress = await pool.getAddress();
    const depositTopic = pool.interface.getEvent("Deposit").topicHash;

    const commitments: bigint[] = [];
    const eventLeafIndices: bigint[] = [];

    for (let i = 0; i < 4; i++) {
      const c = randomCommitment();
      commitments.push(c);

      const tx = await pool.connect(alice).deposit(c, { value: DEPOSIT_AMOUNT });
      const rxReceipt = await tx.wait();

      const depositLog = rxReceipt!.logs.find(
        (log) =>
          log.address.toLowerCase() === poolAddress.toLowerCase() &&
          log.topics[0] === depositTopic
      );
      const parsed = pool.interface.parseLog(depositLog!);
      eventLeafIndices.push(BigInt(parsed!.args[1])); // leafIndex is args[1]
    }

    for (let i = 0; i < commitments.length; i++) {
      const storedIndex = await pool.getCommitmentIndex(commitments[i]);
      expect(BigInt(storedIndex)).to.equal(eventLeafIndices[i]);
      expect(eventLeafIndices[i]).to.equal(BigInt(i));
    }
  });

  // -------------------------------------------------------------------------
  // PoolLens <-> individual getters
  // -------------------------------------------------------------------------

  it("PoolLens every field matches individual getter", async function () {
    const { pool, lens, alice, bob } = await loadFixture(deployBaseFixture);
    const poolAddress = await pool.getAddress();

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await doWithdraw(pool, randomCommitment(), WITHDRAW_AMOUNT, bob);

    const snap = await lens.getSnapshot(poolAddress);
    const [td, tw, tt, dc, wc, ud, pb] = await pool.getPoolStats();

    expect(snap.totalDeposited).to.equal(td);
    expect(snap.totalWithdrawn).to.equal(tw);
    expect(snap.totalTransfers).to.equal(tt);
    expect(snap.depositCount).to.equal(dc);
    expect(snap.withdrawalCount).to.equal(wc);
    expect(snap.uniqueDepositors).to.equal(ud);
    expect(snap.poolBalance).to.equal(pb);
    expect(snap.poolBalance).to.equal(
      await ethers.provider.getBalance(poolAddress)
    );
    expect(snap.activeNotes).to.equal(await pool.getActiveNoteCount());
    expect(snap.treeCapacity).to.equal(await pool.getTreeCapacity());
    expect(snap.treeUtilization).to.equal(await pool.getTreeUtilization());
    expect(snap.lastRoot).to.equal(await pool.getLastRoot());
    expect(snap.isPaused).to.equal(await pool.paused());
    expect(snap.allowlistEnabled).to.equal(await pool.allowlistEnabled());
    expect(snap.maxWithdrawAmount).to.equal(await pool.maxWithdrawAmount());
    expect(snap.minDepositAge).to.equal(await pool.minDepositAge());
    expect(snap.maxDepositsPerAddress).to.equal(await pool.maxDepositsPerAddress());
    expect(snap.owner).to.equal(await pool.owner());
  });

  it("PoolLens is consistent before and after state change", async function () {
    const { pool, lens, alice, bob } = await loadFixture(deployBaseFixture);
    const poolAddress = await pool.getAddress();

    // Snapshot before
    const snap0 = await lens.getSnapshot(poolAddress);
    expect(snap0.depositCount).to.equal(0n);
    expect(snap0.poolBalance).to.equal(0n);
    expect(snap0.activeNotes).to.equal(0n);

    // Deposit
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    const snap1 = await lens.getSnapshot(poolAddress);
    expect(snap1.depositCount).to.equal(1n);
    expect(snap1.poolBalance).to.equal(DEPOSIT_AMOUNT);
    expect(snap1.activeNotes).to.equal(1n);
    expect(snap1.totalDeposited - snap1.totalWithdrawn).to.equal(snap1.poolBalance);

    // Withdraw
    await doWithdraw(pool, randomCommitment(), WITHDRAW_AMOUNT, bob);
    const snap2 = await lens.getSnapshot(poolAddress);
    expect(snap2.withdrawalCount).to.equal(1n);
    expect(snap2.activeNotes).to.equal(0n);
    expect(snap2.totalDeposited - snap2.totalWithdrawn).to.equal(snap2.poolBalance);
    expect(snap2.poolBalance).to.equal(
      await ethers.provider.getBalance(poolAddress)
    );
  });

  // -------------------------------------------------------------------------
  // getPoolStats.poolBalance <-> provider.getBalance
  // -------------------------------------------------------------------------

  it("getPoolStats.poolBalance always matches provider.getBalance", async function () {
    const { pool, alice, bob } = await loadFixture(deployBaseFixture);
    const poolAddress = await pool.getAddress();

    const check = async () => {
      const [, , , , , , pb] = await pool.getPoolStats();
      const onChain = await ethers.provider.getBalance(poolAddress);
      expect(pb).to.equal(onChain);
    };

    await check();

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await check();

    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await check();

    await doWithdraw(pool, randomCommitment(), WITHDRAW_AMOUNT, bob);
    await check();
  });

  // -------------------------------------------------------------------------
  // totalDeposited - totalWithdrawn == poolBalance invariant
  // -------------------------------------------------------------------------

  it("totalDeposited - totalWithdrawn == poolBalance after mixed operations", async function () {
    const { pool, alice, bob } = await loadFixture(deployBaseFixture);

    // 3 deposits
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("2") });
    await pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("0.5") });

    // 2 withdrawals
    await doWithdraw(pool, randomCommitment(), WITHDRAW_AMOUNT, bob);
    await doWithdraw(pool, randomCommitment(), ethers.parseEther("0.3"), alice);

    // 1 transfer (moves value between notes but no ETH leaves)
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    await doTransfer(pool, randomCommitment(), out1, out2);

    const [totalDeposited, totalWithdrawn, , , , , poolBalance] =
      await pool.getPoolStats();

    expect(totalDeposited - totalWithdrawn).to.equal(poolBalance);
    expect(poolBalance).to.equal(
      await ethers.provider.getBalance(await pool.getAddress())
    );
  });
});
