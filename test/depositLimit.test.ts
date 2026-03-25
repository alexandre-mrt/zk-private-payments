import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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

async function doDeposit(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  value: bigint = ONE_ETH
) {
  const c = randomCommitment();
  await pool.connect(signer).deposit(c, { value });
  return c;
}

describe("ConfidentialPool — per-address deposit limit", function () {
  describe("default state", function () {
    it("maxDepositsPerAddress defaults to 0 (unlimited)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.maxDepositsPerAddress()).to.equal(0n);
    });

    it("getRemainingDeposits returns max uint256 when no limit set", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      expect(await pool.getRemainingDeposits(alice.address)).to.equal(
        ethers.MaxUint256
      );
    });

    it("allows unlimited deposits by default", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      for (let i = 0; i < 5; i++) {
        await doDeposit(pool, alice);
      }
      expect(await pool.depositsPerAddress(alice.address)).to.equal(5n);
    });
  });

  describe("setMaxDepositsPerAddress", function () {
    it("only owner can set the limit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setMaxDepositsPerAddress(3n)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("owner can set the limit and event is emitted", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setMaxDepositsPerAddress(3n))
        .to.emit(pool, "MaxDepositsPerAddressUpdated")
        .withArgs(3n);
      expect(await pool.maxDepositsPerAddress()).to.equal(3n);
    });

    it("owner can reset limit to 0 (unlimited)", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      await pool.connect(owner).setMaxDepositsPerAddress(0n);
      expect(await pool.maxDepositsPerAddress()).to.equal(0n);
    });
  });

  describe("deposit() enforcement", function () {
    it("allows exactly maxDepositsPerAddress deposits", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      for (let i = 0; i < 3; i++) {
        await doDeposit(pool, alice);
      }
      expect(await pool.depositsPerAddress(alice.address)).to.equal(3n);
    });

    it("reverts on the 4th deposit when limit is 3", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      for (let i = 0; i < 3; i++) {
        await doDeposit(pool, alice);
      }
      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");
    });

    it("limit is per-address: different addresses are independent", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(2n);
      await doDeposit(pool, alice);
      await doDeposit(pool, alice);
      // alice is now at limit; bob should still be able to deposit
      await doDeposit(pool, bob);
      expect(await pool.depositsPerAddress(bob.address)).to.equal(1n);
    });

    it("removing the limit allows further deposits after hitting the old limit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(2n);
      await doDeposit(pool, alice);
      await doDeposit(pool, alice);
      await pool.connect(owner).setMaxDepositsPerAddress(0n);
      await doDeposit(pool, alice);
      expect(await pool.depositsPerAddress(alice.address)).to.equal(3n);
    });
  });

  describe("batchDeposit() enforcement", function () {
    it("allows a batch that fits within the limit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: ONE_ETH * 2n,
      });
      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("reverts when batch would exceed the limit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      // first use 2 deposits
      await doDeposit(pool, alice);
      await doDeposit(pool, alice);
      // batch of 2 would push total to 4, exceeding limit of 3
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, {
          value: ONE_ETH * 2n,
        })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");
    });

    it("allows batch exactly up to the remaining limit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      await doDeposit(pool, alice); // 1 used, 2 remaining
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: ONE_ETH * 2n,
      });
      expect(await pool.depositsPerAddress(alice.address)).to.equal(3n);
    });

    it("unlimited batch when limit is 0", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH, ONE_ETH];
      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: ONE_ETH * 3n,
      });
      expect(await pool.depositsPerAddress(alice.address)).to.equal(3n);
    });
  });

  describe("getRemainingDeposits", function () {
    it("returns correct remaining count after some deposits", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      await doDeposit(pool, alice);
      expect(await pool.getRemainingDeposits(alice.address)).to.equal(2n);
    });

    it("returns 0 when limit is fully consumed", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      for (let i = 0; i < 3; i++) {
        await doDeposit(pool, alice);
      }
      expect(await pool.getRemainingDeposits(alice.address)).to.equal(0n);
    });

    it("returns max uint256 when limit is 0 (unlimited)", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      await pool.connect(owner).setMaxDepositsPerAddress(0n);
      expect(await pool.getRemainingDeposits(alice.address)).to.equal(
        ethers.MaxUint256
      );
    });

    it("reflects batch deposits correctly", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxDepositsPerAddress(5n);
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: ONE_ETH * 2n,
      });
      expect(await pool.getRemainingDeposits(alice.address)).to.equal(3n);
    });
  });
});
