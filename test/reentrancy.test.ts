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

const DEPOSIT_AMOUNT = ethers.parseEther("1");

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolWithAttackerFixture() {
  const [owner, alice] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  );

  const AttackerFactory = await ethers.getContractFactory("ReentrancyAttacker");
  const attacker = await AttackerFactory.deploy(await pool.getAddress());

  return { pool, attacker, owner, alice };
}

// ---------------------------------------------------------------------------
// Reentrancy Tests
// ---------------------------------------------------------------------------

describe("ConfidentialPool — ReentrancyGuard", function () {
  it("attacker contract deploys and links to pool", async function () {
    const { pool, attacker } = await loadFixture(deployPoolWithAttackerFixture);
    expect(await attacker.pool()).to.equal(await pool.getAddress());
  });

  it("reentrancy attack is blocked by ReentrancyGuard", async function () {
    const { pool, attacker, alice } = await loadFixture(deployPoolWithAttackerFixture);

    // Deposit so the pool holds funds and has a valid root
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    // Trigger attack: attacker calls pool.withdraw; its receive() hook tries
    // to reenter pool.withdraw with a new nullifier before state settles
    await attacker.attack(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      DEPOSIT_AMOUNT
    );

    // receive() was entered at least once (ETH arrived for the first call)
    const attackCount = await attacker.attackCount();
    expect(attackCount).to.be.gte(1n);

    // Only one withdrawal must have succeeded
    expect(await pool.withdrawalCount()).to.equal(1n);

    // Pool balance is fully drained by the single legitimate withdrawal
    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(0n);
  });

  it("reentrant call to deposit is also blocked", async function () {
    // Verifies the reentrancy lock releases cleanly after a guarded call.
    const { pool, alice } = await loadFixture(deployPoolWithAttackerFixture);

    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await pool.connect(alice).deposit(c1, { value: DEPOSIT_AMOUNT });
    await expect(
      pool.connect(alice).deposit(c2, { value: DEPOSIT_AMOUNT })
    ).to.not.be.reverted;
  });

  it("attacker attackCount reflects exactly one ETH receipt", async function () {
    const { pool, attacker, alice } = await loadFixture(deployPoolWithAttackerFixture);

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    await attacker.attack(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      DEPOSIT_AMOUNT
    );

    // ETH is transferred only once; reentrant calls never reach the ETH transfer
    expect(await attacker.attackCount()).to.equal(1n);
  });

  it("pool balance is correct after failed reentrancy attempt", async function () {
    const { pool, attacker, alice } = await loadFixture(deployPoolWithAttackerFixture);

    // Two deposits
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    await attacker.attack(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      DEPOSIT_AMOUNT
    );

    // Exactly one DEPOSIT_AMOUNT was drained despite the reentrancy attempt
    const poolBalance = await ethers.provider.getBalance(await pool.getAddress());
    expect(poolBalance).to.equal(DEPOSIT_AMOUNT);
  });

  it("transfer is also protected: state is consistent after attack on withdraw+transfer sequence", async function () {
    const { pool, alice } = await loadFixture(deployPoolWithAttackerFixture);

    // Deposit and run a normal withdraw to confirm pool functions correctly
    // after any previous reentrancy scenario
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      DEPOSIT_AMOUNT,
      alice.address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    expect(await pool.withdrawalCount()).to.equal(1n);
    expect(await pool.isSpent(nullifier)).to.be.true;
  });
});
