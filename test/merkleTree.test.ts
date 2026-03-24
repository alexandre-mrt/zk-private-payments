import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// Shallow tree so tests run fast and capacity math is straightforward
const MERKLE_TREE_HEIGHT = 5;
const EXPECTED_CAPACITY = 2 ** MERKLE_TREE_HEIGHT; // 32

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

async function deployPoolFixture() {
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
    MERKLE_TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice };
}

describe("MerkleTree view functions", function () {
  describe("getTreeCapacity", function () {
    it("returns 2^levels for the configured tree height", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const capacity = await pool.getTreeCapacity();
      expect(capacity).to.equal(BigInt(EXPECTED_CAPACITY));
    });
  });

  describe("getTreeUtilization", function () {
    it("returns 0 when no deposits have been made", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const utilization = await pool.getTreeUtilization();
      expect(utilization).to.equal(0n);
    });

    it("increases after a deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });

      // 1 leaf out of 32 = floor(1 * 100 / 32) = 3
      const utilization = await pool.getTreeUtilization();
      expect(utilization).to.equal(3n);
    });

    it("increases proportionally with more deposits", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      // Insert 4 leaves: floor(4 * 100 / 32) = 12
      for (let i = 0; i < 4; i++) {
        await pool
          .connect(alice)
          .deposit(randomCommitment(), { value: ethers.parseEther("1") });
      }

      const utilization = await pool.getTreeUtilization();
      expect(utilization).to.equal(12n);
    });
  });

  describe("hasCapacity", function () {
    it("returns true on a fresh deployment", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.hasCapacity()).to.equal(true);
    });

    it("returns true after some deposits when the tree is not full", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });

      expect(await pool.hasCapacity()).to.equal(true);
    });
  });
});
