import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
// @ts-ignore
import { poseidonContract } from "circomlibjs";
import type {
  ConfidentialPool,
  PoolLens,
  DepositReceipt,
  StealthRegistry,
} from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants — match the production deploy script values
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 20;
const ONE_DAY = 24 * 60 * 60;

const DEFAULT_DENOMINATIONS = [
  ethers.parseEther("0.01"),
  ethers.parseEther("0.1"),
  ethers.parseEther("1"),
  ethers.parseEther("10"),
];

// ---------------------------------------------------------------------------
// Deploy helpers (mirror what scripts/deploy.ts does)
// ---------------------------------------------------------------------------

async function deployHasherContract() {
  const [signer] = await ethers.getSigners();
  const abi = poseidonContract.generateABI(2);
  const bytecode: string = poseidonContract.createCode(2);
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return contract;
}

async function fullDeployFixture() {
  const [deployer] = await ethers.getSigners();

  // 1. Hasher
  const hasherContract = await deployHasherContract();
  const hasherAddress = await hasherContract.getAddress();

  // 2. TransferVerifier
  const TransferVerifierFactory = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifierFactory.deploy();
  await transferVerifier.waitForDeployment();
  const transferVerifierAddress = await transferVerifier.getAddress();

  // 3. WithdrawVerifier
  const WithdrawVerifierFactory = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifierFactory.deploy();
  await withdrawVerifier.waitForDeployment();
  const withdrawVerifierAddress = await withdrawVerifier.getAddress();

  // 4. StealthRegistry (independent, no deps)
  const StealthRegistryFactory = await ethers.getContractFactory("StealthRegistry");
  const stealthRegistry = (await StealthRegistryFactory.deploy()) as unknown as StealthRegistry;
  await stealthRegistry.waitForDeployment();
  const stealthRegistryAddress = await stealthRegistry.getAddress();

  // 5. ConfidentialPool
  const PoolFactory = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await PoolFactory.deploy(
    transferVerifierAddress,
    withdrawVerifierAddress,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();

  // 6. Configure default denominations (each requires timelock)
  for (const denomination of DEFAULT_DENOMINATIONS) {
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["addDenomination", denomination]
      )
    );
    await pool.queueAction(actionHash);
    await time.increase(ONE_DAY + 1);
    await pool.addDenomination(denomination);
  }

  // 7. DepositReceipt (no timelock needed for setDepositReceipt in pool)
  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const depositReceipt = (await DepositReceiptFactory.deploy(poolAddress)) as unknown as DepositReceipt;
  await depositReceipt.waitForDeployment();
  const depositReceiptAddress = await depositReceipt.getAddress();

  // Wire DepositReceipt into pool (no timelock — confirmed in contract source)
  await pool.setDepositReceipt(depositReceiptAddress);

  // 8. PoolLens
  const PoolLensFactory = await ethers.getContractFactory("PoolLens");
  const poolLens = (await PoolLensFactory.deploy()) as unknown as PoolLens;
  await poolLens.waitForDeployment();

  const network = await ethers.provider.getNetwork();

  return {
    deployer,
    hasherContract,
    hasherAddress,
    transferVerifier,
    transferVerifierAddress,
    withdrawVerifier,
    withdrawVerifierAddress,
    stealthRegistry,
    stealthRegistryAddress,
    pool,
    poolAddress,
    depositReceipt,
    depositReceiptAddress,
    poolLens,
    chainId: network.chainId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Deployment Wiring", function () {
  it("ConfidentialPool.transferVerifier() returns the deployed TransferVerifier address", async function () {
    const { pool, transferVerifierAddress } = await loadFixture(fullDeployFixture);
    expect(await pool.transferVerifier()).to.equal(transferVerifierAddress);
  });

  it("ConfidentialPool.withdrawVerifier() returns the deployed WithdrawVerifier address", async function () {
    const { pool, withdrawVerifierAddress } = await loadFixture(fullDeployFixture);
    expect(await pool.withdrawVerifier()).to.equal(withdrawVerifierAddress);
  });

  it("ConfidentialPool.hasher() returns the deployed hasher address", async function () {
    const { pool, hasherAddress } = await loadFixture(fullDeployFixture);
    expect(await pool.hasher()).to.equal(hasherAddress);
  });

  it("ConfidentialPool.levels() matches configured tree height", async function () {
    const { pool } = await loadFixture(fullDeployFixture);
    expect(await pool.levels()).to.equal(MERKLE_TREE_HEIGHT);
  });

  it("ConfidentialPool.owner() is the deployer", async function () {
    const { pool, deployer } = await loadFixture(fullDeployFixture);
    expect(await pool.owner()).to.equal(deployer.address);
  });

  it("DepositReceipt.pool() matches ConfidentialPool address", async function () {
    const { depositReceipt, poolAddress } = await loadFixture(fullDeployFixture);
    expect(await depositReceipt.pool()).to.equal(poolAddress);
  });

  it("ConfidentialPool.depositReceipt() is set to DepositReceipt after wiring", async function () {
    const { pool, depositReceiptAddress } = await loadFixture(fullDeployFixture);
    expect(await pool.depositReceipt()).to.equal(depositReceiptAddress);
  });

  it("default denominations are set after deploy", async function () {
    const { pool } = await loadFixture(fullDeployFixture);

    for (const denomination of DEFAULT_DENOMINATIONS) {
      expect(await pool.allowedDenominations(denomination)).to.equal(true);
    }

    const list = await pool.getDenominations();
    expect(list.length).to.equal(DEFAULT_DENOMINATIONS.length);
  });

  it("StealthRegistry deploys independently (no constructor args)", async function () {
    const { stealthRegistry, stealthRegistryAddress } = await loadFixture(fullDeployFixture);
    expect(stealthRegistryAddress).to.be.properAddress;
    expect(await stealthRegistry.VERSION()).to.equal("1.0.0");
  });

  it("PoolLens.getSnapshot(pool) returns valid data", async function () {
    const { pool, poolLens, deployer } = await loadFixture(fullDeployFixture);
    const poolAddress = await pool.getAddress();
    const snapshot = await poolLens.getSnapshot(poolAddress);

    expect(snapshot.owner).to.equal(deployer.address);
    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.treeCapacity).to.equal(BigInt(2 ** MERKLE_TREE_HEIGHT));
    // lastRoot must be non-zero (initial Merkle tree root)
    expect(snapshot.lastRoot).to.not.equal(0n);
  });

  it("hasher.hashLeftRight(0, 0) returns a valid non-zero hash", async function () {
    const { pool } = await loadFixture(fullDeployFixture);
    const hash = await pool.hashLeftRight(0n, 0n);
    expect(hash).to.be.gt(0n);
  });

  it("all contracts are on the same chain (deployedChainId matches provider)", async function () {
    const { pool, chainId } = await loadFixture(fullDeployFixture);
    expect(await pool.deployedChainId()).to.equal(chainId);
  });

  it("full deploy flow: hasher → verifiers → stealthRegistry → pool → receipt → lens", async function () {
    const {
      hasherAddress,
      transferVerifierAddress,
      withdrawVerifierAddress,
      stealthRegistryAddress,
      pool,
      poolAddress,
      depositReceipt,
      depositReceiptAddress,
      poolLens,
    } = await loadFixture(fullDeployFixture);

    // All contracts deployed
    expect(hasherAddress).to.be.properAddress;
    expect(transferVerifierAddress).to.be.properAddress;
    expect(withdrawVerifierAddress).to.be.properAddress;
    expect(stealthRegistryAddress).to.be.properAddress;
    expect(poolAddress).to.be.properAddress;
    expect(depositReceiptAddress).to.be.properAddress;
    expect(await poolLens.getAddress()).to.be.properAddress;

    // Cross-references wired correctly
    expect(await pool.transferVerifier()).to.equal(transferVerifierAddress);
    expect(await pool.withdrawVerifier()).to.equal(withdrawVerifierAddress);
    expect(await pool.hasher()).to.equal(hasherAddress);
    expect(await pool.depositReceipt()).to.equal(depositReceiptAddress);
    expect(await depositReceipt.pool()).to.equal(poolAddress);
  });
});
