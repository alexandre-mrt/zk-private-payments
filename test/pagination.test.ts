import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_AMOUNT = ethers.parseEther("1");

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
    5,
    hasherAddress
  );

  return { pool, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Operation helpers
// ---------------------------------------------------------------------------

type Pool = Awaited<ReturnType<typeof deployFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function depositNote(pool: Pool, signer: Signer, commitment: bigint): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value: DEPOSIT_AMOUNT });
  return pool.getLastRoot();
}

async function doTransfer(
  pool: Pool,
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

async function doWithdraw(
  pool: Pool,
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
    recipient,
    changeCommitment,
    ethers.ZeroAddress,
    0n
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("Pagination", function () {
  it("getCommitments(0, 0) returns empty array", async function () {
    const { pool } = await loadFixture(deployFixture);
    const result = await pool.getCommitments(0, 0);
    expect(result.length).to.equal(0);
  });

  it("getCommitments(0, 1) returns first commitment after 1 deposit", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const c = randomCommitment();
    await depositNote(pool, alice, c);

    const result = await pool.getCommitments(0, 1);
    expect(result.length).to.equal(1);
    expect(result[0]).to.equal(c);
  });

  it("getCommitments(0, 5) returns all 5 after 5 deposits", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const inserted: bigint[] = [];

    for (let i = 0; i < 5; i++) {
      const c = randomCommitment();
      inserted.push(c);
      await depositNote(pool, alice, c);
    }

    const result = await pool.getCommitments(0, 5);
    expect(result.length).to.equal(5);
    for (let i = 0; i < 5; i++) {
      expect(result[i]).to.equal(inserted[i]);
    }
  });

  it("getCommitments(2, 3) returns correct slice from middle", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const inserted: bigint[] = [];

    for (let i = 0; i < 6; i++) {
      const c = randomCommitment();
      inserted.push(c);
      await depositNote(pool, alice, c);
    }

    // Indexes 2, 3, 4
    const result = await pool.getCommitments(2, 3);
    expect(result.length).to.equal(3);
    expect(result[0]).to.equal(inserted[2]);
    expect(result[1]).to.equal(inserted[3]);
    expect(result[2]).to.equal(inserted[4]);
  });

  it("getCommitments(0, 100) clamps to actual count", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const inserted: bigint[] = [];

    for (let i = 0; i < 3; i++) {
      const c = randomCommitment();
      inserted.push(c);
      await depositNote(pool, alice, c);
    }

    const result = await pool.getCommitments(0, 100);
    expect(result.length).to.equal(3);
    for (let i = 0; i < 3; i++) {
      expect(result[i]).to.equal(inserted[i]);
    }
  });

  it("getCommitments(99, 5) returns empty when past nextIndex", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const c = randomCommitment();
    await depositNote(pool, alice, c);

    const result = await pool.getCommitments(99, 5);
    expect(result.length).to.equal(0);
  });

  it("getCommitments returns commitments in insertion order", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitments: bigint[] = [];

    for (let i = 0; i < 8; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await depositNote(pool, alice, c);
    }

    const result = await pool.getCommitments(0, 8);
    expect(result.length).to.equal(8);
    for (let i = 0; i < 8; i++) {
      expect(result[i]).to.equal(commitments[i]);
    }
  });

  it("pagination is consistent with indexToCommitment", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitments: bigint[] = [];

    for (let i = 0; i < 5; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await depositNote(pool, alice, c);
    }

    const page = await pool.getCommitments(0, 5);

    for (let i = 0; i < 5; i++) {
      const direct = await pool.indexToCommitment(i);
      expect(page[i]).to.equal(direct);
    }
  });

  it("getCommitments includes transfer output commitments", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const depositCommitment = randomCommitment();
    const root = await depositNote(pool, alice, depositCommitment);

    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    await doTransfer(pool, root, nullifier, out1, out2);

    // After 1 deposit + 1 transfer: nextIndex = 3
    const result = await pool.getCommitments(0, 10);
    expect(result.length).to.equal(3);
    expect(result[0]).to.equal(depositCommitment);
    expect(result[1]).to.equal(out1);
    expect(result[2]).to.equal(out2);
  });

  it("getCommitments includes withdrawal change commitment", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const depositCommitment = randomCommitment();
    const root = await depositNote(pool, alice, depositCommitment);

    const nullifier = randomCommitment();
    const changeCommitment = randomCommitment();
    const withdrawAmount = ethers.parseEther("0.7");

    await doWithdraw(pool, root, nullifier, withdrawAmount, bob.address, changeCommitment);

    // Deposit + change commitment = 2 leaves
    const result = await pool.getCommitments(0, 10);
    expect(result.length).to.equal(2);
    expect(result[0]).to.equal(depositCommitment);
    expect(result[1]).to.equal(changeCommitment);
  });

  it("after withdrawal with no change, getCommitments does not grow", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const depositCommitment = randomCommitment();
    const root = await depositNote(pool, alice, depositCommitment);

    const nullifier = randomCommitment();

    // changeCommitment = 0 means no change note is inserted
    await doWithdraw(pool, root, nullifier, DEPOSIT_AMOUNT, bob.address, 0n);

    const result = await pool.getCommitments(0, 10);
    expect(result.length).to.equal(1);
    expect(result[0]).to.equal(depositCommitment);
  });

  it("batchDeposit commitments appear in correct insertion order", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    const amounts = [DEPOSIT_AMOUNT, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT];
    const total = DEPOSIT_AMOUNT * 3n;

    await pool.connect(alice).batchDeposit([c1, c2, c3], amounts, { value: total });

    const result = await pool.getCommitments(0, 10);
    expect(result.length).to.equal(3);
    expect(result[0]).to.equal(c1);
    expect(result[1]).to.equal(c2);
    expect(result[2]).to.equal(c3);
  });

  it("getCommitments after mixed operations returns correct sequence", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    // Step 1: deposit
    const dep = randomCommitment();
    const root0 = await depositNote(pool, alice, dep);

    // Step 2: transfer — consumes deposit, inserts 2 output commitments
    const nullifier1 = randomCommitment();
    const tOut1 = randomCommitment();
    const tOut2 = randomCommitment();
    await doTransfer(pool, root0, nullifier1, tOut1, tOut2);

    // Step 3: withdraw with change — consumes a note (nullifier), inserts 1 change commitment
    const root1 = await pool.getLastRoot();
    const nullifier2 = randomCommitment();
    const change = randomCommitment();
    const withdrawAmount = ethers.parseEther("0.5");
    await doWithdraw(pool, root1, nullifier2, withdrawAmount, bob.address, change);

    // Expected sequence: dep, tOut1, tOut2, change  (4 leaves total)
    const result = await pool.getCommitments(0, 10);
    expect(result.length).to.equal(4);
    expect(result[0]).to.equal(dep);
    expect(result[1]).to.equal(tOut1);
    expect(result[2]).to.equal(tOut2);
    expect(result[3]).to.equal(change);
  });

  it("getCommitments gas is linear in count", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    for (let i = 0; i < 10; i++) {
      await depositNote(pool, alice, randomCommitment());
    }

    const gasSmall = await pool.getCommitments.estimateGas(0, 2);
    const gasLarge = await pool.getCommitments.estimateGas(0, 10);

    expect(gasLarge).to.be.greaterThan(gasSmall);

    // 5× more items should not cost 5× more gas (sub-linear overhead per item)
    const ratio = Number(gasLarge) / Number(gasSmall);
    expect(ratio).to.be.lessThan(5);
  });
});
