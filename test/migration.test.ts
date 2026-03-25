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

const DEPOSIT_VALUE = ethers.parseEther("1");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

function randomKey(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture — deploys two independent ConfidentialPool instances plus shared
// peripheral contracts (StealthRegistry, PoolLens).
// ---------------------------------------------------------------------------

async function deployTwoPoolsFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");

  const oldPool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  );

  const newPool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  );

  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();

  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = await Lens.deploy();

  return { oldPool, newPool, registry, lens, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Contract Migration", function () {
  // -------------------------------------------------------------------------
  // Fresh state
  // -------------------------------------------------------------------------

  it("new deployment has fresh state (all counters zero)", async function () {
    const { newPool } = await loadFixture(deployTwoPoolsFixture);

    expect(await newPool.nextIndex()).to.equal(0n);
    expect(await newPool.totalDeposited()).to.equal(0n);
    expect(await newPool.totalWithdrawn()).to.equal(0n);
    expect(await newPool.totalTransfers()).to.equal(0n);
    expect(await newPool.withdrawalCount()).to.equal(0n);
    expect(await newPool.uniqueDepositorCount()).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Deployment independence
  // -------------------------------------------------------------------------

  it("old and new deployments are independent (different addresses)", async function () {
    const { oldPool, newPool } = await loadFixture(deployTwoPoolsFixture);

    const oldAddr = await oldPool.getAddress();
    const newAddr = await newPool.getAddress();

    expect(oldAddr).to.not.equal(newAddr);
  });

  it("depositing in old pool does not affect new pool's UTXO set", async function () {
    const { oldPool, newPool, alice } = await loadFixture(deployTwoPoolsFixture);

    const commitment = randomCommitment();
    await oldPool.connect(alice).deposit(commitment, { value: DEPOSIT_VALUE });

    expect(await oldPool.nextIndex()).to.equal(1n);
    expect(await oldPool.commitments(commitment)).to.be.true;
    expect(await oldPool.totalDeposited()).to.equal(DEPOSIT_VALUE);

    // New pool is completely unaffected
    expect(await newPool.nextIndex()).to.equal(0n);
    expect(await newPool.commitments(commitment)).to.be.false;
    expect(await newPool.totalDeposited()).to.equal(0n);
  });

  it("nullifier spent in old pool is not spent in new pool", async function () {
    const { oldPool, newPool, alice, bob } = await loadFixture(
      deployTwoPoolsFixture
    );

    // Deposit in old pool
    const commitment = randomCommitment();
    await oldPool.connect(alice).deposit(commitment, { value: DEPOSIT_VALUE });

    const root = await oldPool.getLastRoot();
    const nullifier = randomCommitment();
    const amount = DEPOSIT_VALUE;
    const changeCommitment = 0n;

    // Withdraw from old pool (dummy verifier accepts any proof)
    await oldPool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      amount,
      bob.address,
      changeCommitment,
      ethers.ZeroAddress,
      0n
    );

    expect(await oldPool.nullifiers(nullifier)).to.be.true;
    expect(await newPool.nullifiers(nullifier)).to.be.false;
  });

  it("old pool can be paused while new pool operates normally", async function () {
    const { oldPool, newPool, owner, alice } = await loadFixture(
      deployTwoPoolsFixture
    );

    await oldPool.connect(owner).pause();
    expect(await oldPool.paused()).to.be.true;
    expect(await newPool.paused()).to.be.false;

    // Deposit on old pool reverts
    await expect(
      oldPool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_VALUE })
    ).to.be.reverted;

    // Deposit on new pool succeeds
    await expect(
      newPool.connect(alice).deposit(randomCommitment(), { value: DEPOSIT_VALUE })
    ).to.emit(newPool, "Deposit");
  });

  it("old pool viewing keys in StealthRegistry are not in new pool's UTXO set", async function () {
    const { oldPool, newPool, registry, alice } = await loadFixture(
      deployTwoPoolsFixture
    );

    // Alice registers her viewing key in the shared registry
    const pubKeyX = randomKey();
    const pubKeyY = randomKey();
    await registry.connect(alice).registerViewingKey(pubKeyX, pubKeyY);

    // Deposit in old pool using a commitment derived from alice's viewing key
    const commitment = randomCommitment();
    await oldPool.connect(alice).deposit(commitment, { value: DEPOSIT_VALUE });

    // The commitment exists in the old pool
    expect(await oldPool.commitments(commitment)).to.be.true;

    // The same commitment does not exist in the new pool
    expect(await newPool.commitments(commitment)).to.be.false;

    // The registry is independent from both pools — alice's key is still registered
    const [storedX, storedY] = await registry.getViewingKey(alice.address);
    expect(storedX).to.equal(pubKeyX);
    expect(storedY).to.equal(pubKeyY);
  });

  it("StealthRegistry is independent from both pools", async function () {
    const { oldPool, newPool, registry, owner, alice } = await loadFixture(
      deployTwoPoolsFixture
    );

    const pubKeyX = randomKey();
    const pubKeyY = randomKey();
    await registry.connect(alice).registerViewingKey(pubKeyX, pubKeyY);

    // Pause both pools — the registry should still accept registrations
    await oldPool.connect(owner).pause();
    await newPool.connect(owner).pause();

    expect(await oldPool.paused()).to.be.true;
    expect(await newPool.paused()).to.be.true;

    // Registry still accepts new registrations regardless of pool state
    const x2 = randomKey();
    const y2 = randomKey();
    await expect(registry.connect(alice).registerViewingKey(x2, y2)).to.emit(
      registry,
      "ViewingKeyRegistered"
    );
  });

  it("PoolLens works independently with old and new pool", async function () {
    const { oldPool, newPool, lens, alice } = await loadFixture(
      deployTwoPoolsFixture
    );

    // Deposit only in old pool
    await oldPool
      .connect(alice)
      .deposit(randomCommitment(), { value: DEPOSIT_VALUE });

    const oldSnapshot = await lens.getSnapshot(await oldPool.getAddress());
    const newSnapshot = await lens.getSnapshot(await newPool.getAddress());

    expect(oldSnapshot.depositCount).to.equal(1n);
    expect(oldSnapshot.totalDeposited).to.equal(DEPOSIT_VALUE);

    expect(newSnapshot.depositCount).to.equal(0n);
    expect(newSnapshot.totalDeposited).to.equal(0n);
  });

  it("tree roots are independent between deployments", async function () {
    const { oldPool, newPool, alice } = await loadFixture(deployTwoPoolsFixture);

    const initialOldRoot = await oldPool.getLastRoot();
    const initialNewRoot = await newPool.getLastRoot();
    expect(initialOldRoot).to.equal(initialNewRoot);

    await oldPool
      .connect(alice)
      .deposit(randomCommitment(), { value: DEPOSIT_VALUE });

    const postDepositOldRoot = await oldPool.getLastRoot();
    const postDepositNewRoot = await newPool.getLastRoot();

    expect(postDepositOldRoot).to.not.equal(initialOldRoot);
    expect(postDepositNewRoot).to.equal(initialNewRoot);

    // The old pool's new root is not accepted by the new pool
    expect(await newPool.isKnownRoot(postDepositOldRoot)).to.be.false;
  });

  it("transfer in old pool does not affect new pool's UTXO set", async function () {
    const { oldPool, newPool, alice } = await loadFixture(deployTwoPoolsFixture);

    // Deposit in old pool to get a valid root
    const inputCommitment = randomCommitment();
    await oldPool
      .connect(alice)
      .deposit(inputCommitment, { value: DEPOSIT_VALUE });

    const root = await oldPool.getLastRoot();
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    await oldPool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      out1,
      out2
    );

    // Old pool has the output commitments
    expect(await oldPool.commitments(out1)).to.be.true;
    expect(await oldPool.commitments(out2)).to.be.true;
    expect(await oldPool.totalTransfers()).to.equal(1n);

    // New pool has none of them
    expect(await newPool.commitments(out1)).to.be.false;
    expect(await newPool.commitments(out2)).to.be.false;
    expect(await newPool.totalTransfers()).to.equal(0n);
  });

  it("emergency drain old pool then deposit in new pool", async function () {
    const { oldPool, newPool, owner, alice, bob } = await loadFixture(
      deployTwoPoolsFixture
    );

    // Fund old pool
    await oldPool
      .connect(alice)
      .deposit(randomCommitment(), { value: DEPOSIT_VALUE });

    expect(await ethers.provider.getBalance(await oldPool.getAddress())).to.equal(
      DEPOSIT_VALUE
    );

    // Pause and drain old pool
    await oldPool.connect(owner).pause();
    const balanceBefore = await ethers.provider.getBalance(bob.address);

    await expect(
      oldPool.connect(owner).emergencyDrain(bob.address)
    ).to.emit(oldPool, "EmergencyDrain");

    expect(await ethers.provider.getBalance(await oldPool.getAddress())).to.equal(
      0n
    );

    // New pool is not paused and accepts deposits normally
    expect(await newPool.paused()).to.be.false;
    const newCommitment = randomCommitment();
    await expect(
      newPool.connect(alice).deposit(newCommitment, { value: DEPOSIT_VALUE })
    )
      .to.emit(newPool, "Deposit")
      .withArgs(
        newCommitment,
        0,
        DEPOSIT_VALUE,
        await ethers.provider.getBlock("latest").then((b) => b!.timestamp + 1)
      );
  });
});
