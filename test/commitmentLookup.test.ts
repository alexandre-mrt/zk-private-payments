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
    5,
    hasherAddress
  );

  return { pool, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reverse commitment lookup and paginated listing (ConfidentialPool)", function () {
  it("indexToCommitment returns the correct commitment after a deposit", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const leafIndex = await pool.commitmentIndex(commitment);
    const stored = await pool.indexToCommitment(leafIndex);
    expect(stored).to.equal(commitment);
  });

  it("getCommitments returns the correct range after multiple deposits", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    await pool.connect(alice).deposit(c1, { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(c2, { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(c3, { value: DEPOSIT_AMOUNT });

    const page = await pool.getCommitments(0, 3);
    expect(page.length).to.equal(3);
    expect(page[0]).to.equal(c1);
    expect(page[1]).to.equal(c2);
    expect(page[2]).to.equal(c3);
  });

  it("getCommitments with _from >= nextIndex returns empty array", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    // nextIndex is 1 after one deposit; _from = 5 is beyond the tree
    const result = await pool.getCommitments(5, 3);
    expect(result.length).to.equal(0);
  });

  it("multiple deposits maintain correct ordering in indexToCommitment", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitments: bigint[] = [];

    for (let i = 0; i < 4; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await pool.connect(alice).deposit(c, { value: DEPOSIT_AMOUNT });
    }

    for (let i = 0; i < commitments.length; i++) {
      const stored = await pool.indexToCommitment(i);
      expect(stored).to.equal(commitments[i]);
    }
  });

  it("transfer output commitments are indexed in indexToCommitment", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    // Deposit an input note
    const inputCommitment = randomCommitment();
    await pool.connect(alice).deposit(inputCommitment, { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    // The dummy verifier always returns true, so any proof values work
    await pool.connect(alice).transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      out1,
      out2
    );

    const idx1 = await pool.commitmentIndex(out1);
    const idx2 = await pool.commitmentIndex(out2);

    expect(await pool.indexToCommitment(idx1)).to.equal(out1);
    expect(await pool.indexToCommitment(idx2)).to.equal(out2);
  });
});
