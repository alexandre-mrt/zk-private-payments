import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, PoolLens, StealthRegistry } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function deployVerifiers() {
  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  return {
    transferVerifier,
    withdrawVerifier,
    transferVerifierAddress: await transferVerifier.getAddress(),
    withdrawVerifierAddress: await withdrawVerifier.getAddress(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Constructor Validation", function () {
  describe("ConfidentialPool", () => {
    it("reverts with zero transfer verifier", async () => {
      const hasherAddress = await deployHasher();
      const { withdrawVerifierAddress } = await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(ZERO_ADDRESS, withdrawVerifierAddress, MERKLE_TREE_HEIGHT, hasherAddress)
      ).to.be.revertedWith("ConfidentialPool: zero transfer verifier");
    });

    it("reverts with zero withdraw verifier", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress } = await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(transferVerifierAddress, ZERO_ADDRESS, MERKLE_TREE_HEIGHT, hasherAddress)
      ).to.be.revertedWith("ConfidentialPool: zero withdraw verifier");
    });

    it("reverts with zero hasher", async () => {
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(
          transferVerifierAddress,
          withdrawVerifierAddress,
          MERKLE_TREE_HEIGHT,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith("MerkleTree: hasher is zero address");
    });

    it("reverts with levels = 0", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(
          transferVerifierAddress,
          withdrawVerifierAddress,
          0,
          hasherAddress
        )
      ).to.be.revertedWith("MerkleTree: levels out of range");
    });

    it("reverts with levels > 32", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(
          transferVerifierAddress,
          withdrawVerifierAddress,
          33,
          hasherAddress
        )
      ).to.be.revertedWith("MerkleTree: levels out of range");
    });

    it("succeeds with valid parameters", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      const pool = (await Pool.deploy(
        transferVerifierAddress,
        withdrawVerifierAddress,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as ConfidentialPool;

      expect(await pool.getAddress()).to.be.properAddress;
    });

    it("stores correct verifiers", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      const pool = (await Pool.deploy(
        transferVerifierAddress,
        withdrawVerifierAddress,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as ConfidentialPool;

      expect(await pool.transferVerifier()).to.equal(transferVerifierAddress);
      expect(await pool.withdrawVerifier()).to.equal(withdrawVerifierAddress);
    });

    it("stores correct owner", async () => {
      const [owner] = await ethers.getSigners();
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      const pool = (await Pool.deploy(
        transferVerifierAddress,
        withdrawVerifierAddress,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as ConfidentialPool;

      expect(await pool.owner()).to.equal(owner.address);
    });

    it("stores correct deployedChainId", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      const pool = (await Pool.deploy(
        transferVerifierAddress,
        withdrawVerifierAddress,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as ConfidentialPool;

      const { chainId } = await ethers.provider.getNetwork();
      expect(await pool.deployedChainId()).to.equal(chainId);
    });

    it("initializes all counters to 0", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      const pool = (await Pool.deploy(
        transferVerifierAddress,
        withdrawVerifierAddress,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as ConfidentialPool;

      expect(await pool.nextIndex()).to.equal(0n);
      expect(await pool.totalDeposited()).to.equal(0n);
      expect(await pool.totalWithdrawn()).to.equal(0n);
      expect(await pool.totalTransfers()).to.equal(0n);
      expect(await pool.withdrawalCount()).to.equal(0n);
      expect(await pool.uniqueDepositorCount()).to.equal(0n);
    });

    it("initializes allowlistEnabled to false", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      const pool = (await Pool.deploy(
        transferVerifierAddress,
        withdrawVerifierAddress,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as ConfidentialPool;

      expect(await pool.allowlistEnabled()).to.equal(false);
    });

    it("initializes paused to false", async () => {
      const hasherAddress = await deployHasher();
      const { transferVerifierAddress, withdrawVerifierAddress } =
        await deployVerifiers();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      const pool = (await Pool.deploy(
        transferVerifierAddress,
        withdrawVerifierAddress,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as ConfidentialPool;

      expect(await pool.paused()).to.equal(false);
    });
  });

  describe("StealthRegistry", () => {
    it("deploys successfully", async () => {
      const StealthRegistryFactory =
        await ethers.getContractFactory("StealthRegistry");
      const registry =
        (await StealthRegistryFactory.deploy()) as unknown as StealthRegistry;

      expect(await registry.getAddress()).to.be.properAddress;
    });

    it("VERSION is 1.0.0", async () => {
      const StealthRegistryFactory =
        await ethers.getContractFactory("StealthRegistry");
      const registry =
        (await StealthRegistryFactory.deploy()) as unknown as StealthRegistry;

      expect(await registry.VERSION()).to.equal("1.0.0");
    });
  });

  describe("DepositReceipt", () => {
    it("reverts with zero pool address", async () => {
      const DepositReceiptFactory =
        await ethers.getContractFactory("DepositReceipt");
      await expect(
        DepositReceiptFactory.deploy(ZERO_ADDRESS)
      ).to.be.revertedWith("DepositReceipt: zero pool");
    });

    it("stores correct pool address", async () => {
      const [, placeholder] = await ethers.getSigners();
      const poolAddress = placeholder.address;
      const DepositReceiptFactory =
        await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceiptFactory.deploy(poolAddress);

      expect(await receipt.pool()).to.equal(poolAddress);
    });

    it("name is 'ZK Private Payment Receipt'", async () => {
      const [, placeholder] = await ethers.getSigners();
      const DepositReceiptFactory =
        await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceiptFactory.deploy(placeholder.address);

      expect(await receipt.name()).to.equal("ZK Private Payment Receipt");
    });

    it("symbol is 'ZKPR'", async () => {
      const [, placeholder] = await ethers.getSigners();
      const DepositReceiptFactory =
        await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceiptFactory.deploy(placeholder.address);

      expect(await receipt.symbol()).to.equal("ZKPR");
    });
  });

  describe("PoolLens", () => {
    it("deploys successfully", async () => {
      const PoolLensFactory = await ethers.getContractFactory("PoolLens");
      const lens = (await PoolLensFactory.deploy()) as unknown as PoolLens;

      expect(await lens.getAddress()).to.be.properAddress;
    });
  });
});
