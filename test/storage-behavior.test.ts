import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const ROOT_HISTORY_SIZE = 30;

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
  const [owner, alice, bob, carol] = await ethers.getSigners();

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
    carol,
  };
}

// Helper: perform a single withdrawal via ZERO_PROOF (verifier accepts anything)
async function doWithdraw(
  pool: ConfidentialPool,
  nullifier: bigint,
  amount: bigint,
  recipientAddr: string
): Promise<void> {
  const root = await pool.getLastRoot();
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipientAddr as `0x${string}`,
    0n,          // no change commitment
    recipientAddr as `0x${string}`,
    0n           // no fee
  );
}

// ---------------------------------------------------------------------------
// Storage Behavior
// ---------------------------------------------------------------------------

describe("Storage Behavior", function () {

  // -------------------------------------------------------------------------
  // commitments mapping
  // -------------------------------------------------------------------------

  it("commitments: false before deposit, true after", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const commitment = randomCommitment();

    expect(await pool.commitments(commitment)).to.equal(false);

    await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });

    expect(await pool.commitments(commitment)).to.equal(true);
  });

  it("commitments: multiple distinct keys are independent", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    expect(await pool.commitments(c1)).to.equal(false);
    expect(await pool.commitments(c2)).to.equal(false);
    expect(await pool.commitments(c3)).to.equal(false);

    await pool.connect(alice).deposit(c1, { value: ethers.parseEther("1") });

    expect(await pool.commitments(c1)).to.equal(true);
    expect(await pool.commitments(c2)).to.equal(false);
    expect(await pool.commitments(c3)).to.equal(false);

    await pool.connect(alice).deposit(c2, { value: ethers.parseEther("1") });

    expect(await pool.commitments(c2)).to.equal(true);
    expect(await pool.commitments(c3)).to.equal(false);
  });

  it("commitments: querying a non-existent key returns false (default)", async () => {
    const { pool } = await loadFixture(deployFixture);

    const neverDeposited = BigInt("0x" + "cd".repeat(31));
    expect(await pool.commitments(neverDeposited)).to.equal(false);
    expect(await pool.commitments(1n)).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // nullifiers mapping (shared between transfer and withdraw)
  // -------------------------------------------------------------------------

  it("nullifiers: false before withdrawal, true after", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const nullifier = randomCommitment();

    expect(await pool.nullifiers(nullifier)).to.equal(false);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });

    const recipientAddr = await alice.getAddress();
    await doWithdraw(pool, nullifier, ethers.parseEther("1"), recipientAddr);

    expect(await pool.nullifiers(nullifier)).to.equal(true);
  });

  it("nullifiers: independent keys do not affect each other", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    // Deposit enough ETH for two withdrawals
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("2") });
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("2") });

    const nullifier1 = randomCommitment();
    const nullifier2 = randomCommitment();

    expect(await pool.nullifiers(nullifier1)).to.equal(false);
    expect(await pool.nullifiers(nullifier2)).to.equal(false);

    const recipientAddr = await alice.getAddress();
    await doWithdraw(pool, nullifier1, ethers.parseEther("1"), recipientAddr);

    expect(await pool.nullifiers(nullifier1)).to.equal(true);
    expect(await pool.nullifiers(nullifier2)).to.equal(false);
  });

  it("nullifiers: marked spent via transfer as well as withdraw", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });

    const transferNullifier = randomCommitment();

    expect(await pool.nullifiers(transferNullifier)).to.equal(false);

    const root = await pool.getLastRoot();
    const outC1 = randomCommitment();
    const outC2 = randomCommitment();

    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      transferNullifier,
      outC1,
      outC2
    );

    expect(await pool.nullifiers(transferNullifier)).to.equal(true);
  });

  // -------------------------------------------------------------------------
  // allowlisted mapping
  // -------------------------------------------------------------------------

  it("allowlisted: false by default for any address", async () => {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    expect(await pool.allowlisted(await alice.getAddress())).to.equal(false);
    expect(await pool.allowlisted(await bob.getAddress())).to.equal(false);
  });

  it("allowlisted: true after setAllowlisted, independent per address", async () => {
    const { pool, owner, alice, bob } = await loadFixture(deployFixture);

    await pool.connect(owner).setAllowlisted(await alice.getAddress(), true);

    expect(await pool.allowlisted(await alice.getAddress())).to.equal(true);
    expect(await pool.allowlisted(await bob.getAddress())).to.equal(false);
  });

  it("allowlisted: can be revoked back to false", async () => {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    await pool.connect(owner).setAllowlisted(await alice.getAddress(), true);
    expect(await pool.allowlisted(await alice.getAddress())).to.equal(true);

    await pool.connect(owner).setAllowlisted(await alice.getAddress(), false);
    expect(await pool.allowlisted(await alice.getAddress())).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // allowedDenominations mapping
  // -------------------------------------------------------------------------

  it("allowedDenominations: false by default for any value", async () => {
    const { pool } = await loadFixture(deployFixture);

    expect(await pool.allowedDenominations(ethers.parseEther("1"))).to.equal(false);
    expect(await pool.allowedDenominations(ethers.parseEther("0.1"))).to.equal(false);
  });

  it("allowedDenominations: true after addDenomination, false after removeDenomination", async () => {
    const { pool, owner } = await loadFixture(deployFixture);

    const denomination = ethers.parseEther("1");

    // Queue and execute addDenomination via timelock
    const addHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["addDenomination", denomination]
      )
    );
    await pool.connect(owner).queueAction(addHash);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);

    await pool.connect(owner).addDenomination(denomination);

    expect(await pool.allowedDenominations(denomination)).to.equal(true);

    // Remove it
    const removeHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["removeDenomination", denomination]
      )
    );
    await pool.connect(owner).queueAction(removeHash);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);

    await pool.connect(owner).removeDenomination(denomination);

    expect(await pool.allowedDenominations(denomination)).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // operationsPerBlock mapping
  // -------------------------------------------------------------------------

  it("operationsPerBlock: 0 for blocks with no operations", async () => {
    const { pool } = await loadFixture(deployFixture);

    const currentBlock = await ethers.provider.getBlockNumber();
    expect(await pool.operationsPerBlock(currentBlock)).to.equal(0n);
    expect(await pool.operationsPerBlock(currentBlock + 100)).to.equal(0n);
  });

  it("operationsPerBlock: increments per operation in the same block", async () => {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    await pool.connect(owner).setMaxOperationsPerBlock(100n);

    // Deposit bumps the counter for the current block
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const blockAfterFirst = await ethers.provider.getBlockNumber();
    expect(await pool.operationsPerBlock(blockAfterFirst)).to.equal(1n);
  });

  it("operationsPerBlock: resets to 0 in a new block", async () => {
    const { pool, owner, alice } = await loadFixture(deployFixture);

    await pool.connect(owner).setMaxOperationsPerBlock(100n);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const depositBlock = await ethers.provider.getBlockNumber();

    await mine(1);

    const nextBlock = await ethers.provider.getBlockNumber();
    expect(nextBlock).to.be.greaterThan(depositBlock);
    expect(await pool.operationsPerBlock(nextBlock)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // lastDepositTime mapping
  // -------------------------------------------------------------------------

  it("lastDepositTime: 0 initially for any address", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    expect(await pool.lastDepositTime(await alice.getAddress())).to.equal(0n);
  });

  it("lastDepositTime: updated after deposit and independent per address", async () => {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const aliceTime = await pool.lastDepositTime(aliceAddr);
    expect(aliceTime).to.be.greaterThan(0n);

    // Bob has not deposited — still 0
    expect(await pool.lastDepositTime(bobAddr)).to.equal(0n);

    await pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const bobTime = await pool.lastDepositTime(bobAddr);
    expect(bobTime).to.be.greaterThan(0n);

    // Alice's timestamp is unaffected by Bob's deposit
    expect(await pool.lastDepositTime(aliceAddr)).to.equal(aliceTime);
  });

  // -------------------------------------------------------------------------
  // withdrawalRecords array growth
  // -------------------------------------------------------------------------

  it("withdrawalRecords: empty before any withdrawal", async () => {
    const { pool } = await loadFixture(deployFixture);

    expect(await pool.getWithdrawalRecordCount()).to.equal(0n);
  });

  it("withdrawalRecords: grows by one per withdrawal", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const recipientAddr = await alice.getAddress();

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    await doWithdraw(pool, randomCommitment(), ethers.parseEther("1"), recipientAddr);
    expect(await pool.getWithdrawalRecordCount()).to.equal(1n);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    await doWithdraw(pool, randomCommitment(), ethers.parseEther("1"), recipientAddr);
    expect(await pool.getWithdrawalRecordCount()).to.equal(2n);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    await doWithdraw(pool, randomCommitment(), ethers.parseEther("1"), recipientAddr);
    expect(await pool.getWithdrawalRecordCount()).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // denominationList array
  // -------------------------------------------------------------------------

  it("denominationList: empty before any denomination is added", async () => {
    const { pool } = await loadFixture(deployFixture);

    const list = await pool.getDenominations();
    expect(list.length).to.equal(0);
  });

  it("denominationList: grows when denominations are added", async () => {
    const { pool, owner } = await loadFixture(deployFixture);

    const d1 = ethers.parseEther("0.1");
    const d2 = ethers.parseEther("1");

    const hash1 = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["addDenomination", d1]
      )
    );
    await pool.connect(owner).queueAction(hash1);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await pool.connect(owner).addDenomination(d1);

    let list = await pool.getDenominations();
    expect(list.length).to.equal(1);
    expect(list[0]).to.equal(d1);

    const hash2 = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["addDenomination", d2]
      )
    );
    await pool.connect(owner).queueAction(hash2);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await pool.connect(owner).addDenomination(d2);

    list = await pool.getDenominations();
    expect(list.length).to.equal(2);
    expect(list[1]).to.equal(d2);
  });

  it("denominationList: removal sets allowedDenominations to false but list length stays", async () => {
    const { pool, owner } = await loadFixture(deployFixture);

    const denomination = ethers.parseEther("1");

    const addHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["addDenomination", denomination]
      )
    );
    await pool.connect(owner).queueAction(addHash);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await pool.connect(owner).addDenomination(denomination);

    // List has 1 entry and allowedDenominations is true
    expect((await pool.getDenominations()).length).to.equal(1);
    expect(await pool.allowedDenominations(denomination)).to.equal(true);

    const removeHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["removeDenomination", denomination]
      )
    );
    await pool.connect(owner).queueAction(removeHash);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await pool.connect(owner).removeDenomination(denomination);

    // denominationList is append-only — length stays at 1
    expect((await pool.getDenominations()).length).to.equal(1);
    // But the allowedDenominations flag is now false
    expect(await pool.allowedDenominations(denomination)).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // roots array (ring buffer)
  // -------------------------------------------------------------------------

  it("roots[0] is the initial empty tree root (non-zero)", async () => {
    const { pool } = await loadFixture(deployFixture);

    const root0 = await pool.roots(0);
    expect(root0).to.be.greaterThan(0n);
  });

  it("roots[currentRootIndex] equals getLastRoot()", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    let idx = await pool.currentRootIndex();
    expect(await pool.roots(idx)).to.equal(await pool.getLastRoot());

    for (let i = 0; i < 5; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      idx = await pool.currentRootIndex();
      expect(await pool.roots(idx)).to.equal(
        await pool.getLastRoot(),
        `Mismatch after deposit ${i + 1}`
      );
    }
  });

  it("roots ring buffer wraps at ROOT_HISTORY_SIZE", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const firstDepositRoot = await pool.roots(1);

    for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    }

    const rootAtSlot1After = await pool.roots(1);
    expect(rootAtSlot1After).to.not.equal(firstDepositRoot);

    expect(await pool.isKnownRoot(firstDepositRoot)).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // filledSubtrees array
  // -------------------------------------------------------------------------

  it("filledSubtrees has exactly `levels` entries", async () => {
    const { pool } = await loadFixture(deployFixture);

    const levels = await pool.levels();

    for (let i = 0; i < Number(levels); i++) {
      await pool.filledSubtrees(i);
    }

    await expect(pool.filledSubtrees(levels)).to.be.reverted;
  });

  it("filledSubtrees[0] updates on left-child deposits", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const initialVal = await pool.filledSubtrees(0);

    // First deposit: index 0 is a left child → filledSubtrees[0] updated
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const afterFirst = await pool.filledSubtrees(0);
    expect(afterFirst).to.not.equal(initialVal);

    // Second deposit: index 1 is a right child → filledSubtrees[0] unchanged
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const afterSecond = await pool.filledSubtrees(0);
    expect(afterSecond).to.equal(afterFirst);

    // Third deposit: index 2 is a left child → filledSubtrees[0] updated again
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const afterThird = await pool.filledSubtrees(0);
    expect(afterThird).to.not.equal(afterSecond);
  });

  // -------------------------------------------------------------------------
  // commitmentIndex + indexToCommitment
  // -------------------------------------------------------------------------

  it("commitmentIndex and indexToCommitment are inverse mappings", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await pool.connect(alice).deposit(c0, { value: ethers.parseEther("1") });
    await pool.connect(alice).deposit(c1, { value: ethers.parseEther("1") });
    await pool.connect(alice).deposit(c2, { value: ethers.parseEther("1") });

    expect(await pool.commitmentIndex(c0)).to.equal(0n);
    expect(await pool.commitmentIndex(c1)).to.equal(1n);
    expect(await pool.commitmentIndex(c2)).to.equal(2n);

    expect(await pool.indexToCommitment(0)).to.equal(c0);
    expect(await pool.indexToCommitment(1)).to.equal(c1);
    expect(await pool.indexToCommitment(2)).to.equal(c2);
  });

  it("commitmentIndex and indexToCommitment return 0 for unknown keys", async () => {
    const { pool } = await loadFixture(deployFixture);

    const unknownCommitment = randomCommitment();

    expect(await pool.commitmentIndex(unknownCommitment)).to.equal(0n);
    expect(await pool.indexToCommitment(9999)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // depositsPerAddress mapping
  // -------------------------------------------------------------------------

  it("depositsPerAddress: 0 initially for any address", async () => {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    expect(await pool.depositsPerAddress(await alice.getAddress())).to.equal(0n);
    expect(await pool.depositsPerAddress(await bob.getAddress())).to.equal(0n);
  });

  it("depositsPerAddress: increments once per deposit", async () => {
    const { pool, alice } = await loadFixture(deployFixture);

    const aliceAddr = await alice.getAddress();

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    expect(await pool.depositsPerAddress(aliceAddr)).to.equal(1n);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    expect(await pool.depositsPerAddress(aliceAddr)).to.equal(2n);
  });

  it("depositsPerAddress: independent per address", async () => {
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });

    await pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") });

    expect(await pool.depositsPerAddress(await alice.getAddress())).to.equal(2n);
    expect(await pool.depositsPerAddress(await bob.getAddress())).to.equal(1n);
  });
});
