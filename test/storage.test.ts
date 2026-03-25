import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const ROOT_HISTORY_SIZE = 30n;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

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
  const transferVerifierAddress = await transferVerifier.getAddress();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();
  const withdrawVerifierAddress = await withdrawVerifier.getAddress();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    transferVerifierAddress,
    withdrawVerifierAddress,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  return {
    pool,
    transferVerifierAddress,
    withdrawVerifierAddress,
    hasherAddress,
    owner,
    alice,
    bob,
  };
}

// ---------------------------------------------------------------------------
// Storage Verification
// ---------------------------------------------------------------------------

describe("Storage Verification", function () {
  it("transferVerifier address is stored correctly and immutable", async () => {
    const { pool, transferVerifierAddress } = await loadFixture(deployFixture);

    expect(await pool.transferVerifier()).to.equal(transferVerifierAddress);
  });

  it("withdrawVerifier address is stored correctly and immutable", async () => {
    const { pool, withdrawVerifierAddress } = await loadFixture(deployFixture);

    expect(await pool.withdrawVerifier()).to.equal(withdrawVerifierAddress);
  });

  it("deployedChainId is stored correctly and immutable", async () => {
    const { pool } = await loadFixture(deployFixture);

    const { chainId } = await ethers.provider.getNetwork();
    expect(await pool.deployedChainId()).to.equal(chainId);
  });

  it("levels is stored correctly and immutable", async () => {
    const { pool } = await loadFixture(deployFixture);

    expect(await pool.levels()).to.equal(MERKLE_TREE_HEIGHT);
  });

  it("hasher address is stored correctly and immutable", async () => {
    const { pool, hasherAddress } = await loadFixture(deployFixture);

    expect(await pool.hasher()).to.equal(hasherAddress);
  });

  it("allowlistEnabled initializes as false and is a boolean", async () => {
    const { pool } = await loadFixture(deployFixture);

    expect(await pool.allowlistEnabled()).to.equal(false);
  });

  it("totalDeposited and totalWithdrawn are uint256 and start at zero", async () => {
    const { pool } = await loadFixture(deployFixture);

    expect(await pool.totalDeposited()).to.equal(0n);
    expect(await pool.totalWithdrawn()).to.equal(0n);
  });

  it("totalTransfers is uint256 and starts at zero", async () => {
    const { pool } = await loadFixture(deployFixture);

    expect(await pool.totalTransfers()).to.equal(0n);
  });

  it("totalDeposited accumulates across deposits", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const amount1 = ethers.parseEther("1");
    const amount2 = ethers.parseEther("0.5");

    const commitment1 = randomCommitment();
    const commitment2 = randomCommitment();

    await pool.connect(alice).deposit(commitment1, { value: amount1 });
    expect(await pool.totalDeposited()).to.equal(amount1);

    await pool.connect(alice).deposit(commitment2, { value: amount2 });
    expect(await pool.totalDeposited()).to.equal(amount1 + amount2);
  });

  it("uniqueDepositorCount tracks distinct depositors correctly", async () => {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    expect(await pool.uniqueDepositorCount()).to.equal(0n);

    // Alice deposits twice — should count as 1 unique depositor
    const commitment1 = randomCommitment();
    await pool.connect(alice).deposit(commitment1, { value: ethers.parseEther("1") });
    expect(await pool.uniqueDepositorCount()).to.equal(1n);

    const commitment2 = randomCommitment();
    await pool.connect(alice).deposit(commitment2, { value: ethers.parseEther("1") });
    expect(await pool.uniqueDepositorCount()).to.equal(1n);

    // Bob deposits once — count becomes 2
    const commitment3 = randomCommitment();
    await pool.connect(bob).deposit(commitment3, { value: ethers.parseEther("1") });
    expect(await pool.uniqueDepositorCount()).to.equal(2n);
  });

  it("maxWithdrawAmount, minDepositAge, maxDepositsPerAddress initialise as zero", async () => {
    const { pool } = await loadFixture(deployFixture);

    expect(await pool.maxWithdrawAmount()).to.equal(0n);
    expect(await pool.minDepositAge()).to.equal(0n);
    expect(await pool.maxDepositsPerAddress()).to.equal(0n);
  });

  it("nextIndex starts at zero and increments with each deposit", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    expect(await pool.nextIndex()).to.equal(0n);

    const commitment1 = randomCommitment();
    await pool.connect(alice).deposit(commitment1, { value: ethers.parseEther("1") });
    expect(await pool.nextIndex()).to.equal(1n);

    const commitment2 = randomCommitment();
    await pool.connect(alice).deposit(commitment2, { value: ethers.parseEther("1") });
    expect(await pool.nextIndex()).to.equal(2n);
  });

  it("currentRootIndex wraps around ROOT_HISTORY_SIZE", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    // Initial state: currentRootIndex is 0
    expect(await pool.currentRootIndex()).to.equal(0n);

    // After ROOT_HISTORY_SIZE deposits the index wraps back to 0
    for (let i = 0; i < Number(ROOT_HISTORY_SIZE); i++) {
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
    }

    expect(await pool.currentRootIndex()).to.equal(0n);
  });

  it("withdrawalRecords array grows with each withdrawal", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });

    expect(await pool.getWithdrawalRecordCount()).to.equal(0n);

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const withdrawAmount = ethers.parseEther("1");
    const recipientAddr = await alice.getAddress() as `0x${string}`;

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      withdrawAmount,
      recipientAddr,
      0n,          // no change commitment
      recipientAddr,
      0n           // no fee
    );

    expect(await pool.getWithdrawalRecordCount()).to.equal(1n);

    // Second withdrawal
    const commitment2 = randomCommitment();
    await pool.connect(alice).deposit(commitment2, { value: ethers.parseEther("1") });

    const root2 = await pool.getLastRoot();
    const nullifier2 = randomCommitment();

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root2,
      nullifier2,
      withdrawAmount,
      recipientAddr,
      0n,
      recipientAddr,
      0n
    );

    expect(await pool.getWithdrawalRecordCount()).to.equal(2n);
  });

  it("operationsPerBlock mapping increments per block operation", async () => {
    const { pool, alice, owner } = await loadFixture(deployFixture);

    // Enable the per-block limit so the counter is tracked
    await pool.connect(owner).setMaxOperationsPerBlock(100n);

    const blockBefore = await ethers.provider.getBlockNumber();

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });

    const blockAfter = await ethers.provider.getBlockNumber();
    expect(await pool.operationsPerBlock(blockAfter)).to.equal(1n);

    // A new block should have a fresh zero count
    await mine(1);
    const nextBlock = await ethers.provider.getBlockNumber();
    expect(await pool.operationsPerBlock(nextBlock)).to.equal(0n);

    // Suppress unused variable warning
    void blockBefore;
  });

  it("nullifiers mapping stores boolean flags correctly", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const nullifier = randomCommitment();

    // Before withdrawal — not spent
    expect(await pool.nullifiers(nullifier)).to.equal(false);

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });

    const root = await pool.getLastRoot();
    const recipientAddr = await alice.getAddress() as `0x${string}`;

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      ethers.parseEther("1"),
      recipientAddr,
      0n,
      recipientAddr,
      0n
    );

    // After withdrawal — marked as spent
    expect(await pool.nullifiers(nullifier)).to.equal(true);
  });

  it("commitments mapping stores boolean flags correctly", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();

    expect(await pool.commitments(commitment)).to.equal(false);

    await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });

    expect(await pool.commitments(commitment)).to.equal(true);
  });
});
