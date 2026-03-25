import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type {
  ConfidentialPool,
  DepositReceipt,
  PoolLens,
  StealthRegistry,
} from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");
const ONE_DAY = 24 * 60 * 60;
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function timelockAddDenomination(
  pool: ConfidentialPool,
  owner: Signer,
  denomination: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["addDenomination", denomination]
    )
  );
  await pool.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await pool.connect(owner).addDenomination(denomination);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function baseFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifierFactory = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifierFactory.deploy();
  await transferVerifier.waitForDeployment();
  const transferVerifierAddress = await transferVerifier.getAddress();

  const WithdrawVerifierFactory = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifierFactory.deploy();
  await withdrawVerifier.waitForDeployment();
  const withdrawVerifierAddress = await withdrawVerifier.getAddress();

  const StealthRegistryFactory = await ethers.getContractFactory("StealthRegistry");
  const stealthRegistry = (await StealthRegistryFactory.deploy()) as unknown as StealthRegistry;
  await stealthRegistry.waitForDeployment();

  const PoolFactory = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await PoolFactory.deploy(
    transferVerifierAddress,
    withdrawVerifierAddress,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;
  await pool.waitForDeployment();

  const PoolLensFactory = await ethers.getContractFactory("PoolLens");
  const poolLens = (await PoolLensFactory.deploy()) as unknown as PoolLens;
  await poolLens.waitForDeployment();

  return {
    owner,
    alice,
    bob,
    relayer,
    hasherAddress,
    transferVerifierAddress,
    withdrawVerifierAddress,
    transferVerifier,
    withdrawVerifier,
    stealthRegistry,
    pool,
    poolLens,
  };
}

async function fixtureWithDenomination() {
  const base = await baseFixture();
  const { pool, owner } = base;
  await timelockAddDenomination(pool, owner, DENOMINATION);
  return base;
}

async function fixtureWithReceipt() {
  const base = await fixtureWithDenomination();
  const { pool, owner } = base;

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await pool.getAddress()
  )) as unknown as DepositReceipt;
  await receipt.waitForDeployment();

  // setDepositReceipt has no timelock in ConfidentialPool
  await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Cross-Contract Interactions
// ---------------------------------------------------------------------------

describe("Cross-Contract Interactions", function () {
  // -------------------------------------------------------------------------
  // Pool <-> Hasher
  // -------------------------------------------------------------------------

  it("Pool.verifyHash delegates to hasher contract", async function () {
    const { pool, hasherAddress } = await loadFixture(baseFixture);

    // Use explicit uint256[2] overload to avoid ambiguity with bytes32[2] overload
    const uint256ArrAbi = ["function poseidon(uint256[2] inputs) external pure returns (uint256)"];
    const hasherContract = new ethers.Contract(hasherAddress, uint256ArrAbi, await ethers.provider.getSigner());

    const a = 123n;
    const b = 456n;

    const poolHash = await pool.verifyHash(a, b);
    const directHash = await hasherContract.poseidon([a, b]);

    expect(poolHash).to.equal(directHash);
  });

  it("Pool.verifyHash produces a valid BN254 field element", async function () {
    const { pool } = await loadFixture(baseFixture);

    const hash = await pool.verifyHash(1n, 2n);
    expect(hash).to.be.gt(0n);
    expect(hash).to.be.lt(FIELD_SIZE);
  });

  it("hasher address is immutable in Pool", async function () {
    const { pool, hasherAddress, alice } = await loadFixture(fixtureWithDenomination);

    expect(await pool.hasher()).to.equal(hasherAddress);

    await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await pool.hasher()).to.equal(hasherAddress);
  });

  // -------------------------------------------------------------------------
  // Pool <-> TransferVerifier
  // -------------------------------------------------------------------------

  it("Pool.transfer calls transferVerifier.verifyProof — accepted on Hardhat network", async function () {
    const { pool, alice } = await loadFixture(fixtureWithDenomination);

    const inputCommitment = randomCommitment();
    await pool.connect(alice).deposit(inputCommitment, { value: DENOMINATION });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    await expect(
      pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      )
    ).to.not.be.reverted;

    // Nullifier must be spent after transfer
    expect(await pool.isSpent(nullifier)).to.be.true;
    // Both output commitments inserted
    expect(await pool.isCommitted(out1)).to.be.true;
    expect(await pool.isCommitted(out2)).to.be.true;
  });

  it("transferVerifier address is immutable in Pool", async function () {
    const { pool, transferVerifierAddress, alice } = await loadFixture(fixtureWithDenomination);

    expect(await pool.transferVerifier()).to.equal(transferVerifierAddress);

    await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await pool.transferVerifier()).to.equal(transferVerifierAddress);
  });

  it("placeholder TransferVerifier only works on chainId 31337", async function () {
    const { transferVerifier } = await loadFixture(baseFixture);

    const network = await ethers.provider.getNetwork();
    expect(network.chainId).to.equal(31337n);

    const result = await transferVerifier.verifyProof(
      [0n, 0n],
      [[0n, 0n], [0n, 0n]],
      [0n, 0n],
      [0n, 0n, 0n, 0n]
    );
    expect(result).to.be.true;
  });

  // -------------------------------------------------------------------------
  // Pool <-> WithdrawVerifier
  // -------------------------------------------------------------------------

  it("Pool.withdraw calls withdrawVerifier.verifyProof — accepted on Hardhat network", async function () {
    const { pool, alice, bob } = await loadFixture(fixtureWithDenomination);

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: DENOMINATION });

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const withdrawAmount = DENOMINATION;

    await expect(
      pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        withdrawAmount,
        bob.address as `0x${string}`,
        0n,
        ethers.ZeroAddress as `0x${string}`,
        0n
      )
    ).to.not.be.reverted;

    expect(await pool.isSpent(nullifier)).to.be.true;
  });

  it("withdrawVerifier address is immutable in Pool", async function () {
    const { pool, withdrawVerifierAddress, alice } = await loadFixture(fixtureWithDenomination);

    expect(await pool.withdrawVerifier()).to.equal(withdrawVerifierAddress);

    await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await pool.withdrawVerifier()).to.equal(withdrawVerifierAddress);
  });

  it("placeholder WithdrawVerifier only works on chainId 31337", async function () {
    const { withdrawVerifier } = await loadFixture(baseFixture);

    const network = await ethers.provider.getNetwork();
    expect(network.chainId).to.equal(31337n);

    const result = await withdrawVerifier.verifyProof(
      [0n, 0n],
      [[0n, 0n], [0n, 0n]],
      [0n, 0n],
      [0n, 0n, 0n, 0n, 0n]
    );
    expect(result).to.be.true;
  });

  // -------------------------------------------------------------------------
  // Pool <-> StealthRegistry — independence (no direct calls between them)
  // -------------------------------------------------------------------------

  it("StealthRegistry and Pool are independent — Pool state does not affect StealthRegistry", async function () {
    const { pool, stealthRegistry, alice } = await loadFixture(fixtureWithDenomination);

    // Register a viewing key in StealthRegistry
    const pubKeyX = 12345n;
    const pubKeyY = 67890n;
    await stealthRegistry.connect(alice).registerViewingKey(pubKeyX, pubKeyY);

    // Perform a deposit in Pool — StealthRegistry should be unaffected
    await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    // Viewing key unchanged
    const vk = await stealthRegistry.viewingKeys(alice.address);
    expect(vk.pubKeyX).to.equal(pubKeyX);
    expect(vk.pubKeyY).to.equal(pubKeyY);
  });

  it("StealthRegistry and Pool are independent — StealthRegistry state does not affect Pool", async function () {
    const { pool, stealthRegistry, alice } = await loadFixture(fixtureWithDenomination);

    // Register many viewing keys — Pool deposit should still work
    await stealthRegistry.connect(alice).registerViewingKey(1n, 2n);

    const commitment = randomCommitment();
    await expect(
      pool.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.not.be.reverted;

    expect(await pool.isCommitted(commitment)).to.be.true;
  });

  it("StealthRegistry does not hold any ETH — Pool balance unaffected by registry calls", async function () {
    const { pool, stealthRegistry, alice } = await loadFixture(fixtureWithDenomination);

    await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const poolBalance = await ethers.provider.getBalance(await pool.getAddress());

    // Registering a key in StealthRegistry costs no ETH to the pool
    await stealthRegistry.connect(alice).registerViewingKey(1n, 1n);

    expect(await ethers.provider.getBalance(await pool.getAddress())).to.equal(poolBalance);
    expect(await ethers.provider.getBalance(await stealthRegistry.getAddress())).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Pool <-> PoolLens — read-only verification
  // -------------------------------------------------------------------------

  it("PoolLens reads from Pool without modifying state", async function () {
    const { pool, poolLens, alice } = await loadFixture(fixtureWithDenomination);
    const poolAddress = await pool.getAddress();

    const rootBefore = await pool.getLastRoot();
    const countBefore = await pool.getDepositCount();

    await poolLens.getSnapshot(poolAddress);

    expect(await pool.getLastRoot()).to.equal(rootBefore);
    expect(await pool.getDepositCount()).to.equal(countBefore);
  });

  it("PoolLens snapshot matches Pool individual getters", async function () {
    const { pool, poolLens, alice, owner } = await loadFixture(fixtureWithReceipt);
    const poolAddress = await pool.getAddress();

    // Make a deposit so stats are non-trivial
    await pool.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    const snapshot = await poolLens.getSnapshot(poolAddress);

    const [td, tw, tt, dc, wc, ud, pb] = await pool.getPoolStats();
    expect(snapshot.totalDeposited).to.equal(td);
    expect(snapshot.totalWithdrawn).to.equal(tw);
    expect(snapshot.totalTransfers).to.equal(tt);
    expect(snapshot.depositCount).to.equal(dc);
    expect(snapshot.withdrawalCount).to.equal(wc);
    expect(snapshot.uniqueDepositors).to.equal(ud);
    expect(snapshot.poolBalance).to.equal(pb);
    expect(snapshot.isPaused).to.equal(await pool.paused());
    expect(snapshot.owner).to.equal(await pool.owner());
    expect(snapshot.lastRoot).to.equal(await pool.getLastRoot());
    expect(snapshot.treeCapacity).to.equal(await pool.getTreeCapacity());
  });

  it("PoolLens works with any Pool address (re-deployed instance)", async function () {
    const { poolLens, hasherAddress, transferVerifierAddress, withdrawVerifierAddress } =
      await loadFixture(baseFixture);

    const PoolFactory = await ethers.getContractFactory("ConfidentialPool");
    const pool2 = (await PoolFactory.deploy(
      transferVerifierAddress,
      withdrawVerifierAddress,
      MERKLE_TREE_HEIGHT,
      hasherAddress
    )) as unknown as ConfidentialPool;
    await pool2.waitForDeployment();

    const snapshot = await poolLens.getSnapshot(await pool2.getAddress());
    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.isPaused).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // Pool <-> DepositReceipt — mint on deposit AND batchDeposit
  // -------------------------------------------------------------------------

  it("Pool.deposit triggers receipt.mint when configured", async function () {
    const { pool, receipt, alice } = await loadFixture(fixtureWithReceipt);

    const commitment = randomCommitment();
    expect(await receipt.balanceOf(alice.address)).to.equal(0n);

    await pool.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
    expect(await receipt.tokenAmount(0n)).to.equal(DENOMINATION);
    expect(await receipt.ownerOf(0n)).to.equal(alice.address);
  });

  it("Pool.batchDeposit triggers receipt.mint for each deposit in the batch", async function () {
    const { pool, receipt, alice } = await loadFixture(fixtureWithReceipt);

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [DENOMINATION, DENOMINATION, DENOMINATION];
    const total = amounts.reduce((a, b) => a + b, 0n);

    await pool.connect(alice).batchDeposit(commitments, amounts, { value: total });

    expect(await receipt.balanceOf(alice.address)).to.equal(BigInt(commitments.length));

    for (let i = 0; i < commitments.length; i++) {
      expect(await receipt.tokenCommitment(BigInt(i))).to.equal(commitments[i]);
      expect(await receipt.tokenAmount(BigInt(i))).to.equal(DENOMINATION);
      expect(await receipt.ownerOf(BigInt(i))).to.equal(alice.address);
    }
  });

  it("receipt.mint reverts when called directly (not via pool)", async function () {
    const { receipt, alice } = await loadFixture(fixtureWithReceipt);

    await expect(
      receipt.connect(alice).mint(alice.address, randomCommitment(), DENOMINATION)
    ).to.be.revertedWith("DepositReceipt: only pool");
  });

  it("receipt.pool() returns ConfidentialPool address", async function () {
    const { pool, receipt } = await loadFixture(fixtureWithReceipt);
    expect(await receipt.pool()).to.equal(await pool.getAddress());
  });

  // -------------------------------------------------------------------------
  // Atomic rollback on failed batchDeposit
  // -------------------------------------------------------------------------

  it("failed batchDeposit reverts Pool state AND receipt mints atomically", async function () {
    const { pool, receipt, alice } = await loadFixture(fixtureWithReceipt);

    const countBefore = await pool.getDepositCount();
    const receiptBalanceBefore = await receipt.balanceOf(alice.address);

    const commitments = [randomCommitment(), randomCommitment()];
    const amounts = [DENOMINATION, DENOMINATION];

    // Send wrong total — should revert everything
    const wrongTotal = DENOMINATION; // only half the required amount
    await expect(
      pool.connect(alice).batchDeposit(commitments, amounts, { value: wrongTotal })
    ).to.be.revertedWith("ConfidentialPool: incorrect total amount");

    // Pool state must be completely unchanged
    expect(await pool.getDepositCount()).to.equal(countBefore);
    expect(await receipt.balanceOf(alice.address)).to.equal(receiptBalanceBefore);
    expect(await pool.isCommitted(commitments[0])).to.be.false;
    expect(await pool.isCommitted(commitments[1])).to.be.false;
  });

  it("deposit updates Pool state AND mints receipt atomically", async function () {
    const { pool, receipt, alice } = await loadFixture(fixtureWithReceipt);

    const commitment = randomCommitment();
    const countBefore = await pool.getDepositCount();
    const balanceBefore = await receipt.balanceOf(alice.address);

    const tx = await pool.connect(alice).deposit(commitment, { value: DENOMINATION });
    await tx.wait();

    // Both state updates in the same transaction
    expect(await pool.getDepositCount()).to.equal(countBefore + 1n);
    expect(await receipt.balanceOf(alice.address)).to.equal(balanceBefore + 1n);
    expect(await pool.isCommitted(commitment)).to.be.true;
    expect(await receipt.tokenCommitment(balanceBefore)).to.equal(commitment);
  });

  it("failed single deposit reverts both Pool state AND receipt mint", async function () {
    const { pool, receipt, alice } = await loadFixture(fixtureWithReceipt);

    const commitment = randomCommitment();
    const countBefore = await pool.getDepositCount();
    const receiptBalanceBefore = await receipt.balanceOf(alice.address);

    // Wrong denomination amount triggers revert
    await expect(
      pool.connect(alice).deposit(commitment, { value: ethers.parseEther("0.05") })
    ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");

    expect(await pool.getDepositCount()).to.equal(countBefore);
    expect(await receipt.balanceOf(alice.address)).to.equal(receiptBalanceBefore);
    expect(await pool.isCommitted(commitment)).to.be.false;
  });
});
