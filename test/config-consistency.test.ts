import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, PoolLens, StealthRegistry } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const EXPECTED_TIMELOCK_DELAY = 86400n; // 1 day in seconds
const EXPECTED_ROOT_HISTORY_SIZE = 30n;
const DEFAULT_DEPOSIT = ethers.parseEther("1");

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

  const StealthRegistryFactory = await ethers.getContractFactory("StealthRegistry");
  const registry = (await StealthRegistryFactory.deploy()) as unknown as StealthRegistry;

  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = (await Lens.deploy()) as unknown as PoolLens;

  return {
    pool,
    registry,
    lens,
    hasherAddress,
    transferVerifierAddress,
    withdrawVerifierAddress,
    owner,
    alice,
    bob,
  };
}

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Configuration Consistency Tests
// ---------------------------------------------------------------------------

describe("Configuration Consistency", function () {
  it("VERSION matches between ConfidentialPool, StealthRegistry, and PoolLens snapshot", async function () {
    const { pool, registry, lens } = await loadFixture(deployFixture);

    const poolVersion = await pool.VERSION();
    const registryVersion = await registry.VERSION();
    const snapshot = await lens.getSnapshot(await pool.getAddress());

    expect(poolVersion).to.equal("1.0.0");
    expect(registryVersion).to.equal("1.0.0");
    expect(snapshot.version).to.equal(poolVersion);
  });

  it("transferVerifier address is immutable", async function () {
    const { pool, alice, transferVerifierAddress } = await loadFixture(deployFixture);

    const verifierBefore = await pool.transferVerifier();
    expect(verifierBefore).to.equal(transferVerifierAddress);

    for (let i = 0; i < 3; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEFAULT_DEPOSIT });
    }

    const verifierAfter = await pool.transferVerifier();
    expect(verifierAfter).to.equal(verifierBefore);
  });

  it("withdrawVerifier address is immutable", async function () {
    const { pool, alice, withdrawVerifierAddress } = await loadFixture(deployFixture);

    const verifierBefore = await pool.withdrawVerifier();
    expect(verifierBefore).to.equal(withdrawVerifierAddress);

    for (let i = 0; i < 3; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEFAULT_DEPOSIT });
    }

    const verifierAfter = await pool.withdrawVerifier();
    expect(verifierAfter).to.equal(verifierBefore);
  });

  it("hasher address is immutable", async function () {
    const { pool, alice, hasherAddress } = await loadFixture(deployFixture);

    const hasherBefore = await pool.hasher();
    expect(hasherBefore).to.equal(hasherAddress);

    for (let i = 0; i < 3; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEFAULT_DEPOSIT });
    }

    const hasherAfter = await pool.hasher();
    expect(hasherAfter).to.equal(hasherBefore);
  });

  it("levels is immutable (same after deposits)", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const levelsBefore = await pool.levels();

    for (let i = 0; i < 3; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEFAULT_DEPOSIT });
    }

    const levelsAfter = await pool.levels();
    expect(levelsAfter).to.equal(levelsBefore);
    expect(levelsAfter).to.equal(MERKLE_TREE_HEIGHT);
  });

  it("deployedChainId is immutable", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const { chainId } = await ethers.provider.getNetwork();
    const chainIdBefore = await pool.deployedChainId();
    expect(chainIdBefore).to.equal(chainId);

    for (let i = 0; i < 3; i++) {
      await pool.connect(alice).deposit(randomCommitment(), { value: DEFAULT_DEPOSIT });
    }

    const chainIdAfter = await pool.deployedChainId();
    expect(chainIdAfter).to.equal(chainIdBefore);
  });

  it("TIMELOCK_DELAY is exactly 1 day (86400 seconds)", async function () {
    const { pool } = await loadFixture(deployFixture);

    const timelockDelay = await pool.TIMELOCK_DELAY();
    expect(timelockDelay).to.equal(EXPECTED_TIMELOCK_DELAY);
  });

  it("TIMELOCK_DELAY matches across ConfidentialPool constants", async function () {
    const { pool } = await loadFixture(deployFixture);

    // Both constants are defined on ConfidentialPool — verify internal consistency
    const timelockDelay = await pool.TIMELOCK_DELAY();
    // 1 day == 24 * 60 * 60
    expect(timelockDelay).to.equal(24n * 60n * 60n);
    expect(timelockDelay).to.equal(EXPECTED_TIMELOCK_DELAY);
  });

  it("ROOT_HISTORY_SIZE is exactly 30", async function () {
    const { pool } = await loadFixture(deployFixture);

    const rootHistorySize = await pool.ROOT_HISTORY_SIZE();
    expect(rootHistorySize).to.equal(EXPECTED_ROOT_HISTORY_SIZE);
  });

  it("default config: all admin values start at 0/false", async function () {
    const { pool } = await loadFixture(deployFixture);

    expect(await pool.maxWithdrawAmount()).to.equal(0n);
    expect(await pool.minDepositAge()).to.equal(0n);
    expect(await pool.maxDepositsPerAddress()).to.equal(0n);
    expect(await pool.depositCooldown()).to.equal(0n);
    expect(await pool.maxOperationsPerBlock()).to.equal(0n);
    expect(await pool.allowlistEnabled()).to.equal(false);
    expect(await pool.paused()).to.equal(false);
  });

  it("config survives pause/unpause cycle unchanged", async function () {
    const { pool, owner } = await loadFixture(deployFixture);

    // Capture config before pause
    const transferVerifierBefore = await pool.transferVerifier();
    const withdrawVerifierBefore = await pool.withdrawVerifier();
    const levelsBefore = await pool.levels();
    const chainIdBefore = await pool.deployedChainId();
    const rootHistorySizeBefore = await pool.ROOT_HISTORY_SIZE();
    const timelockDelayBefore = await pool.TIMELOCK_DELAY();
    const versionBefore = await pool.VERSION();

    // Pause and unpause
    await pool.connect(owner).pause();
    expect(await pool.paused()).to.equal(true);
    await pool.connect(owner).unpause();
    expect(await pool.paused()).to.equal(false);

    // All immutables and constants must be identical after the cycle
    expect(await pool.transferVerifier()).to.equal(transferVerifierBefore);
    expect(await pool.withdrawVerifier()).to.equal(withdrawVerifierBefore);
    expect(await pool.levels()).to.equal(levelsBefore);
    expect(await pool.deployedChainId()).to.equal(chainIdBefore);
    expect(await pool.ROOT_HISTORY_SIZE()).to.equal(rootHistorySizeBefore);
    expect(await pool.TIMELOCK_DELAY()).to.equal(timelockDelayBefore);
    expect(await pool.VERSION()).to.equal(versionBefore);
  });
});
