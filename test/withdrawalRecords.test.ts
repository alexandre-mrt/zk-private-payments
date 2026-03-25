import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
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

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
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
    5,
    hasherAddress
  );

  return { pool, owner, alice, bob };
}

async function depositAndGetRoot(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint = ethers.parseEther("1")
) {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WithdrawalRecords", function () {
  it("record count starts at 0", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    expect(await pool.getWithdrawalRecordCount()).to.equal(0n);
  });

  it("creates a record on withdrawal with correct fields", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);
    const nullifier = randomCommitment();
    const withdrawAmount = ethers.parseEther("0.5");

    const txResponse = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      withdrawAmount,
      bob.address,
      0n,
      ethers.ZeroAddress,
      0n
    );
    const receipt = await txResponse.wait();
    const blockNumber = BigInt(receipt!.blockNumber);
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    expect(await pool.getWithdrawalRecordCount()).to.equal(1n);

    const record = await pool.getWithdrawalRecord(0n);
    expect(record.nullifier).to.equal(nullifier);
    expect(record.amount).to.equal(withdrawAmount);
    expect(record.recipient).to.equal(bob.address);
    expect(record.timestamp).to.equal(blockTimestamp);
    expect(record.blockNumber).to.equal(blockNumber);
  });

  it("multiple withdrawals create sequential records", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("3");
    const withdrawAmount = ethers.parseEther("1");

    const nullifier1 = randomCommitment();
    const root1 = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);
    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root1,
      nullifier1,
      withdrawAmount,
      bob.address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    const nullifier2 = randomCommitment();
    const root2 = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);
    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root2,
      nullifier2,
      withdrawAmount,
      alice.address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    expect(await pool.getWithdrawalRecordCount()).to.equal(2n);

    const record0 = await pool.getWithdrawalRecord(0n);
    expect(record0.nullifier).to.equal(nullifier1);
    expect(record0.recipient).to.equal(bob.address);

    const record1 = await pool.getWithdrawalRecord(1n);
    expect(record1.nullifier).to.equal(nullifier2);
    expect(record1.recipient).to.equal(alice.address);
  });

  it("getWithdrawalRecord reverts on invalid index", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    await expect(pool.getWithdrawalRecord(0n)).to.be.revertedWith(
      "ConfidentialPool: invalid record index"
    );
  });

  it("records include non-zero timestamp and block number", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);
    const nullifier = randomCommitment();

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      ethers.parseEther("0.5"),
      bob.address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    const record = await pool.getWithdrawalRecord(0n);
    expect(record.timestamp).to.be.gt(0n);
    expect(record.blockNumber).to.be.gt(0n);
  });
});
