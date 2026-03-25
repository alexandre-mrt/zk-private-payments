import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const DEPOSIT_AMOUNT = ethers.parseEther("1");
const ONE_DAY = 24 * 60 * 60;

// Gas regression thresholds — set at 2x observed cost on Hardhat local network.
// These are regression guards: they catch O(N) blow-ups and accidental extra
// storage writes, not micro-optimisations. Tighten them when the implementation
// is intentionally changed and the new cost is accepted.
const GAS_LIMITS = {
  DEPOSIT: 700_000n,
  WITHDRAW_WITH_CHANGE: 600_000n,
  WITHDRAW_NO_CHANGE: 300_000n,
  TRANSFER: 700_000n,
  BATCH_DEPOSIT_3: 1_500_000n,
  PAUSE: 50_000n,
  UNPAUSE: 50_000n,
  QUEUE_ACTION: 80_000n,
  CANCEL_ACTION: 50_000n,
  GET_LAST_ROOT: 30_000n,
  IS_KNOWN_ROOT: 50_000n,
  HASH_LEFT_RIGHT: 80_000n,
  EMERGENCY_DRAIN: 100_000n,
  ADD_DENOMINATION: 100_000n,
} as const;

// Dummy zero-proof — the test verifiers always return true.
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
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

type PoolType = Awaited<ReturnType<typeof deployFixture>>["pool"];

/** Compute a timelocked action hash: keccak256(abi.encode(name, uint256)). */
function makeActionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

/** Queue action as owner then advance time past the 1-day timelock. */
async function queueAndWait(pool: PoolType, hash: string): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
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

// ---------------------------------------------------------------------------
// Gas Regression Guards
// ---------------------------------------------------------------------------

describe("Gas Regression Guards", function () {
  // -------------------------------------------------------------------------
  // deposit
  // -------------------------------------------------------------------------

  it("deposit gas < 700K", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    const tx = await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    deposit gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.DEPOSIT,
      `deposit used ${gas} gas, limit is ${GAS_LIMITS.DEPOSIT}`
    );
  });

  // -------------------------------------------------------------------------
  // transfer
  // -------------------------------------------------------------------------

  it("transfer gas < 700K", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    const tx = await pool.connect(alice).transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      out1,
      out2
    );
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    transfer gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.TRANSFER,
      `transfer used ${gas} gas, limit is ${GAS_LIMITS.TRANSFER}`
    );
  });

  // -------------------------------------------------------------------------
  // batchDeposit(3)
  // -------------------------------------------------------------------------

  it("batchDeposit(3) gas < 1.5M", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const count = 3;
    const commitments: bigint[] = [];
    const amounts: bigint[] = [];
    let totalValue = 0n;
    const perItemAmount = ethers.parseEther("0.5");

    for (let i = 0; i < count; i++) {
      commitments.push(randomCommitment());
      amounts.push(perItemAmount);
      totalValue += perItemAmount;
    }

    const tx = await pool
      .connect(alice)
      .batchDeposit(commitments, amounts, { value: totalValue });
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    batchDeposit(3) gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.BATCH_DEPOSIT_3,
      `batchDeposit(3) used ${gas} gas, limit is ${GAS_LIMITS.BATCH_DEPOSIT_3}`
    );
  });

  // -------------------------------------------------------------------------
  // withdraw with change
  // -------------------------------------------------------------------------

  it("withdraw with change gas < 600K", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);
    const depositValue = ethers.parseEther("2");
    await pool.connect(alice).deposit(randomCommitment(), { value: depositValue });
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const changeCommitment = randomCommitment();

    const tx = await pool.connect(alice).withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      ethers.parseEther("1"),
      bob.address,
      changeCommitment,
      ethers.ZeroAddress,
      0n
    );
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    withdraw with change gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.WITHDRAW_WITH_CHANGE,
      `withdraw with change used ${gas} gas, limit is ${GAS_LIMITS.WITHDRAW_WITH_CHANGE}`
    );
  });

  // -------------------------------------------------------------------------
  // withdraw without change
  // -------------------------------------------------------------------------

  it("withdraw without change gas < 300K", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    const tx = await pool.connect(alice).withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      DEPOSIT_AMOUNT,
      bob.address,
      0n, // no change commitment
      ethers.ZeroAddress,
      0n
    );
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    withdraw without change gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.WITHDRAW_NO_CHANGE,
      `withdraw without change used ${gas} gas, limit is ${GAS_LIMITS.WITHDRAW_NO_CHANGE}`
    );
  });

  // -------------------------------------------------------------------------
  // pause / unpause
  // -------------------------------------------------------------------------

  it("pause gas < 50K", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    const tx = await pool.connect(owner).pause();
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    pause gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.PAUSE,
      `pause used ${gas} gas, limit is ${GAS_LIMITS.PAUSE}`
    );
  });

  it("unpause gas < 50K", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    await pool.connect(owner).pause();
    const tx = await pool.connect(owner).unpause();
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    unpause gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.UNPAUSE,
      `unpause used ${gas} gas, limit is ${GAS_LIMITS.UNPAUSE}`
    );
  });

  // -------------------------------------------------------------------------
  // timelock: queueAction / cancelAction
  // -------------------------------------------------------------------------

  it("queueAction gas < 80K", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    const hash = makeActionHash("setMaxDepositsPerAddress", 10n);
    const tx = await pool.connect(owner).queueAction(hash);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    queueAction gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.QUEUE_ACTION,
      `queueAction used ${gas} gas, limit is ${GAS_LIMITS.QUEUE_ACTION}`
    );
  });

  it("cancelAction gas < 50K", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    const hash = makeActionHash("setMaxDepositsPerAddress", 10n);
    await pool.connect(owner).queueAction(hash);
    const tx = await pool.connect(owner).cancelAction();
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    cancelAction gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.CANCEL_ACTION,
      `cancelAction used ${gas} gas, limit is ${GAS_LIMITS.CANCEL_ACTION}`
    );
  });

  // -------------------------------------------------------------------------
  // view functions (static calls — gas measured via estimateGas)
  // -------------------------------------------------------------------------

  it("getLastRoot gas < 30K (view call)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    const gas = await pool.getLastRoot.estimateGas();
    console.log(`    getLastRoot estimateGas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.GET_LAST_ROOT,
      `getLastRoot used ${gas} gas, limit is ${GAS_LIMITS.GET_LAST_ROOT}`
    );
  });

  it("isKnownRoot gas < 50K (view call with loop)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    const root = await pool.getLastRoot();
    const gas = await pool.isKnownRoot.estimateGas(root);
    console.log(`    isKnownRoot estimateGas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.IS_KNOWN_ROOT,
      `isKnownRoot used ${gas} gas, limit is ${GAS_LIMITS.IS_KNOWN_ROOT}`
    );
  });

  it("hashLeftRight gas < 80K", async function () {
    const { pool } = await loadFixture(deployFixture);
    const left = randomCommitment();
    const right = randomCommitment();
    const gas = await pool.hashLeftRight.estimateGas(left, right);
    console.log(`    hashLeftRight estimateGas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.HASH_LEFT_RIGHT,
      `hashLeftRight used ${gas} gas, limit is ${GAS_LIMITS.HASH_LEFT_RIGHT}`
    );
  });

  // -------------------------------------------------------------------------
  // emergencyDrain
  // -------------------------------------------------------------------------

  it("emergencyDrain gas < 100K", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployFixture);

    // Deposit funds so there is a non-zero balance to drain
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    // emergencyDrain requires the pool to be paused
    await pool.connect(owner).pause();

    const tx = await pool.connect(owner).emergencyDrain(bob.address);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    emergencyDrain gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.EMERGENCY_DRAIN,
      `emergencyDrain used ${gas} gas, limit is ${GAS_LIMITS.EMERGENCY_DRAIN}`
    );
  });

  // -------------------------------------------------------------------------
  // addDenomination (via timelock)
  // -------------------------------------------------------------------------

  it("addDenomination (via timelock) gas < 100K", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    const denom = ethers.parseEther("0.1");
    const hash = makeActionHash("addDenomination", denom);
    await queueAndWait(pool, hash);

    const tx = await pool.connect(owner).addDenomination(denom);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed;
    console.log(`    addDenomination gas: ${gas}`);
    expect(gas).to.be.lessThan(
      GAS_LIMITS.ADD_DENOMINATION,
      `addDenomination used ${gas} gas, limit is ${GAS_LIMITS.ADD_DENOMINATION}`
    );
  });
});
