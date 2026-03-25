import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// Fixed amounts used in tests
const AMOUNT_1 = ethers.parseEther("0.5");
const AMOUNT_2 = ethers.parseEther("0.3");
const AMOUNT_3 = ethers.parseEther("0.2");

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
  const [owner, alice, bob, relayer] = await ethers.getSigners();

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

  return { pool, owner, alice, bob, relayer };
}

type Pool = Awaited<ReturnType<typeof deployFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof deployFixture>>["alice"];

// ---------------------------------------------------------------------------
// Operation helpers
// ---------------------------------------------------------------------------

async function doDeposit(
  pool: Pool,
  signer: Signer,
  amount: bigint,
  commitment?: bigint
) {
  const c = commitment ?? randomCommitment();
  await pool.connect(signer).deposit(c, { value: amount });
  return c;
}

async function doWithdraw(
  pool: Pool,
  amount: bigint,
  recipient: Signer,
  changeCommitment: bigint = 0n,
  relayerAddr: string = ethers.ZeroAddress,
  fee: bigint = 0n
) {
  const root = await pool.getLastRoot();
  const nullifier = randomCommitment();
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient.address as `0x${string}`,
    changeCommitment,
    relayerAddr as `0x${string}`,
    fee
  );
}

async function doTransfer(pool: Pool) {
  const root = await pool.getLastRoot();
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

// Reads provider balance and asserts it matches getPoolStats.poolBalance and getPoolBalance.
async function assertBalanceConsistency(pool: Pool): Promise<bigint> {
  const poolAddr = await pool.getAddress();
  const providerBalance = await ethers.provider.getBalance(poolAddr);

  const [, , , , , , statsBalance] = await pool.getPoolStats();
  expect(statsBalance).to.equal(
    providerBalance,
    "getPoolStats.poolBalance must match provider.getBalance"
  );

  const directBalance = await pool.getPoolBalance();
  expect(directBalance).to.equal(
    providerBalance,
    "getPoolBalance() must match provider.getBalance"
  );

  return providerBalance;
}

// ---------------------------------------------------------------------------
// Balance Accounting Tests
// ---------------------------------------------------------------------------

describe("Balance Accounting", function () {
  it("initial balance is 0", async function () {
    const { pool } = await loadFixture(deployFixture);

    const balance = await assertBalanceConsistency(pool);
    expect(balance).to.equal(0n);
  });

  it("after 1 deposit: balance == deposit amount", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, AMOUNT_1);

    const balance = await assertBalanceConsistency(pool);
    expect(balance).to.equal(AMOUNT_1);
  });

  it("after N deposits with variable amounts: balance == sum of amounts", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const amounts = [AMOUNT_1, AMOUNT_2, AMOUNT_3, AMOUNT_1, AMOUNT_2];
    const expectedTotal = amounts.reduce((acc, a) => acc + a, 0n);

    for (const amount of amounts) {
      await doDeposit(pool, alice, amount);
    }

    const balance = await assertBalanceConsistency(pool);
    expect(balance).to.equal(expectedTotal);
  });

  it("after deposit + withdrawal: balance == 0", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, AMOUNT_1);
    await doWithdraw(pool, AMOUNT_1, bob);

    const balance = await assertBalanceConsistency(pool);
    expect(balance).to.equal(0n);
  });

  it("after 5 deposits + 2 withdrawals: balance == totalDeposited - totalWithdrawn", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const depositAmount = AMOUNT_1;
    const withdrawAmount = AMOUNT_2;

    for (let i = 0; i < 5; i++) {
      await doDeposit(pool, alice, depositAmount);
    }
    for (let i = 0; i < 2; i++) {
      await doWithdraw(pool, withdrawAmount, bob);
    }

    const balance = await assertBalanceConsistency(pool);
    const [totalDeposited, totalWithdrawn] = await pool.getPoolStats();
    expect(balance).to.equal(totalDeposited - totalWithdrawn);
  });

  it("balance == getPoolStats.poolBalance at all times", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await assertBalanceConsistency(pool);

    for (let i = 0; i < 3; i++) {
      await doDeposit(pool, alice, AMOUNT_1);
      await assertBalanceConsistency(pool);
    }

    for (let i = 0; i < 2; i++) {
      await doWithdraw(pool, AMOUNT_2, bob);
      await assertBalanceConsistency(pool);
    }
  });

  it("balance == totalDeposited - totalWithdrawn at all times", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const assertAccounting = async () => {
      const [totalDeposited, totalWithdrawn, , , , , poolBalance] =
        await pool.getPoolStats();
      expect(poolBalance).to.equal(
        totalDeposited - totalWithdrawn,
        "balance must equal totalDeposited - totalWithdrawn"
      );
    };

    await assertAccounting();

    for (let i = 0; i < 4; i++) {
      await doDeposit(pool, alice, AMOUNT_1);
      await assertAccounting();
    }

    for (let i = 0; i < 3; i++) {
      await doWithdraw(pool, AMOUNT_2, bob);
      await assertAccounting();
    }
  });

  it("transfer does not change pool balance", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, AMOUNT_1);

    const balanceBefore = await assertBalanceConsistency(pool);

    await doTransfer(pool);

    const balanceAfter = await assertBalanceConsistency(pool);
    expect(balanceAfter).to.equal(balanceBefore);
  });

  it("batchDeposit adds sum of amounts to balance", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();
    const amounts = [AMOUNT_1, AMOUNT_2, AMOUNT_3];
    const total = amounts.reduce((acc, a) => acc + a, 0n);

    await pool.connect(alice).batchDeposit([c1, c2, c3], amounts, {
      value: total,
    });

    const balance = await assertBalanceConsistency(pool);
    expect(balance).to.equal(total);

    const [totalDeposited] = await pool.getPoolStats();
    expect(totalDeposited).to.equal(total);
  });

  it("withdrawal with fee: pool balance decreases by full withdrawal amount", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, AMOUNT_1);
    const balanceBefore = await assertBalanceConsistency(pool);

    const fee = ethers.parseEther("0.01");
    const withdrawAmount = AMOUNT_1;

    await doWithdraw(
      pool,
      withdrawAmount,
      bob,
      0n,
      await relayer.getAddress(),
      fee
    );

    const balanceAfter = await assertBalanceConsistency(pool);
    // Full withdraw amount (including fee portion) leaves the pool
    expect(balanceBefore - balanceAfter).to.equal(withdrawAmount);
    expect(balanceAfter).to.equal(0n);
  });

  it("emergency drain sets balance to 0", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, AMOUNT_1);
    await doDeposit(pool, alice, AMOUNT_2);

    const balanceBefore = await assertBalanceConsistency(pool);
    expect(balanceBefore).to.equal(AMOUNT_1 + AMOUNT_2);

    await pool.connect(owner).pause();
    const ownerAddr = await owner.getAddress();
    await pool.connect(owner).emergencyDrain(ownerAddr as `0x${string}`);

    const balanceAfter = await assertBalanceConsistency(pool);
    expect(balanceAfter).to.equal(0n);
  });

  it("balance never goes below 0 (withdrawal fails if insufficient)", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // Pool is empty — withdrawal must revert
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    await expect(
      pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        AMOUNT_1,
        bob.address as `0x${string}`,
        0n,
        ethers.ZeroAddress as `0x${string}`,
        0n
      )
    ).to.be.revertedWith("ConfidentialPool: insufficient pool balance");

    // Balance remains 0 after the failed attempt
    const balance = await assertBalanceConsistency(pool);
    expect(balance).to.equal(0n);

    // A proper deposit + withdrawal still clears the pool
    await doDeposit(pool, alice, AMOUNT_1);
    await doWithdraw(pool, AMOUNT_1, bob);
    const finalBalance = await assertBalanceConsistency(pool);
    expect(finalBalance).to.equal(0n);
  });

  it("10 deposits + 10 withdrawals: final balance == 0", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);
    const amount = AMOUNT_1;

    for (let i = 0; i < 10; i++) {
      await doDeposit(pool, alice, amount);
    }

    const [, , , , , , balanceMid] = await pool.getPoolStats();
    expect(balanceMid).to.equal(10n * amount);

    for (let i = 0; i < 10; i++) {
      await doWithdraw(pool, amount, bob);
    }

    const balance = await assertBalanceConsistency(pool);
    expect(balance).to.equal(0n);

    const [totalDeposited, totalWithdrawn] = await pool.getPoolStats();
    expect(totalDeposited).to.equal(totalWithdrawn);
    expect(totalDeposited).to.equal(10n * amount);
  });
});
