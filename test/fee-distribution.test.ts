import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

async function deployPoolFixture() {
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
    5, // small tree — 32 leaves
    hasherAddress
  );

  return { pool, owner, alice, bob, relayer };
}

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof deployPoolFixture>>["alice"];

/**
 * Deposits `amount` into the pool and returns the Merkle root after insertion.
 * The nullifier is generated fresh and returned for use in the withdraw call.
 */
async function depositAndGetRoot(
  pool: Pool,
  depositor: Signer,
  amount: bigint
): Promise<{ root: bigint; nullifier: bigint }> {
  const commitment = randomCommitment();
  await pool.connect(depositor).deposit(commitment, { value: amount });
  const root = await pool.getLastRoot();
  const nullifier = randomCommitment();
  return { root, nullifier };
}

/**
 * Calls pool.withdraw with the standard ZERO_PROOF (verifier always returns true).
 * changeCommitment is 0n (no change note) unless supplied.
 */
function doWithdraw(
  pool: Pool,
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment: bigint,
  relayer: string,
  fee: bigint
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
    relayer as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Fee Distribution Tests
// ---------------------------------------------------------------------------

describe("Fee Distribution (ConfidentialPool)", function () {
  it("zero fee: full amount goes to recipient", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    const bobBefore = await ethers.provider.getBalance(bob.address);

    await doWithdraw(pool, root, nullifier, amount, bob.address, 0n, ZERO_ADDRESS, 0n);

    const bobAfter = await ethers.provider.getBalance(bob.address);
    expect(bobAfter - bobBefore).to.equal(amount);
  });

  it("10% fee: recipient gets 90%, relayer gets 10%", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const fee = amount / 10n; // 10%
    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    const bobBefore = await ethers.provider.getBalance(bob.address);
    const relayerBefore = await ethers.provider.getBalance(relayer.address);

    await doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, fee);

    const bobAfter = await ethers.provider.getBalance(bob.address);
    const relayerAfter = await ethers.provider.getBalance(relayer.address);

    expect(bobAfter - bobBefore).to.equal(amount - fee);
    expect(relayerAfter - relayerBefore).to.equal(fee);
  });

  it("fee == amount: relayer gets everything, recipient gets zero", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    const bobBefore = await ethers.provider.getBalance(bob.address);
    const relayerBefore = await ethers.provider.getBalance(relayer.address);

    await doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, amount);

    const bobAfter = await ethers.provider.getBalance(bob.address);
    const relayerAfter = await ethers.provider.getBalance(relayer.address);

    expect(bobAfter - bobBefore).to.equal(0n);
    expect(relayerAfter - relayerBefore).to.equal(amount);
  });

  it("fee > amount: reverts", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const fee = amount + 1n;
    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    await expect(
      doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, fee)
    ).to.be.revertedWith("ConfidentialPool: fee exceeds amount");
  });

  it("non-zero fee with zero relayer: reverts", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const fee = ethers.parseEther("0.01");
    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    await expect(
      doWithdraw(pool, root, nullifier, amount, bob.address, 0n, ZERO_ADDRESS, fee)
    ).to.be.revertedWith("ConfidentialPool: zero relayer for non-zero fee");
  });

  it("zero fee with zero relayer: succeeds", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    await expect(
      doWithdraw(pool, root, nullifier, amount, bob.address, 0n, ZERO_ADDRESS, 0n)
    ).to.not.be.reverted;
  });

  it("fee split is exact (no rounding issues with odd amounts)", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    // Odd amount: 3 wei — 1 wei fee, 2 wei to recipient
    const amount = 3n;
    const fee = 1n;
    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    const bobBefore = await ethers.provider.getBalance(bob.address);
    const relayerBefore = await ethers.provider.getBalance(relayer.address);

    await doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, fee);

    const bobAfter = await ethers.provider.getBalance(bob.address);
    const relayerAfter = await ethers.provider.getBalance(relayer.address);

    expect(bobAfter - bobBefore).to.equal(2n);
    expect(relayerAfter - relayerBefore).to.equal(1n);
  });

  it("odd wei amount splits correctly (1 wei fee)", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("0.7");
    const fee = 1n; // 1 wei

    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    const bobBefore = await ethers.provider.getBalance(bob.address);
    const relayerBefore = await ethers.provider.getBalance(relayer.address);

    await doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, fee);

    const bobAfter = await ethers.provider.getBalance(bob.address);
    const relayerAfter = await ethers.provider.getBalance(relayer.address);

    expect(bobAfter - bobBefore).to.equal(amount - 1n);
    expect(relayerAfter - relayerBefore).to.equal(1n);
  });

  it("large fee (1 ETH fee on 2 ETH withdrawal)", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("2");
    const fee = ethers.parseEther("1");

    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    const bobBefore = await ethers.provider.getBalance(bob.address);
    const relayerBefore = await ethers.provider.getBalance(relayer.address);

    await doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, fee);

    const bobAfter = await ethers.provider.getBalance(bob.address);
    const relayerAfter = await ethers.provider.getBalance(relayer.address);

    expect(bobAfter - bobBefore).to.equal(ethers.parseEther("1"));
    expect(relayerAfter - relayerBefore).to.equal(ethers.parseEther("1"));
  });

  it("totalWithdrawn reflects withdrawal amount regardless of fee", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const fee = ethers.parseEther("0.3");

    const { root, nullifier } = await depositAndGetRoot(pool, alice, amount);

    expect(await pool.totalWithdrawn()).to.equal(0n);

    await doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, fee);

    // totalWithdrawn must equal the full withdrawal amount, not amount - fee
    expect(await pool.totalWithdrawn()).to.equal(amount);
  });

  it("withdrawal record stores full amount (not minus fee)", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("2");
    const fee = ethers.parseEther("0.5");
    const nullifier = randomCommitment();

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: amount });
    const root = await pool.getLastRoot();

    await doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, fee);

    // withdrawalRecords[0].amount must be the full withdrawal amount
    const record = await pool.withdrawalRecords(0);
    expect(record.amount).to.equal(amount);
    expect(record.recipient).to.equal(bob.address);
    expect(record.nullifier).to.equal(nullifier);
  });

  it("Withdrawal event includes relayer and fee fields", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    const amount = ethers.parseEther("1");
    const fee = ethers.parseEther("0.1");
    const nullifier = randomCommitment();

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: amount });
    const root = await pool.getLastRoot();

    await expect(
      doWithdraw(pool, root, nullifier, amount, bob.address, 0n, relayer.address, fee)
    )
      .to.emit(pool, "Withdrawal")
      .withArgs(nullifier, amount, bob.address, 0n, relayer.address, fee);
  });
});
