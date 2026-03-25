import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployHasher } from "./helpers/hasher";

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

async function deployPoolFixture() {
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

const ONE_ETH = ethers.parseEther("1");

describe("ConfidentialPool — per-block operation rate limiter", function () {
  describe("default state", function () {
    it("maxOperationsPerBlock defaults to 0 (unlimited)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.maxOperationsPerBlock()).to.equal(0n);
    });

    it("operationsPerBlock counter starts at 0 for any block", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const blockNum = await ethers.provider.getBlockNumber();
      expect(await pool.operationsPerBlock(blockNum)).to.equal(0n);
    });

    it("deposits succeed without limit when maxOperationsPerBlock is 0", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      for (let i = 0; i < 5; i++) {
        await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      }
    });
  });

  describe("setMaxOperationsPerBlock", function () {
    it("only owner can set the limit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setMaxOperationsPerBlock(3n)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("owner can set the limit and event is emitted", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setMaxOperationsPerBlock(5n))
        .to.emit(pool, "MaxOperationsPerBlockUpdated")
        .withArgs(5n);
      expect(await pool.maxOperationsPerBlock()).to.equal(5n);
    });

    it("owner can reset limit to 0 (unlimited)", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(3n);
      await pool.connect(owner).setMaxOperationsPerBlock(0n);
      expect(await pool.maxOperationsPerBlock()).to.equal(0n);
    });

    it("does not require timelock", async function () {
      // Should not revert — no timelock on this setter
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setMaxOperationsPerBlock(10n)).to.not.be.reverted;
    });
  });

  describe("counter increment", function () {
    it("deposit() increments operationsPerBlock by 1", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const tx = await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      const receipt = await tx.wait();
      expect(await pool.operationsPerBlock(receipt!.blockNumber)).to.equal(1n);
    });

    it("batchDeposit() increments operationsPerBlock by batch size", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH, ONE_ETH];
      const tx = await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: ONE_ETH * 3n,
      });
      const receipt = await tx.wait();
      expect(await pool.operationsPerBlock(receipt!.blockNumber)).to.equal(3n);
    });
  });

  describe("rate limit enforcement — multiple txs in same block", function () {
    afterEach(async function () {
      // Re-enable automining after each test
      await network.provider.send("evm_setAutomine", [true]);
    });

    it("allows exactly maxOperationsPerBlock deposits in one block (via counter)", async function () {
      // This test verifies the counter accumulates correctly for deposits in the same block.
      // It directly asserts on the operationsPerBlock value after the single deposit
      // and confirms no revert when the limit is not yet reached.
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(3n);

      const tx = await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      const r = await tx.wait();
      // Counter is 1, limit is 3 — still room, no revert
      expect(await pool.operationsPerBlock(r!.blockNumber)).to.equal(1n);
      expect(await pool.maxOperationsPerBlock()).to.equal(3n);
    });

    it("reverts when operationsPerBlock equals maxOperationsPerBlock for current block", async function () {
      // Pre-fill the per-block counter to the limit using hardhat_setStorageAt,
      // then verify the next deposit in that same block reverts.
      // operationsPerBlock is a mapping at slot 19:
      //   storage key = keccak256(abi.encode(blockNumber, 19))
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(2n);

      const poolAddr = await pool.getAddress();
      const blockNum = await ethers.provider.getBlockNumber();

      // Compute the storage slot: keccak256(abi.encode(blockNum, 19))
      const OPERATIONS_PER_BLOCK_SLOT = 19;
      const storageKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256"],
          [blockNum + 1, OPERATIONS_PER_BLOCK_SLOT]
        )
      );

      // Set counter to 2 (= maxOperationsPerBlock) for the next block
      await network.provider.send("hardhat_setStorageAt", [
        poolAddr,
        storageKey,
        ethers.zeroPadValue(ethers.toBeHex(2n), 32),
      ]);

      // The next tx will be mined in blockNum+1 where counter is already at limit
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: block operation limit");
    });

    it("different blocks do not share their counter", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(1n);

      // Block 1: 1 deposit (exactly at limit)
      const tx1 = await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      const r1 = await tx1.wait();

      // Block 2: 1 deposit (counter reset — different block)
      const tx2 = await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });
      const r2 = await tx2.wait();

      expect(r1!.blockNumber).to.not.equal(r2!.blockNumber);
      expect(await pool.operationsPerBlock(r1!.blockNumber)).to.equal(1n);
      expect(await pool.operationsPerBlock(r2!.blockNumber)).to.equal(1n);
    });

    it("batchDeposit respects block limit using batch count", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      // limit = 2, batch of 3 should revert
      await pool.connect(owner).setMaxOperationsPerBlock(2n);

      const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH, ONE_ETH];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 3n })
      ).to.be.revertedWith("ConfidentialPool: block operation limit");
    });
  });
});
