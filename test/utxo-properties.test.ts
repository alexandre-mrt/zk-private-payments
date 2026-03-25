import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
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

const ONE_ETH = ethers.parseEther("1");
const HALF_ETH = ethers.parseEther("0.5");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5, // 32-leaf tree — enough for all property tests
    hasherAddress
  );

  return { pool, owner, alice, bob };
}

type Pool = Awaited<ReturnType<typeof deployFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof deployFixture>>["alice"];

async function deposit(
  pool: Pool,
  signer: Signer,
  commitment?: bigint,
  value: bigint = ONE_ETH
): Promise<{ commitment: bigint }> {
  const c = commitment ?? randomCommitment();
  await pool.connect(signer).deposit(c, { value });
  return { commitment: c };
}

async function transfer(
  pool: Pool,
  out1?: bigint,
  out2?: bigint
): Promise<{ nullifier: bigint; out1: bigint; out2: bigint }> {
  const root = await pool.getLastRoot();
  const nullifier = randomCommitment();
  const outputCommitment1 = out1 ?? randomCommitment();
  const outputCommitment2 = out2 ?? randomCommitment();
  await pool.transfer(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    outputCommitment1,
    outputCommitment2
  );
  return { nullifier, out1: outputCommitment1, out2: outputCommitment2 };
}

async function withdraw(
  pool: Pool,
  recipient: Signer,
  amount: bigint = HALF_ETH,
  nullifier?: bigint,
  changeCommitment: bigint = 0n
): Promise<{ nullifier: bigint }> {
  const root = await pool.getLastRoot();
  const n = nullifier ?? randomCommitment();
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    n,
    amount,
    recipient.address as `0x${string}`,
    changeCommitment,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
  return { nullifier: n };
}

// ---------------------------------------------------------------------------
// UTXO Model Properties
// ---------------------------------------------------------------------------

describe("UTXO Model Properties", function () {
  // -------------------------------------------------------------------------
  // Note creation
  // -------------------------------------------------------------------------

  it("deposit creates exactly 1 note (1 Merkle insertion)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const indexBefore = await pool.nextIndex();
    await deposit(pool, alice);
    const indexAfter = await pool.nextIndex();

    expect(indexAfter - indexBefore).to.equal(1n);
  });

  it("batchDeposit(N) creates exactly N notes", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const N = 4;
    const commitments = Array.from({ length: N }, () => randomCommitment());
    const amounts = Array.from({ length: N }, () => ONE_ETH);
    const totalValue = ONE_ETH * BigInt(N);

    const indexBefore = await pool.nextIndex();
    await pool.connect(alice).batchDeposit(commitments, amounts, { value: totalValue });
    const indexAfter = await pool.nextIndex();

    expect(indexAfter - indexBefore).to.equal(BigInt(N));
  });

  it("transfer creates exactly 2 notes (2 Merkle insertions)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    // Need at least one known root for the transfer
    await deposit(pool, alice);
    const indexBefore = await pool.nextIndex();

    await transfer(pool);
    const indexAfter = await pool.nextIndex();

    expect(indexAfter - indexBefore).to.equal(2n);
  });

  it("withdraw with change creates exactly 1 note", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await deposit(pool, alice, undefined, ONE_ETH);
    const indexBefore = await pool.nextIndex();
    const changeCommitment = randomCommitment();

    await withdraw(pool, bob, HALF_ETH, undefined, changeCommitment);
    const indexAfter = await pool.nextIndex();

    expect(indexAfter - indexBefore).to.equal(1n);
  });

  it("withdraw without change creates 0 notes", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await deposit(pool, alice, undefined, ONE_ETH);
    const indexBefore = await pool.nextIndex();

    // changeCommitment = 0n means no change note
    await withdraw(pool, bob, HALF_ETH, undefined, 0n);
    const indexAfter = await pool.nextIndex();

    expect(indexAfter).to.equal(indexBefore);
  });

  // -------------------------------------------------------------------------
  // Note spending
  // -------------------------------------------------------------------------

  it("transfer spends exactly 1 nullifier", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await deposit(pool, alice);
    const { nullifier } = await transfer(pool);

    expect(await pool.nullifiers(nullifier)).to.be.true;
    expect(await pool.totalTransfers()).to.equal(1n);
  });

  it("withdraw spends exactly 1 nullifier", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await deposit(pool, alice);
    const { nullifier } = await withdraw(pool, bob);

    expect(await pool.nullifiers(nullifier)).to.be.true;
    expect(await pool.withdrawalCount()).to.equal(1n);
  });

  it("spent nullifier cannot be reused in transfer", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await deposit(pool, alice);
    const { nullifier } = await transfer(pool);

    // Tree state has changed — need fresh root
    const root = await pool.getLastRoot();
    await expect(
      pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        randomCommitment(),
        randomCommitment()
      )
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
  });

  it("spent nullifier cannot be reused in withdraw", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // Fund with enough for two withdrawals
    await deposit(pool, alice, undefined, ONE_ETH);
    await deposit(pool, alice, undefined, ONE_ETH);

    const { nullifier } = await withdraw(pool, bob, HALF_ETH);

    const root = await pool.getLastRoot();
    await expect(
      pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        HALF_ETH,
        bob.address as `0x${string}`,
        0n,
        ethers.ZeroAddress as `0x${string}`,
        0n
      )
    ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
  });

  it("different nullifiers can be spent independently", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // Fund with 3 ETH so each of three withdrawals of 0.5 ETH succeeds
    await deposit(pool, alice, undefined, ONE_ETH);
    await deposit(pool, alice, undefined, ONE_ETH);
    await deposit(pool, alice, undefined, ONE_ETH);

    const n1 = randomCommitment();
    const n2 = randomCommitment();
    const n3 = randomCommitment();

    await withdraw(pool, bob, HALF_ETH, n1);
    await withdraw(pool, bob, HALF_ETH, n2);
    await withdraw(pool, bob, HALF_ETH, n3);

    expect(await pool.nullifiers(n1)).to.be.true;
    expect(await pool.nullifiers(n2)).to.be.true;
    expect(await pool.nullifiers(n3)).to.be.true;
    expect(await pool.withdrawalCount()).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // Balance preservation
  // -------------------------------------------------------------------------

  it("pool balance = sum(deposits) - sum(withdrawals)", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const depositAmount = ethers.parseEther("3");
    await deposit(pool, alice, undefined, depositAmount);
    await deposit(pool, alice, undefined, depositAmount);

    const withdrawAmount = ethers.parseEther("1");
    await withdraw(pool, bob, withdrawAmount);
    await withdraw(pool, bob, withdrawAmount);

    const poolBalance = await ethers.provider.getBalance(
      await pool.getAddress()
    );
    const [totalDeposited, totalWithdrawn] = await pool.getPoolStats();

    expect(poolBalance).to.equal(totalDeposited - totalWithdrawn);
  });

  it("transfer preserves pool ETH balance (no ETH moves)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await deposit(pool, alice, undefined, ONE_ETH);

    const balanceBefore = await ethers.provider.getBalance(
      await pool.getAddress()
    );
    await transfer(pool);
    const balanceAfter = await ethers.provider.getBalance(
      await pool.getAddress()
    );

    expect(balanceAfter).to.equal(balanceBefore);
  });

  it("activeNoteCount = nextIndex - nullifiersSpent", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // 3 deposits → nextIndex = 3, nullifiersSpent = 0 → activeNotes = 3
    await deposit(pool, alice);
    await deposit(pool, alice);
    await deposit(pool, alice);

    expect(await pool.getActiveNoteCount()).to.equal(3n);

    // 1 transfer → nextIndex = 5, totalTransfers = 1, withdrawalCount = 0
    // nullifiersSpent = 1 + 0 = 1 → activeNotes = 5 - 1 = 4
    await transfer(pool);
    expect(await pool.getActiveNoteCount()).to.equal(4n);

    // 1 withdraw (no change) → nextIndex = 5, totalTransfers = 1, withdrawalCount = 1
    // nullifiersSpent = 1 + 1 = 2 → activeNotes = 5 - 2 = 3
    await withdraw(pool, bob, HALF_ETH, undefined, 0n);
    expect(await pool.getActiveNoteCount()).to.equal(3n);

    // 1 withdraw with change → nextIndex = 6, totalTransfers = 1, withdrawalCount = 2
    // nullifiersSpent = 1 + 2 = 3 → activeNotes = 6 - 3 = 3
    await deposit(pool, alice);
    // nextIndex now 7; nullifiersSpent 3 → activeNotes 4
    const changeCommitment = randomCommitment();
    await withdraw(pool, bob, HALF_ETH, undefined, changeCommitment);
    // nextIndex 8, nullifiersSpent 4 → activeNotes 4
    const active = await pool.getActiveNoteCount();
    const ni = await pool.nextIndex();
    const transfers = await pool.totalTransfers();
    const withCount = await pool.withdrawalCount();
    expect(active).to.equal(BigInt(ni) - (transfers + withCount));
  });

  // -------------------------------------------------------------------------
  // Tree growth
  // -------------------------------------------------------------------------

  it("nextIndex grows by 1 per deposit, 2 per transfer, 0-1 per withdraw", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // Deposit: +1
    let idx = await pool.nextIndex();
    await deposit(pool, alice);
    expect(await pool.nextIndex()).to.equal(idx + 1n);

    // Transfer: +2
    idx = await pool.nextIndex();
    await transfer(pool);
    expect(await pool.nextIndex()).to.equal(idx + 2n);

    // Withdraw without change: +0
    idx = await pool.nextIndex();
    await withdraw(pool, bob, HALF_ETH, undefined, 0n);
    expect(await pool.nextIndex()).to.equal(idx);

    // Withdraw with change: +1
    idx = await pool.nextIndex();
    const changeCommitment = randomCommitment();
    await withdraw(pool, bob, HALF_ETH, undefined, changeCommitment);
    expect(await pool.nextIndex()).to.equal(idx + 1n);
  });

  it("all inserted commitments are retrievable via indexToCommitment", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const { commitment: c1 } = await deposit(pool, alice);
    const { commitment: c2 } = await deposit(pool, alice);
    const { out1, out2 } = await transfer(pool);

    // Indices are assigned sequentially starting from 0
    expect(await pool.indexToCommitment(0)).to.equal(c1);
    expect(await pool.indexToCommitment(1)).to.equal(c2);
    expect(await pool.indexToCommitment(2)).to.equal(out1);
    expect(await pool.indexToCommitment(3)).to.equal(out2);
  });
});
