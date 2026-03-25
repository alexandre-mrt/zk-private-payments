import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, PoolLens, StealthRegistry, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32
const DEPOSIT_AMOUNT = ethers.parseEther("1");
const ONE_DAY = 86_400;

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
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

function randomKey(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

async function doWithdraw(
  pool: ConfidentialPool,
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment = 0n
) {
  return pool.withdraw(
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

  const LensFactory = await ethers.getContractFactory("PoolLens");
  const lens = (await LensFactory.deploy()) as unknown as PoolLens;

  const RegistryFactory = await ethers.getContractFactory("StealthRegistry");
  const registry = (await RegistryFactory.deploy()) as unknown as StealthRegistry;

  return { pool, lens, registry, owner, alice, bob };
}

async function deployWithReceiptFixture() {
  const base = await deployFixture();
  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await base.pool.getAddress()
  )) as unknown as DepositReceipt;
  await base.pool.connect(base.owner).setDepositReceipt(await receipt.getAddress());
  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Milestone Tests
// ---------------------------------------------------------------------------

describe("Milestone Tests", function () {
  it("fresh pool: all counters zero", async function () {
    const { pool } = await loadFixture(deployFixture);
    const [
      totalDeposited,
      totalWithdrawn,
      totalTransfers,
      depositCount,
      withdrawalCount,
      uniqueDepositors,
      poolBalance,
    ] = await pool.getPoolStats();

    expect(totalDeposited).to.equal(0n);
    expect(totalWithdrawn).to.equal(0n);
    expect(totalTransfers).to.equal(0n);
    expect(depositCount).to.equal(0n);
    expect(withdrawalCount).to.equal(0n);
    expect(uniqueDepositors).to.equal(0n);
    expect(poolBalance).to.equal(0n);
  });

  it("first deposit updates all relevant counters", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const [totalDeposited, , , depositCount, , uniqueDepositors, poolBalance] =
      await pool.getPoolStats();

    expect(totalDeposited).to.equal(DEPOSIT_AMOUNT);
    expect(depositCount).to.equal(1n);
    expect(uniqueDepositors).to.equal(1n);
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT);
    expect(await pool.getActiveNoteCount()).to.equal(1n);
    expect(await pool.commitments(commitment)).to.be.true;
  });

  it("first transfer updates correctly", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    await doTransfer(pool, root, nullifier, out1, out2);

    const [, , totalTransfers, nextIndex] = await pool.getPoolStats();
    expect(totalTransfers).to.equal(1n);
    // nextIndex = 1 deposit + 2 transfer outputs = 3 leaves inserted
    expect(nextIndex).to.equal(3n);
    // active notes: original note consumed (nullifier spent), 2 new outputs added
    expect(await pool.getActiveNoteCount()).to.equal(2n);
  });

  it("first withdrawal updates correctly", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const withdrawAmount = ethers.parseEther("0.5");

    await doWithdraw(
      pool,
      root,
      nullifier,
      withdrawAmount,
      await alice.getAddress()
    );

    const [, totalWithdrawn, , , withdrawalCount, , poolBalance] =
      await pool.getPoolStats();

    expect(totalWithdrawn).to.equal(withdrawAmount);
    expect(withdrawalCount).to.equal(1n);
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT - withdrawAmount);
  });

  it("pool health empty", async function () {
    const { pool } = await loadFixture(deployFixture);
    const [
      activeNotes,
      treeUtilization,
      poolBalance,
      isPaused,
      isAllowlisted,
      currentMaxWithdraw,
      currentMinAge,
    ] = await pool.getPoolHealth();

    expect(activeNotes).to.equal(0n);
    expect(treeUtilization).to.equal(0n);
    expect(poolBalance).to.equal(0n);
    expect(isPaused).to.be.false;
    expect(isAllowlisted).to.be.false;
    expect(currentMaxWithdraw).to.equal(0n);
    expect(currentMinAge).to.equal(0n);
  });

  it("pool health after deposit", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const [activeNotes, treeUtilization, poolBalance, isPaused] =
      await pool.getPoolHealth();

    expect(activeNotes).to.equal(1n);
    expect(treeUtilization).to.equal((1n * 100n) / TREE_CAPACITY);
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT);
    expect(isPaused).to.be.false;
  });

  it("pool health after transfer", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    await doTransfer(pool, root, randomCommitment(), out1, out2);

    const [activeNotes] = await pool.getPoolHealth();
    // Transfer consumes 1 note and adds 2 outputs
    expect(activeNotes).to.equal(2n);
  });

  it("pool health after withdrawal", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const withdrawAmount = ethers.parseEther("0.5");
    await doWithdraw(pool, root, randomCommitment(), withdrawAmount, await alice.getAddress());

    const [, , poolBalance] = await pool.getPoolHealth();
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT - withdrawAmount);
  });

  it("lens empty pool", async function () {
    const { pool, lens, owner } = await loadFixture(deployFixture);
    const snapshot = await lens.getSnapshot(await pool.getAddress());

    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.activeNotes).to.equal(0n);
    expect(snapshot.isPaused).to.be.false;
    expect(snapshot.owner).to.equal(await owner.getAddress());
    expect(snapshot.lastRoot).to.be.greaterThan(0n);
  });

  it("lens after deposit", async function () {
    const { pool, lens, alice } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const snapshot = await lens.getSnapshot(await pool.getAddress());

    expect(snapshot.depositCount).to.equal(1n);
    expect(snapshot.activeNotes).to.equal(1n);
    expect(snapshot.totalDeposited).to.equal(DEPOSIT_AMOUNT);
    expect(snapshot.poolBalance).to.equal(DEPOSIT_AMOUNT);
  });

  it("receipt on first deposit", async function () {
    const { pool, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(0n);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);
  });

  it("stealth registry fresh state", async function () {
    const { registry, alice } = await loadFixture(deployFixture);
    const [x, y] = await registry.getViewingKey(await alice.getAddress());
    expect(x).to.equal(0n);
    expect(y).to.equal(0n);
  });

  it("stealth key registration", async function () {
    const { registry, alice } = await loadFixture(deployFixture);
    const kx = randomKey();
    const ky = randomKey();

    await registry.connect(alice).registerViewingKey(kx, ky);

    const [storedX, storedY] = await registry.getViewingKey(await alice.getAddress());
    expect(storedX).to.equal(kx);
    expect(storedY).to.equal(ky);
  });

  it("stealth announcement", async function () {
    const { registry, alice } = await loadFixture(deployFixture);
    const commitment = randomKey();
    const ephX = randomKey();
    const ephY = randomKey();
    const stealthX = randomKey();
    const stealthY = randomKey();
    const encAmt = randomKey();
    const encBlind = randomKey();

    await expect(
      registry
        .connect(alice)
        .announceStealthPayment(commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlind)
    )
      .to.emit(registry, "StealthPayment")
      .withArgs(commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlind);
  });

  it("batch deposit 3 items", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();
    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit([c1, c2, c3], amounts, { value: total });

    expect(await pool.commitments(c1)).to.be.true;
    expect(await pool.commitments(c2)).to.be.true;
    expect(await pool.commitments(c3)).to.be.true;

    const [, , , depositCount] = await pool.getPoolStats();
    expect(depositCount).to.equal(3n);
  });

  it("denomination add + deposit", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);
    const denom = ethers.parseEther("0.5");
    const hash = timelockHash("addDenomination", denom);

    await pool.connect(owner).queueAction(hash);
    await time.increase(ONE_DAY + 1);
    await pool.connect(owner).addDenomination(denom);

    const denominations = await pool.getDenominations();
    expect(denominations).to.include(denom);

    // A deposit of the new denomination should succeed
    const commitment = randomCommitment();
    await expect(
      pool.connect(alice).deposit(commitment, { value: denom })
    ).to.emit(pool, "Deposit");
  });

  it("hash(0,0) consistent", async function () {
    const { pool } = await loadFixture(deployFixture);

    const first = await pool.hashLeftRight(0n, 0n);
    const second = await pool.hashLeftRight(0n, 0n);

    expect(first).to.equal(second);
    expect(first).to.be.greaterThan(0n);
  });

  it("getCommitments(0,0) empty", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const result = await pool.getCommitments(0, 0);
    expect(result.length).to.equal(0);
  });
});
