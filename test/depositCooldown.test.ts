import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

const COOLDOWN = 60; // 60 seconds

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

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof deployPoolFixture>>["alice"];

async function doDeposit(pool: Pool, signer: Signer, value: bigint = ONE_ETH) {
  const c = randomCommitment();
  await pool.connect(signer).deposit(c, { value });
  return c;
}

function cooldownActionHash(_cooldown: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setDepositCooldown", _cooldown]
    )
  );
}

async function timelockSetCooldown(
  pool: Pool,
  _cooldown: bigint
): Promise<void> {
  await pool.queueAction(cooldownActionHash(_cooldown));
  await time.increase(86401); // 1 day + 1 second
}

describe("ConfidentialPool — per-address deposit cooldown", function () {
  describe("default state", function () {
    it("depositCooldown defaults to 0 (no cooldown)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.depositCooldown()).to.equal(0n);
    });

    it("allows back-to-back deposits when cooldown is 0", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await doDeposit(pool, alice);
      await doDeposit(pool, alice);
      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    });
  });

  describe("setDepositCooldown", function () {
    it("only owner can queue the cooldown action", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).queueAction(cooldownActionHash(BigInt(COOLDOWN)))
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("owner sets cooldown and event is emitted", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await timelockSetCooldown(pool, BigInt(COOLDOWN));
      await expect(pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN)))
        .to.emit(pool, "DepositCooldownUpdated")
        .withArgs(BigInt(COOLDOWN));
      expect(await pool.depositCooldown()).to.equal(BigInt(COOLDOWN));
    });
  });

  describe("deposit() enforcement", function () {
    it("reverts when depositing again before cooldown expires", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await timelockSetCooldown(pool, BigInt(COOLDOWN));
      await pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN));
      await doDeposit(pool, alice);
      const c = randomCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");
    });

    it("allows deposit after cooldown period has elapsed", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await timelockSetCooldown(pool, BigInt(COOLDOWN));
      await pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN));
      await doDeposit(pool, alice);
      await time.increase(COOLDOWN + 1);
      await doDeposit(pool, alice);
      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("cooldown is per-address: different addresses are independent", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      await timelockSetCooldown(pool, BigInt(COOLDOWN));
      await pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN));
      await doDeposit(pool, alice);
      // alice is in cooldown, bob should deposit freely
      await doDeposit(pool, bob);
      expect(await pool.depositsPerAddress(bob.address)).to.equal(1n);
    });

    it("setting cooldown to 0 removes the restriction", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await timelockSetCooldown(pool, BigInt(COOLDOWN));
      await pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN));
      await doDeposit(pool, alice);
      await timelockSetCooldown(pool, 0n);
      await pool.connect(owner).setDepositCooldown(0n);
      await doDeposit(pool, alice); // should not revert
      expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("lastDepositTime is updated after each deposit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await timelockSetCooldown(pool, BigInt(COOLDOWN));
      await pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN));
      await doDeposit(pool, alice);
      const ts1 = await pool.lastDepositTime(alice.address);
      await time.increase(COOLDOWN + 1);
      await doDeposit(pool, alice);
      const ts2 = await pool.lastDepositTime(alice.address);
      expect(ts2).to.be.greaterThan(ts1);
    });
  });

  describe("batchDeposit() enforcement", function () {
    it("reverts batch when depositing again before cooldown expires", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await timelockSetCooldown(pool, BigInt(COOLDOWN));
      await pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN));
      await doDeposit(pool, alice);
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 2n })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");
    });

    it("allows batch deposit after cooldown period has elapsed", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await timelockSetCooldown(pool, BigInt(COOLDOWN));
      await pool.connect(owner).setDepositCooldown(BigInt(COOLDOWN));
      await doDeposit(pool, alice);
      await time.increase(COOLDOWN + 1);
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ONE_ETH, ONE_ETH];
      await pool.connect(alice).batchDeposit(commitments, amounts, { value: ONE_ETH * 2n });
      expect(await pool.depositsPerAddress(alice.address)).to.equal(3n);
    });
  });
});
