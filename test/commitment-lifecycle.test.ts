import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;
const DEPOSIT_AMOUNT = ethers.parseEther("1");

// Placeholder proof values — stub verifiers always return true
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
    TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Fixture with DepositReceipt wired
// ---------------------------------------------------------------------------

async function deployFixtureWithReceipt() {
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
    TREE_HEIGHT,
    hasherAddress
  );

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = await ReceiptFactory.deploy(await pool.getAddress());

  // setDepositReceipt has no timelock in ConfidentialPool
  await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { pool, receipt, owner, alice };
}

// ---------------------------------------------------------------------------
// Commitment Lifecycle
// ---------------------------------------------------------------------------

describe("Commitment Lifecycle (ConfidentialPool)", function () {
  // -------------------------------------------------------------------------
  // 1. commitment starts unknown (isCommitted = false)
  // -------------------------------------------------------------------------

  it("commitment starts unknown (isCommitted = false)", async function () {
    const { pool } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    expect(await pool.isCommitted(commitment)).to.be.false;
    expect(await pool.commitments(commitment)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 2. after deposit: isCommitted = true
  // -------------------------------------------------------------------------

  it("after deposit: isCommitted = true", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    expect(await pool.isCommitted(commitment)).to.be.true;
    expect(await pool.commitments(commitment)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 3. commitment has a leafIndex (getCommitmentIndex)
  // -------------------------------------------------------------------------

  it("commitment has a leafIndex (getCommitmentIndex)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const c0 = randomCommitment();
    const c1 = randomCommitment();

    await pool.connect(alice).deposit(c0, { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(c1, { value: DEPOSIT_AMOUNT });

    expect(await pool.getCommitmentIndex(c0)).to.equal(0n);
    expect(await pool.getCommitmentIndex(c1)).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // 4. commitment is retrievable by index (indexToCommitment)
  // -------------------------------------------------------------------------

  it("commitment is retrievable by index (indexToCommitment)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const leafIndex = await pool.commitmentIndex(commitment);
    expect(await pool.indexToCommitment(leafIndex)).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // 5. commitment appears in getCommitments pagination
  // -------------------------------------------------------------------------

  it("commitment appears in getCommitments pagination", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await pool.connect(alice).deposit(c0, { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(c1, { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(c2, { value: DEPOSIT_AMOUNT });

    const page = await pool.getCommitments(0, 3);
    expect(page.length).to.equal(3);
    expect(page[0]).to.equal(c0);
    expect(page[1]).to.equal(c1);
    expect(page[2]).to.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 6. commitment is part of Merkle root (isKnownRoot for current root)
  // -------------------------------------------------------------------------

  it("commitment is part of Merkle root (isKnownRoot for current root)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    const rootBefore = await pool.getLastRoot();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    const rootAfter = await pool.getLastRoot();

    expect(rootAfter).to.not.equal(rootBefore);
    expect(rootAfter).to.not.equal(0n);
    expect(await pool.isKnownRoot(rootAfter)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 7. commitment persists after new deposits (still committed)
  // -------------------------------------------------------------------------

  it("commitment persists after new deposits (still committed)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const first = randomCommitment();

    await pool.connect(alice).deposit(first, { value: DEPOSIT_AMOUNT });

    for (let i = 0; i < 4; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    }

    expect(await pool.isCommitted(first)).to.be.true;
    expect(await pool.getCommitmentIndex(first)).to.equal(0n);
    expect(await pool.indexToCommitment(0)).to.equal(first);
  });

  // -------------------------------------------------------------------------
  // 8. commitment survives pause/unpause
  // -------------------------------------------------------------------------

  it("commitment survives pause/unpause", async function () {
    const { pool, owner, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    await pool.connect(owner).pause();
    await pool.connect(owner).unpause();

    expect(await pool.isCommitted(commitment)).to.be.true;
    expect(await pool.indexToCommitment(0)).to.equal(commitment);
    expect(await pool.nextIndex()).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // 9. commitment is permanent (no way to remove)
  // -------------------------------------------------------------------------

  it("commitment is permanent (no way to remove)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    // Subsequent operations do not erase the original commitment
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      randomCommitment(),
      randomCommitment()
    );

    expect(await pool.isCommitted(commitment)).to.be.true;
    expect(await pool.getCommitmentIndex(commitment)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // 10. duplicate commitment blocked on second attempt
  // -------------------------------------------------------------------------

  it("duplicate commitment blocked on second attempt", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    await expect(
      pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT })
    ).to.be.revertedWith("ConfidentialPool: duplicate commitment");

    expect(await pool.nextIndex()).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // 11. receipt tracks commitment if configured
  // -------------------------------------------------------------------------

  it("receipt tracks commitment if configured", async function () {
    const { pool, receipt, alice } = await loadFixture(deployFixtureWithReceipt);
    const commitment = randomCommitment();

    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(0n);

    await pool.connect(alice).deposit(commitment, { value: DEPOSIT_AMOUNT });

    expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);
    expect(await pool.isCommitted(commitment)).to.be.true;
    expect(await pool.indexToCommitment(0)).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // 12. commitment in Deposit event matches on-chain state
  // -------------------------------------------------------------------------

  it("commitment in Deposit event matches on-chain state", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: DEPOSIT_AMOUNT });
    const receipt = await tx.wait();

    const iface = pool.interface;
    const depositTopic = iface.getEvent("Deposit")?.topicHash;
    const log = receipt?.logs.find((l) => l.topics[0] === depositTopic);
    expect(log).to.not.be.undefined;

    const decoded = iface.parseLog({ topics: log!.topics, data: log!.data });
    expect(decoded).to.not.be.null;

    const eventCommitment: bigint = decoded!.args[0];
    const eventLeafIndex: bigint = decoded!.args[1];
    const eventAmount: bigint = decoded!.args[2];

    expect(eventCommitment).to.equal(commitment);
    expect(eventAmount).to.equal(DEPOSIT_AMOUNT);
    expect(await pool.isCommitted(eventCommitment)).to.be.true;
    expect(await pool.getCommitmentIndex(eventCommitment)).to.equal(eventLeafIndex);
    expect(await pool.indexToCommitment(Number(eventLeafIndex))).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // 13. transfer output commitments follow the same lifecycle
  // -------------------------------------------------------------------------

  it("transfer output commitments follow the same lifecycle", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const inputCommitment = randomCommitment();
    await pool.connect(alice).deposit(inputCommitment, { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    // Both outputs are unknown before the transfer
    expect(await pool.isCommitted(out1)).to.be.false;
    expect(await pool.isCommitted(out2)).to.be.false;

    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      out1,
      out2
    );

    // After transfer: both output commitments are committed
    expect(await pool.isCommitted(out1)).to.be.true;
    expect(await pool.isCommitted(out2)).to.be.true;

    // Leaf indices are sequential and reverse-lookups work
    const idx1 = await pool.commitmentIndex(out1);
    const idx2 = await pool.commitmentIndex(out2);
    expect(idx2).to.equal(idx1 + 1n);
    expect(await pool.indexToCommitment(idx1)).to.equal(out1);
    expect(await pool.indexToCommitment(idx2)).to.equal(out2);

    // Both appear in paginated listing
    const page = await pool.getCommitments(Number(idx1), 2);
    expect(page[0]).to.equal(out1);
    expect(page[1]).to.equal(out2);

    // New root includes transfer outputs
    const rootAfter = await pool.getLastRoot();
    expect(await pool.isKnownRoot(rootAfter)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 14. withdrawal change commitment follows the same lifecycle
  // -------------------------------------------------------------------------

  it("withdrawal change commitment follows the same lifecycle", async function () {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const depositAmount = ethers.parseEther("2");
    const withdrawAmount = ethers.parseEther("1");
    const inputCommitment = randomCommitment();
    await pool.connect(alice).deposit(inputCommitment, { value: depositAmount });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const changeCommitment = randomCommitment();

    // Change commitment unknown before withdrawal
    expect(await pool.isCommitted(changeCommitment)).to.be.false;

    await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      withdrawAmount,
      bob.address,
      changeCommitment,
      ethers.ZeroAddress,
      0n
    );

    // Change commitment is now part of the tree
    expect(await pool.isCommitted(changeCommitment)).to.be.true;

    const changeIdx = await pool.commitmentIndex(changeCommitment);
    expect(await pool.indexToCommitment(changeIdx)).to.equal(changeCommitment);

    // Tree has grown: 1 deposit + 1 change = 2 leaves
    expect(await pool.nextIndex()).to.equal(2n);

    // New root is known
    const rootAfter = await pool.getLastRoot();
    expect(await pool.isKnownRoot(rootAfter)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 15. batchDeposit commitments all follow the lifecycle
  // -------------------------------------------------------------------------

  it("batchDeposit commitments all follow the lifecycle", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitments = [
      randomCommitment(),
      randomCommitment(),
      randomCommitment(),
    ];
    const amounts = [
      ethers.parseEther("0.5"),
      ethers.parseEther("1"),
      ethers.parseEther("1.5"),
    ];
    const totalAmount = amounts.reduce((a, b) => a + b, 0n);

    // All unknown before batch
    for (const c of commitments) {
      expect(await pool.isCommitted(c)).to.be.false;
    }

    await pool.connect(alice).batchDeposit(commitments, amounts, {
      value: totalAmount,
    });

    // All committed after batch
    for (let i = 0; i < commitments.length; i++) {
      expect(await pool.isCommitted(commitments[i])).to.be.true;
      expect(await pool.getCommitmentIndex(commitments[i])).to.equal(BigInt(i));
      expect(await pool.indexToCommitment(i)).to.equal(commitments[i]);
    }

    // Paginated listing returns all three in order
    const page = await pool.getCommitments(0, 3);
    expect(page.length).to.equal(3);
    for (let i = 0; i < commitments.length; i++) {
      expect(page[i]).to.equal(commitments[i]);
    }

    // Tree root reflects all three insertions
    const rootAfter = await pool.getLastRoot();
    expect(await pool.isKnownRoot(rootAfter)).to.be.true;
    expect(await pool.nextIndex()).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // 16. commitment from transfer is as permanent as from deposit
  // -------------------------------------------------------------------------

  it("commitment from transfer is as permanent as from deposit", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    // Seed pool with one deposit
    const seedCommitment = randomCommitment();
    await pool.connect(alice).deposit(seedCommitment, { value: DEPOSIT_AMOUNT });

    const root = await pool.getLastRoot();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      out1,
      out2
    );

    // Add more deposits and another transfer after the outputs
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });
    await pool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_AMOUNT });

    const root2 = await pool.getLastRoot();
    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root2,
      randomCommitment(),
      randomCommitment(),
      randomCommitment()
    );

    // out1 and out2 from the first transfer remain committed and at their original indices
    expect(await pool.isCommitted(out1)).to.be.true;
    expect(await pool.isCommitted(out2)).to.be.true;

    const idx1 = await pool.commitmentIndex(out1);
    const idx2 = await pool.commitmentIndex(out2);
    expect(await pool.indexToCommitment(idx1)).to.equal(out1);
    expect(await pool.indexToCommitment(idx2)).to.equal(out2);
  });
});
