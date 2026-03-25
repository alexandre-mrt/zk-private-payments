import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types/contracts/ConfidentialPool.sol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32
const DEPOSIT_AMOUNT = ethers.parseEther("1");
const WITHDRAW_AMOUNT = ethers.parseEther("0.5");
const ONE_DAY = 24 * 60 * 60;

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

async function depositNote(
  pool: ConfidentialPool,
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  commitment: bigint = randomCommitment(),
  value: bigint = DEPOSIT_AMOUNT
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return commitment;
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

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function timelockSetMaxDeposits(
  pool: ConfidentialPool,
  owner: Signer,
  max: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setMaxDepositsPerAddress", max]
    )
  );
  await pool.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await pool.connect(owner).setMaxDepositsPerAddress(max);
}

async function timelockAddDenomination(
  pool: ConfidentialPool,
  owner: Signer,
  denomination: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["addDenomination", denomination]
    )
  );
  await pool.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await pool.connect(owner).addDenomination(denomination);
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
// Getter Consistency
// ---------------------------------------------------------------------------

describe("Getter Consistency", function () {
  // -------------------------------------------------------------------------
  // getPoolStats values match individual counters
  // -------------------------------------------------------------------------

  it("getPoolStats.depositCount == nextIndex after deposits and transfers", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    const root1 = await pool.getLastRoot();
    await doTransfer(pool, root1, randomCommitment(), randomCommitment(), randomCommitment());

    await depositNote(pool, alice);

    const [, , , depositCount] = await pool.getPoolStats();
    const nextIndex = await pool.getDepositCount();

    // nextIndex: 1 (deposit) + 2 (transfer outputs) + 1 (second deposit) = 4
    expect(depositCount).to.equal(BigInt(nextIndex));
    expect(depositCount).to.equal(4n);
  });

  it("getPoolStats.withdrawalCount == storage withdrawalCount", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    await depositNote(pool, alice);
    const root = await pool.getLastRoot();

    await doWithdraw(pool, root, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);
    await doWithdraw(pool, root, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);

    const [, , , , withdrawalCount] = await pool.getPoolStats();
    const storedWithdrawalCount = await pool.withdrawalCount();

    expect(withdrawalCount).to.equal(storedWithdrawalCount);
    expect(withdrawalCount).to.equal(2n);
  });

  it("getPoolStats.poolBalance == provider.getBalance(pool)", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    await depositNote(pool, alice);
    const root = await pool.getLastRoot();
    await doWithdraw(pool, root, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);

    const [, , , , , , poolBalance] = await pool.getPoolStats();
    const providerBalance = await ethers.provider.getBalance(await pool.getAddress());

    expect(poolBalance).to.equal(providerBalance);
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT * 2n - WITHDRAW_AMOUNT);
  });

  it("getPoolStats.totalTransfers == storage totalTransfers", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    const root1 = await pool.getLastRoot();
    await doTransfer(pool, root1, randomCommitment(), randomCommitment(), randomCommitment());

    await depositNote(pool, alice);
    const root2 = await pool.getLastRoot();
    await doTransfer(pool, root2, randomCommitment(), randomCommitment(), randomCommitment());

    const [, , totalTransfers] = await pool.getPoolStats();
    const storedTotalTransfers = await pool.totalTransfers();

    expect(totalTransfers).to.equal(storedTotalTransfers);
    expect(totalTransfers).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // getActiveNoteCount == nextIndex - (withdrawalCount + totalTransfers)
  // -------------------------------------------------------------------------

  it("getActiveNoteCount == nextIndex - (withdrawalCount + totalTransfers) after mixed ops", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // deposit → transfer → deposit → withdraw
    await depositNote(pool, alice);
    const root1 = await pool.getLastRoot();
    await doTransfer(pool, root1, randomCommitment(), randomCommitment(), randomCommitment());

    await depositNote(pool, alice);
    const root2 = await pool.getLastRoot();
    await doWithdraw(pool, root2, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);

    const activeNoteCount = await pool.getActiveNoteCount();
    const nextIndex = BigInt(await pool.getDepositCount());
    const withdrawalCount = await pool.withdrawalCount();
    const totalTransfers = await pool.totalTransfers();

    expect(activeNoteCount).to.equal(nextIndex - (withdrawalCount + totalTransfers));
  });

  it("getActiveNoteCount is 0 initially", async function () {
    const { pool } = await loadFixture(deployFixture);
    expect(await pool.getActiveNoteCount()).to.equal(0n);
  });

  it("getActiveNoteCount increments by 1 per deposit and 1 per transfer (net +1 per transfer)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    expect(await pool.getActiveNoteCount()).to.equal(1n); // +1 deposit

    const root = await pool.getLastRoot();
    await doTransfer(pool, root, randomCommitment(), randomCommitment(), randomCommitment());
    // -1 input spent, +2 outputs = net +1
    expect(await pool.getActiveNoteCount()).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // getPoolHealth matches individual getters
  // -------------------------------------------------------------------------

  it("getPoolHealth values match individual getters after 3 deposits + 1 withdrawal", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    await depositNote(pool, alice);
    await depositNote(pool, alice);
    const root = await pool.getLastRoot();
    await doWithdraw(pool, root, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);

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
  // PoolLens snapshot matches all individual getters
  // -------------------------------------------------------------------------

  it("PoolLens snapshot matches all individual getters after deposit + transfer + withdraw cycle", async function () {
    const { pool, lens, alice, bob } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    const root1 = await pool.getLastRoot();
    await doTransfer(pool, root1, randomCommitment(), randomCommitment(), randomCommitment());

    await depositNote(pool, alice);
    const root2 = await pool.getLastRoot();
    await doWithdraw(pool, root2, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);

    const poolAddress = await pool.getAddress();
    const snapshot = await lens.getSnapshot(poolAddress);

    const [
      totalDeposited,
      totalWithdrawn,
      totalTransfers,
      depositCount,
      withdrawalCount,
      uniqueDepositors,
      poolBalance,
    ] = await pool.getPoolStats();

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

  // -------------------------------------------------------------------------
  // getWithdrawalRecordCount == withdrawalCount
  // -------------------------------------------------------------------------

  it("getWithdrawalRecordCount == withdrawalCount storage after multiple withdrawals", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    await depositNote(pool, alice);
    await depositNote(pool, alice);
    const root = await pool.getLastRoot();

    await doWithdraw(pool, root, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);
    await doWithdraw(pool, root, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);
    await doWithdraw(pool, root, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);

    const recordCount = await pool.getWithdrawalRecordCount();
    const storedWithdrawalCount = await pool.withdrawalCount();

    expect(recordCount).to.equal(storedWithdrawalCount);
    expect(recordCount).to.equal(3n);
  });

  it("getWithdrawalRecordCount increments by 1 per withdrawal and stays 0 after transfers", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await depositNote(pool, alice);
    const root1 = await pool.getLastRoot();

    // Transfer does NOT add a withdrawal record
    await doTransfer(pool, root1, randomCommitment(), randomCommitment(), randomCommitment());
    expect(await pool.getWithdrawalRecordCount()).to.equal(0n);

    await depositNote(pool, alice);
    const root2 = await pool.getLastRoot();
    await doWithdraw(pool, root2, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);
    expect(await pool.getWithdrawalRecordCount()).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // getDenominations reflects actual allowed denominations
  // -------------------------------------------------------------------------

  it("getDenominations reflects denominations added via timelocked addDenomination", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    // Initially empty
    const before = await pool.getDenominations();
    expect(before.length).to.equal(0);

    const denom1 = ethers.parseEther("1");
    const denom2 = ethers.parseEther("0.5");

    await timelockAddDenomination(pool, owner, denom1);
    await timelockAddDenomination(pool, owner, denom2);

    const after = await pool.getDenominations();
    expect(after.length).to.equal(2);
    expect(after[0]).to.equal(denom1);
    expect(after[1]).to.equal(denom2);

    // allowedDenominations mapping agrees with getDenominations
    for (const d of after) {
      expect(await pool.allowedDenominations(d)).to.be.true;
    }
  });

  it("getDenominations keeps removed denominations in list but allowedDenominations marks them false", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    const denom = ethers.parseEther("1");
    await timelockAddDenomination(pool, owner, denom);

    // Remove via timelock
    const removeHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["removeDenomination", denom]
      )
    );
    await pool.connect(owner).queueAction(removeHash);
    await time.increase(ONE_DAY + 1);
    await pool.connect(owner).removeDenomination(denom);

    // getDenominations still contains the entry (append-only list)
    const list = await pool.getDenominations();
    expect(list.length).to.equal(1);
    expect(list[0]).to.equal(denom);

    // But allowedDenominations says it is no longer active
    expect(await pool.allowedDenominations(denom)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // getTreeCapacity == 2^levels
  // -------------------------------------------------------------------------

  it("getTreeCapacity == 2^levels", async function () {
    const { pool } = await loadFixture(deployFixture);

    const capacity = await pool.getTreeCapacity();
    const levels = await pool.levels();

    expect(capacity).to.equal(2n ** levels);
    expect(capacity).to.equal(TREE_CAPACITY);
  });

  // -------------------------------------------------------------------------
  // getTreeUtilization == (nextIndex * 100) / getTreeCapacity
  // -------------------------------------------------------------------------

  it("getTreeUtilization == (nextIndex * 100) / getTreeCapacity after mixed operations", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    // 1 deposit + transfer (2 outputs) = nextIndex 3
    await depositNote(pool, alice);
    const root = await pool.getLastRoot();
    await doTransfer(pool, root, randomCommitment(), randomCommitment(), randomCommitment());

    const utilization = await pool.getTreeUtilization();
    const capacity = await pool.getTreeCapacity();
    const nextIndex = BigInt(await pool.getDepositCount());

    const expectedUtilization = (nextIndex * 100n) / capacity;
    expect(utilization).to.equal(expectedUtilization);
    // nextIndex == 3
    expect(utilization).to.equal((3n * 100n) / TREE_CAPACITY);
  });

  // -------------------------------------------------------------------------
  // getRemainingDeposits + depositsPerAddress == maxDepositsPerAddress (when set)
  // -------------------------------------------------------------------------

  it("getRemainingDeposits + depositsPerAddress == maxDepositsPerAddress when limit is active", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    const maxDeposits = 4n;
    await timelockSetMaxDeposits(pool, owner, maxDeposits);

    await depositNote(pool, alice);
    await depositNote(pool, alice);
    await depositNote(pool, alice);

    const remaining = await pool.getRemainingDeposits(alice.address);
    const used = await pool.depositsPerAddress(alice.address);
    const max = await pool.maxDepositsPerAddress();

    expect(remaining + used).to.equal(max);
    expect(remaining).to.equal(1n);
    expect(used).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // getPoolStats.poolBalance always equals totalDeposited - totalWithdrawn
  // -------------------------------------------------------------------------

  it("getPoolStats.poolBalance == totalDeposited - totalWithdrawn at all times", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const check = async () => {
      const [totalDeposited, totalWithdrawn, , , , , poolBalance] = await pool.getPoolStats();
      expect(poolBalance).to.equal(totalDeposited - totalWithdrawn);
    };

    await check();

    await depositNote(pool, alice);
    await check();

    const root1 = await pool.getLastRoot();
    await doTransfer(pool, root1, randomCommitment(), randomCommitment(), randomCommitment());
    // transfer does not move ETH — poolBalance unchanged
    await check();

    await depositNote(pool, alice);
    const root2 = await pool.getLastRoot();
    await check();

    await doWithdraw(pool, root2, randomCommitment(), WITHDRAW_AMOUNT, bob.address as `0x${string}`);
    await check();
  });
});
