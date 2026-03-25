import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_VALUE = ethers.parseEther("1");

// Height-5 tree: capacity = 32 (supports 15+ deposits required by scale tests)
const TREE_HEIGHT = 5;
const TREE_CAPACITY = 2 ** TREE_HEIGHT; // 32

const ROOT_HISTORY_SIZE = 30;

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

type Pool = Awaited<ReturnType<typeof deployScaleFixture>>["pool"];
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

async function doWithdraw(
  pool: Pool,
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment: bigint,
  relayer: string,
  fee: bigint,
  caller?: Signer
) {
  const connected = caller ? pool.connect(caller) : pool;
  return connected.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient as `0x${string}`,
    changeCommitment,
    relayer as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployScaleFixture() {
  const signers = await ethers.getSigners();
  const [owner] = signers;

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    TREE_HEIGHT,
    hasherAddress
  );

  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = await Lens.deploy();

  return { pool, lens, owner, signers };
}

// ---------------------------------------------------------------------------
// Scale Tests
// ---------------------------------------------------------------------------

describe("Scale Tests", function () {
  const DEPOSIT_COUNT = 15;
  const WITHDRAW_COUNT = 5;

  it("15 deposits: all stats correct", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
    }

    const [totalDeposited, , , depositCount, , , poolBalance] =
      await pool.getPoolStats();

    expect(depositCount).to.equal(BigInt(DEPOSIT_COUNT));
    expect(totalDeposited).to.equal(DEPOSIT_VALUE * BigInt(DEPOSIT_COUNT));
    expect(poolBalance).to.equal(DEPOSIT_VALUE * BigInt(DEPOSIT_COUNT));
    expect(await pool.nextIndex()).to.equal(BigInt(DEPOSIT_COUNT));
  });

  it("15 deposits + 10 withdrawals: balance == 5 * denomination", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const withdrawCount = 10;

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
    }

    const root = await pool.getLastRoot();

    for (let i = 0; i < withdrawCount; i++) {
      const nullifier = randomCommitment();
      await doWithdraw(
        pool,
        root,
        nullifier,
        DEPOSIT_VALUE,
        signers[1].address,
        0n,
        ethers.ZeroAddress,
        0n
      );
    }

    const [, totalWithdrawn, , , withdrawalCount, , poolBalance] =
      await pool.getPoolStats();

    expect(withdrawalCount).to.equal(BigInt(withdrawCount));
    expect(totalWithdrawn).to.equal(DEPOSIT_VALUE * BigInt(withdrawCount));
    expect(poolBalance).to.equal(
      DEPOSIT_VALUE * BigInt(DEPOSIT_COUNT - withdrawCount)
    );
  });

  it("15 deposits: all commitments retrievable via getCommitments", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const commitments: bigint[] = [];
    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await doDeposit(pool, signers[(i % 19) + 1], c);
    }

    const fetched = await pool.getCommitments(0, DEPOSIT_COUNT);
    expect(fetched.length).to.equal(DEPOSIT_COUNT);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      expect(fetched[i]).to.equal(commitments[i]);
    }
  });

  it("15 deposits: tree utilization > 0", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
    }

    const utilization = await pool.getTreeUtilization();
    const expectedUtilization =
      (BigInt(DEPOSIT_COUNT) * 100n) / BigInt(TREE_CAPACITY);

    expect(utilization).to.be.gt(0n);
    expect(utilization).to.equal(expectedUtilization);
  });

  it("15 deposits: anonymitySetSize == 15", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
    }

    // activeNoteCount = nextIndex - (withdrawalCount + totalTransfers)
    expect(await pool.getActiveNoteCount()).to.equal(BigInt(DEPOSIT_COUNT));
  });

  it("15 deposits by 5 different users: each has 3 deposits", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const users = [signers[1], signers[2], signers[3], signers[4], signers[5]];
    for (let round = 0; round < 3; round++) {
      for (const user of users) {
        await doDeposit(pool, user);
      }
    }

    for (const user of users) {
      expect(await pool.depositsPerAddress(user.address)).to.equal(3n);
    }

    expect(await pool.nextIndex()).to.equal(15n);
  });

  it("5 users deposit, 5 different users withdraw", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const depositors = [signers[1], signers[2], signers[3], signers[4], signers[5]];
    const withdrawRecipients = [
      signers[6],
      signers[7],
      signers[8],
      signers[9],
      signers[10],
    ];

    for (const user of depositors) {
      await doDeposit(pool, user);
    }

    const root = await pool.getLastRoot();

    for (let i = 0; i < withdrawRecipients.length; i++) {
      const nullifier = randomCommitment();
      const balanceBefore = await ethers.provider.getBalance(
        withdrawRecipients[i].address
      );

      await doWithdraw(
        pool,
        root,
        nullifier,
        DEPOSIT_VALUE,
        withdrawRecipients[i].address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      const balanceAfter = await ethers.provider.getBalance(
        withdrawRecipients[i].address
      );
      expect(balanceAfter - balanceBefore).to.equal(DEPOSIT_VALUE);
    }

    for (const user of depositors) {
      expect(await pool.depositsPerAddress(user.address)).to.equal(1n);
    }
  });

  it("root history fills after 30+ deposits", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const totalDeposits = ROOT_HISTORY_SIZE + 1;
    const rootsInOrder: bigint[] = [];

    for (let i = 0; i < totalDeposits; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
      rootsInOrder.push(await pool.getLastRoot());
    }

    expect(await pool.isKnownRoot(rootsInOrder[0])).to.be.false;
    expect(await pool.isKnownRoot(rootsInOrder[totalDeposits - 1])).to.be.true;
    expect(await pool.isKnownRoot(rootsInOrder[ROOT_HISTORY_SIZE - 1])).to.be.true;
  });

  it("receipts track all 10 deposits correctly", async function () {
    const { pool, owner, signers } = await loadFixture(deployScaleFixture);

    const DepositReceiptFactory = await ethers.getContractFactory(
      "DepositReceipt"
    );
    const receipt = await DepositReceiptFactory.deploy(await pool.getAddress());
    await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

    const depositUsers = signers.slice(1, 11); // 10 distinct users
    for (const user of depositUsers) {
      await doDeposit(pool, user);
    }

    // Each user holds exactly 1 receipt
    for (const user of depositUsers) {
      expect(await receipt.balanceOf(user.address)).to.equal(1n);
    }

    // Token IDs 0..9 assigned in insertion order
    for (let i = 0; i < depositUsers.length; i++) {
      expect(await receipt.ownerOf(i)).to.equal(depositUsers[i].address);
    }
  });

  it("getValidRootCount saturates at ROOT_HISTORY_SIZE", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
    }

    expect(await pool.getValidRootCount()).to.equal(ROOT_HISTORY_SIZE);

    // One more deposit does not exceed ROOT_HISTORY_SIZE
    await doDeposit(pool, signers[1]);
    expect(await pool.getValidRootCount()).to.equal(ROOT_HISTORY_SIZE);
  });

  it("all 15 deposit events emitted correctly", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const commitments: bigint[] = [];
    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      const c = randomCommitment();
      commitments.push(c);
      const tx = await pool
        .connect(signers[(i % 19) + 1])
        .deposit(c, { value: DEPOSIT_VALUE });
      await expect(tx)
        .to.emit(pool, "Deposit")
        .withArgs(c, i, DEPOSIT_VALUE, (v: bigint) => v > 0n);
    }

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      expect(await pool.commitmentIndex(commitments[i])).to.equal(i);
    }
  });

  it("PoolLens snapshot at scale reflects correct values", async function () {
    const { pool, lens, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
    }

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    await doWithdraw(
      pool,
      root,
      nullifier,
      DEPOSIT_VALUE,
      signers[1].address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    const snapshot = await lens.getSnapshot(await pool.getAddress());

    expect(snapshot.depositCount).to.equal(BigInt(DEPOSIT_COUNT));
    expect(snapshot.withdrawalCount).to.equal(1n);
    expect(snapshot.totalDeposited).to.equal(
      DEPOSIT_VALUE * BigInt(DEPOSIT_COUNT)
    );
    expect(snapshot.totalWithdrawn).to.equal(DEPOSIT_VALUE);
    expect(snapshot.poolBalance).to.equal(
      DEPOSIT_VALUE * BigInt(DEPOSIT_COUNT - 1)
    );
    expect(snapshot.treeUtilization).to.be.gt(0n);
    expect(snapshot.treeCapacity).to.equal(BigInt(TREE_CAPACITY));
    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.lastRoot).to.not.equal(0n);
  });

  // --- Additional tests for zk-private-payments specific features ---

  it("10 deposits + 5 transfers: activeNoteCount correct", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const depositCount = 10;
    const transferCount = 5;

    for (let i = 0; i < depositCount; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
    }

    const root = await pool.getLastRoot();

    // Each transfer consumes 1 nullifier and inserts 2 output commitments
    // net change to nextIndex = +2 per transfer, net change to nullifiers spent = +1 per transfer
    for (let i = 0; i < transferCount; i++) {
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();
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

    // activeNoteCount = nextIndex - (withdrawalCount + totalTransfers)
    // nextIndex = depositCount + 2 * transferCount
    // activeNoteCount = (10 + 10) - (0 + 5) = 15
    const expectedActiveNotes =
      BigInt(depositCount) + BigInt(transferCount) * 2n - BigInt(transferCount);
    expect(await pool.getActiveNoteCount()).to.equal(expectedActiveNotes);
  });

  it("batchDeposit(10) + 3 individual deposits: all 13 indexed", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);
    const [, alice] = signers;

    const batchSize = 10;
    const batchCommitments: bigint[] = Array.from(
      { length: batchSize },
      () => randomCommitment()
    );
    const batchAmounts: bigint[] = Array.from(
      { length: batchSize },
      () => DEPOSIT_VALUE
    );
    const totalBatchValue = DEPOSIT_VALUE * BigInt(batchSize);

    await pool
      .connect(alice)
      .batchDeposit(batchCommitments, batchAmounts, { value: totalBatchValue });

    // 3 individual deposits from different signers
    const individualCommitments: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const c = randomCommitment();
      individualCommitments.push(c);
      await doDeposit(pool, signers[i + 2], c);
    }

    expect(await pool.nextIndex()).to.equal(13n);

    // All batch commitments are in the tree at expected indices
    for (let i = 0; i < batchSize; i++) {
      expect(await pool.commitments(batchCommitments[i])).to.be.true;
      expect(await pool.commitmentIndex(batchCommitments[i])).to.equal(i);
    }

    // Individual commitments at indices 10, 11, 12
    for (let i = 0; i < 3; i++) {
      expect(await pool.commitments(individualCommitments[i])).to.be.true;
      expect(await pool.commitmentIndex(individualCommitments[i])).to.equal(
        batchSize + i
      );
    }
  });

  it("5 withdrawals with different amounts: total correct", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    // Deposit varying amounts
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
      ethers.parseEther("4"),
      ethers.parseEther("5"),
    ];
    const totalDeposited = amounts.reduce((a, b) => a + b, 0n);

    for (let i = 0; i < amounts.length; i++) {
      await doDeposit(pool, signers[i + 1], undefined, amounts[i]);
    }

    const root = await pool.getLastRoot();

    let totalWithdrawnExpected = 0n;
    for (let i = 0; i < amounts.length; i++) {
      const nullifier = randomCommitment();
      await doWithdraw(
        pool,
        root,
        nullifier,
        amounts[i],
        signers[i + 1].address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      totalWithdrawnExpected += amounts[i];
    }

    const [td, tw, , , withdrawalCount] = await pool.getPoolStats();

    expect(td).to.equal(totalDeposited);
    expect(tw).to.equal(totalWithdrawnExpected);
    expect(withdrawalCount).to.equal(5n);
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(totalDeposited - totalWithdrawnExpected);
  });

  it("uniqueDepositorCount with 8 different addresses", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const users = signers.slice(1, 9); // 8 unique addresses

    expect(await pool.uniqueDepositorCount()).to.equal(0n);

    for (let i = 0; i < users.length; i++) {
      await doDeposit(pool, users[i]);
      expect(await pool.uniqueDepositorCount()).to.equal(BigInt(i + 1));
    }

    // Repeat deposits from the same users — count must not increase
    for (const user of users) {
      await doDeposit(pool, user);
    }

    expect(await pool.uniqueDepositorCount()).to.equal(BigInt(users.length));
  });

  it("withdrawal records at scale match count", async function () {
    const { pool, signers } = await loadFixture(deployScaleFixture);

    const withdrawCount = 7;

    for (let i = 0; i < withdrawCount; i++) {
      await doDeposit(pool, signers[(i % 19) + 1]);
    }

    const root = await pool.getLastRoot();
    const nullifiers: bigint[] = [];

    for (let i = 0; i < withdrawCount; i++) {
      const nullifier = randomCommitment();
      nullifiers.push(nullifier);
      await doWithdraw(
        pool,
        root,
        nullifier,
        DEPOSIT_VALUE,
        signers[(i % 19) + 1].address,
        0n,
        ethers.ZeroAddress,
        0n
      );
    }

    expect(await pool.getWithdrawalRecordCount()).to.equal(
      BigInt(withdrawCount)
    );

    // Verify each record's nullifier and amount
    for (let i = 0; i < withdrawCount; i++) {
      const record = await pool.getWithdrawalRecord(i);
      expect(record.nullifier).to.equal(nullifiers[i]);
      expect(record.amount).to.equal(DEPOSIT_VALUE);
    }
  });
});
