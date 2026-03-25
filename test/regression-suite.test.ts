import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ONE_DAY = 86_400;
const MERKLE_TREE_HEIGHT = 5;

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

function nonZeroCommitment(): bigint {
  const c = randomCommitment();
  return c === 0n ? 1n : c;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();
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
  return { pool, owner, alice, bob, relayer };
}

async function deployPoolWithLensFixture() {
  const base = await deployPoolFixture();
  const LensFactory = await ethers.getContractFactory("PoolLens");
  const lens = await LensFactory.deploy();
  return { ...base, lens };
}

async function deployPoolWithRegistryFixture() {
  const base = await deployPoolFixture();
  const RegistryFactory = await ethers.getContractFactory("StealthRegistry");
  const registry = await RegistryFactory.deploy();
  return { ...base, registry };
}

async function deployPoolWithReceiptFixture() {
  const base = await deployPoolFixture();
  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = await ReceiptFactory.deploy(await base.pool.getAddress());
  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PoolType = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];
type SignerType = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(
  pool: PoolType,
  signer: SignerType,
  commitment?: bigint,
  value: bigint = ethers.parseEther("1")
): Promise<bigint> {
  const c = commitment ?? nonZeroCommitment();
  await pool.connect(signer).deposit(c, { value });
  return c;
}

async function depositAndGetRoot(
  pool: PoolType,
  signer: SignerType,
  commitment: bigint,
  value: bigint = ethers.parseEther("1")
) {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

async function queueAndWait(pool: PoolType, hash: string, owner: SignerType) {
  await pool.connect(owner).queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

async function doWithdraw(
  pool: PoolType,
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment: bigint,
  relayer: string,
  fee: bigint,
  caller: SignerType
) {
  return pool.connect(caller).withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient as `0x${string}`,
    changeCommitment,
    relayer as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Regression Suite
// ---------------------------------------------------------------------------

describe("Regression Suite", function () {
  // -------------------------------------------------------------------------
  // deposit
  // -------------------------------------------------------------------------

  describe("deposit", function () {
    it("deposit: happy path emits Deposit event", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = nonZeroCommitment();
      await expect(pool.connect(alice).deposit(c, { value: ethers.parseEther("1") }))
        .to.emit(pool, "Deposit");
    });

    it("deposit: zero commitment reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).deposit(0n, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: zero commitment");
    });

    it("deposit: zero value reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).deposit(nonZeroCommitment(), { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: zero deposit");
    });

    it("deposit: duplicate commitment reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = nonZeroCommitment();
      await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      await expect(
        pool.connect(alice).deposit(c, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
    });

    it("deposit: field overflow reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).deposit(FIELD_SIZE, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: commitment >= field size");
    });
  });

  // -------------------------------------------------------------------------
  // batchDeposit
  // -------------------------------------------------------------------------

  describe("batchDeposit", function () {
    it("batchDeposit: happy path inserts all commitments", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c1 = nonZeroCommitment();
      const c2 = nonZeroCommitment();
      const amounts = [ethers.parseEther("1"), ethers.parseEther("2")];
      const total = amounts.reduce((a, b) => a + b, 0n);
      await pool.connect(alice).batchDeposit([c1, c2], amounts, { value: total });
      expect(await pool.commitments(c1)).to.be.true;
      expect(await pool.commitments(c2)).to.be.true;
    });

    it("batchDeposit: mismatched arrays reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).batchDeposit(
          [nonZeroCommitment(), nonZeroCommitment()],
          [ethers.parseEther("1")],
          { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWith("ConfidentialPool: arrays length mismatch");
    });

    it("batchDeposit: empty array reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).batchDeposit([], [], { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: empty batch");
    });

    it("batchDeposit: batch too large reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments = Array.from({ length: 11 }, () => nonZeroCommitment());
      const amounts = Array.from({ length: 11 }, () => ethers.parseEther("1"));
      const total = amounts.reduce((a, b) => a + b, 0n);
      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.be.revertedWith("ConfidentialPool: batch too large");
    });

    it("batchDeposit: incorrect total amount reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = nonZeroCommitment();
      await expect(
        pool.connect(alice).batchDeposit(
          [c],
          [ethers.parseEther("1")],
          { value: ethers.parseEther("0.5") }
        )
      ).to.be.revertedWith("ConfidentialPool: incorrect total amount");
    });
  });

  // -------------------------------------------------------------------------
  // transfer
  // -------------------------------------------------------------------------

  describe("transfer", function () {
    it("transfer: happy path marks nullifier spent", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = nonZeroCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment);
      const nullifier = nonZeroCommitment();
      const out1 = nonZeroCommitment();
      const out2 = nonZeroCommitment();
      await pool.transfer(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, root, nullifier, out1, out2);
      expect(await pool.nullifiers(nullifier)).to.be.true;
    });

    it("transfer: double spend reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = nonZeroCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment);
      const nullifier = nonZeroCommitment();
      const out1 = nonZeroCommitment();
      const out2 = nonZeroCommitment();
      await pool.transfer(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, root, nullifier, out1, out2);
      const out3 = nonZeroCommitment();
      const out4 = nonZeroCommitment();
      await expect(
        pool.transfer(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, root, nullifier, out3, out4)
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it("transfer: unknown root reverts", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const unknownRoot = nonZeroCommitment();
      await expect(
        pool.transfer(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, unknownRoot, nonZeroCommitment(), nonZeroCommitment(), nonZeroCommitment())
      ).to.be.revertedWith("ConfidentialPool: unknown root");
    });

    it("transfer: zero output commitment reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = nonZeroCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment);
      await expect(
        pool.transfer(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, root, nonZeroCommitment(), 0n, nonZeroCommitment())
      ).to.be.revertedWith("ConfidentialPool: zero output commitment");
    });
  });

  // -------------------------------------------------------------------------
  // withdraw
  // -------------------------------------------------------------------------

  describe("withdraw", function () {
    it("withdraw: happy path transfers ETH to recipient", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const value = ethers.parseEther("1");
      const commitment = nonZeroCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment, value);
      const nullifier = nonZeroCommitment();
      const recipientAddr = await bob.getAddress();
      const balanceBefore = await ethers.provider.getBalance(recipientAddr);
      await doWithdraw(pool, root, nullifier, value, recipientAddr, 0n, ethers.ZeroAddress, 0n, alice);
      const balanceAfter = await ethers.provider.getBalance(recipientAddr);
      expect(balanceAfter - balanceBefore).to.equal(value);
    });

    it("withdraw: double spend reverts", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const value = ethers.parseEther("1");
      const commitment = nonZeroCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment, value);
      const nullifier = nonZeroCommitment();
      await doWithdraw(pool, root, nullifier, value, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n, alice);
      await expect(
        doWithdraw(pool, root, nullifier, value, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n, alice)
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it("withdraw: unknown root reverts", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const unknownRoot = nonZeroCommitment();
      await expect(
        doWithdraw(pool, unknownRoot, nonZeroCommitment(), ethers.parseEther("1"), await bob.getAddress(), 0n, ethers.ZeroAddress, 0n, alice)
      ).to.be.revertedWith("ConfidentialPool: unknown root");
    });

    it("withdraw: zero recipient reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = nonZeroCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment);
      await expect(
        doWithdraw(pool, root, nonZeroCommitment(), ethers.parseEther("1"), ethers.ZeroAddress, 0n, ethers.ZeroAddress, 0n, alice)
      ).to.be.revertedWith("ConfidentialPool: zero recipient");
    });

    it("withdraw: fee exceeds amount reverts", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const value = ethers.parseEther("1");
      const commitment = nonZeroCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment, value);
      await expect(
        doWithdraw(pool, root, nonZeroCommitment(), value, await bob.getAddress(), 0n, ethers.ZeroAddress, value + 1n, alice)
      ).to.be.revertedWith("ConfidentialPool: fee exceeds amount");
    });

    it("withdraw: zero relayer with non-zero fee reverts", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const value = ethers.parseEther("1");
      const commitment = nonZeroCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment, value);
      await expect(
        doWithdraw(pool, root, nonZeroCommitment(), value, await bob.getAddress(), 0n, ethers.ZeroAddress, 1000n, alice)
      ).to.be.revertedWith("ConfidentialPool: zero relayer for non-zero fee");
    });
  });

  // -------------------------------------------------------------------------
  // admin — pause / unpause
  // -------------------------------------------------------------------------

  describe("admin: pause / unpause", function () {
    it("pause: owner succeeds", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).pause()).to.emit(pool, "Paused");
    });

    it("pause: non-owner reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).pause()
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("unpause: owner succeeds", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();
      await expect(pool.connect(owner).unpause()).to.emit(pool, "Unpaused");
    });

    it("unpause: non-owner reverts", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();
      await expect(
        pool.connect(alice).unpause()
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // admin — queueAction / cancelAction
  // -------------------------------------------------------------------------

  describe("admin: queueAction / cancelAction", function () {
    it("queueAction: owner succeeds", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await expect(pool.connect(owner).queueAction(hash))
        .to.emit(pool, "ActionQueued");
    });

    it("queueAction: non-owner reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await expect(
        pool.connect(alice).queueAction(hash)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("cancelAction: owner succeeds", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await pool.connect(owner).queueAction(hash);
      await expect(pool.connect(owner).cancelAction())
        .to.emit(pool, "ActionCancelled");
    });

    it("cancelAction: non-owner reverts", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await pool.connect(owner).queueAction(hash);
      await expect(
        pool.connect(alice).cancelAction()
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // admin — setAllowlistEnabled / setAllowlisted / batchSetAllowlisted
  // -------------------------------------------------------------------------

  describe("admin: allowlist", function () {
    it("setAllowlistEnabled: owner can enable", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setAllowlistEnabled(true))
        .to.emit(pool, "AllowlistToggled")
        .withArgs(true);
      expect(await pool.allowlistEnabled()).to.be.true;
    });

    it("setAllowlistEnabled: non-owner reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setAllowlistEnabled(true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setAllowlisted: owner can allowlist an address", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setAllowlisted(await alice.getAddress(), true))
        .to.emit(pool, "AllowlistUpdated")
        .withArgs(await alice.getAddress(), true);
      expect(await pool.allowlisted(await alice.getAddress())).to.be.true;
    });

    it("setAllowlisted: non-owner reverts", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setAllowlisted(await bob.getAddress(), true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("batchSetAllowlisted: owner can allowlist multiple addresses", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      const addrs = [await alice.getAddress(), await bob.getAddress()];
      await pool.connect(owner).batchSetAllowlisted(addrs, true);
      expect(await pool.allowlisted(await alice.getAddress())).to.be.true;
      expect(await pool.allowlisted(await bob.getAddress())).to.be.true;
    });

    it("batchSetAllowlisted: non-owner reverts", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).batchSetAllowlisted([await bob.getAddress()], true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("deposit with allowlist enabled and not allowlisted reverts", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await expect(
        pool.connect(alice).deposit(nonZeroCommitment(), { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  });

  // -------------------------------------------------------------------------
  // admin — emergencyDrain
  // -------------------------------------------------------------------------

  describe("admin: emergencyDrain", function () {
    it("emergencyDrain: owner can drain when paused", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      const value = ethers.parseEther("1");
      await doDeposit(pool, alice, undefined, value);
      await pool.connect(owner).pause();
      const recipientAddr = await bob.getAddress();
      const balanceBefore = await ethers.provider.getBalance(recipientAddr);
      await expect(
        pool.connect(owner).emergencyDrain(recipientAddr as `0x${string}`)
      ).to.emit(pool, "EmergencyDrain");
      const balanceAfter = await ethers.provider.getBalance(recipientAddr);
      expect(balanceAfter - balanceBefore).to.equal(value);
    });

    it("emergencyDrain: reverts when not paused", async function () {
      const { pool, owner, bob } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(owner).emergencyDrain(await bob.getAddress() as `0x${string}`)
      ).to.be.revertedWithCustomError(pool, "ExpectedPause");
    });

    it("emergencyDrain: zero address target reverts", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await doDeposit(pool, alice);
      await pool.connect(owner).pause();
      await expect(
        pool.connect(owner).emergencyDrain(ethers.ZeroAddress as `0x${string}`)
      ).to.be.revertedWith("ConfidentialPool: zero drain address");
    });

    it("emergencyDrain: non-owner reverts", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      await doDeposit(pool, alice);
      await pool.connect(owner).pause();
      await expect(
        pool.connect(alice).emergencyDrain(await bob.getAddress() as `0x${string}`)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // timelocked setters
  // -------------------------------------------------------------------------

  describe("timelocked setters", function () {
    it("setMaxDepositsPerAddress: happy path via timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 3n);
      await queueAndWait(pool, hash, owner);
      await expect(pool.connect(owner).setMaxDepositsPerAddress(3n))
        .to.emit(pool, "MaxDepositsPerAddressUpdated")
        .withArgs(3n);
      expect(await pool.maxDepositsPerAddress()).to.equal(3n);
    });

    it("setMaxDepositsPerAddress: without queue reverts", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(owner).setMaxDepositsPerAddress(3n)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("setDepositCooldown: happy path via timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setDepositCooldown", 3600n);
      await queueAndWait(pool, hash, owner);
      await expect(pool.connect(owner).setDepositCooldown(3600n))
        .to.emit(pool, "DepositCooldownUpdated")
        .withArgs(3600n);
      expect(await pool.depositCooldown()).to.equal(3600n);
    });

    it("setDepositCooldown: without queue reverts", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(owner).setDepositCooldown(3600n)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("setMaxWithdrawAmount: happy path via timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const cap = ethers.parseEther("5");
      const hash = timelockHash("setMaxWithdrawAmount", cap);
      await queueAndWait(pool, hash, owner);
      await expect(pool.connect(owner).setMaxWithdrawAmount(cap))
        .to.emit(pool, "MaxWithdrawAmountUpdated")
        .withArgs(cap);
      expect(await pool.maxWithdrawAmount()).to.equal(cap);
    });

    it("setMaxWithdrawAmount: without queue reverts", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(owner).setMaxWithdrawAmount(ethers.parseEther("5"))
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("setMinDepositAge: happy path via timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMinDepositAge", 5n);
      await queueAndWait(pool, hash, owner);
      await expect(pool.connect(owner).setMinDepositAge(5n))
        .to.emit(pool, "MinDepositAgeUpdated")
        .withArgs(5n);
      expect(await pool.minDepositAge()).to.equal(5n);
    });

    it("setMinDepositAge: without queue reverts", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(owner).setMinDepositAge(5n)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("addDenomination: happy path via timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const denom = ethers.parseEther("0.1");
      const hash = timelockHash("addDenomination", denom);
      await queueAndWait(pool, hash, owner);
      await expect(pool.connect(owner).addDenomination(denom))
        .to.emit(pool, "DenominationAdded")
        .withArgs(denom);
      expect(await pool.allowedDenominations(denom)).to.be.true;
    });

    it("addDenomination: without queue reverts", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(owner).addDenomination(ethers.parseEther("0.1"))
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });

    it("removeDenomination: happy path via timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      // First add denomination via timelock
      const denom = ethers.parseEther("0.1");
      const addHash = timelockHash("addDenomination", denom);
      await queueAndWait(pool, addHash, owner);
      await pool.connect(owner).addDenomination(denom);
      // Then remove via timelock
      const removeHash = timelockHash("removeDenomination", denom);
      await queueAndWait(pool, removeHash, owner);
      await expect(pool.connect(owner).removeDenomination(denom))
        .to.emit(pool, "DenominationRemoved")
        .withArgs(denom);
      expect(await pool.allowedDenominations(denom)).to.be.false;
    });

    it("removeDenomination: without queue reverts", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const denom = ethers.parseEther("0.1");
      const addHash = timelockHash("addDenomination", denom);
      await queueAndWait(pool, addHash, owner);
      await pool.connect(owner).addDenomination(denom);
      await expect(
        pool.connect(owner).removeDenomination(denom)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });
  });

  // -------------------------------------------------------------------------
  // view functions
  // -------------------------------------------------------------------------

  describe("view functions", function () {
    it("getPoolStats returns 7 values", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const stats = await pool.getPoolStats();
      expect(stats).to.have.length(7);
    });

    it("getActiveNoteCount is 0 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getActiveNoteCount()).to.equal(0n);
    });

    it("getPoolHealth returns 7 values", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const health = await pool.getPoolHealth();
      expect(health).to.have.length(7);
    });

    it("getPoolHealth: isPaused is false initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const health = await pool.getPoolHealth();
      expect(health.isPaused).to.be.false;
    });

    it("getPoolHealth: allowlistEnabled is false initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const health = await pool.getPoolHealth();
      expect(health.isAllowlisted).to.be.false;
    });

    it("getTreeCapacity is 2^levels", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getTreeCapacity()).to.equal(2n ** BigInt(MERKLE_TREE_HEIGHT));
    });

    it("getTreeUtilization is 0 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getTreeUtilization()).to.equal(0n);
    });

    it("hasCapacity is true initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.hasCapacity()).to.be.true;
    });

    it("getLastRoot is non-zero", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getLastRoot()).to.not.equal(0n);
    });

    it("isKnownRoot(getLastRoot) is true", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const root = await pool.getLastRoot();
      expect(await pool.isKnownRoot(root)).to.be.true;
    });

    it("isKnownRoot(0) is false", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.isKnownRoot(0n)).to.be.false;
    });

    it("getRootHistory length is 30", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const history = await pool.getRootHistory();
      expect(history).to.have.length(30);
    });

    it("getValidRootCount is 1 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getValidRootCount()).to.equal(1);
    });

    it("getRemainingDeposits is max uint when no limit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      expect(await pool.getRemainingDeposits(await alice.getAddress())).to.equal(
        ethers.MaxUint256
      );
    });

    it("deployedChainId is 31337", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.deployedChainId()).to.equal(31337n);
    });

    it("getDepositCount returns 0 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getDepositCount()).to.equal(0);
    });

    it("getWithdrawalRecordCount returns 0 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getWithdrawalRecordCount()).to.equal(0n);
    });

    it("getDenominations returns empty array initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getDenominations()).to.have.length(0);
    });
  });

  // -------------------------------------------------------------------------
  // StealthRegistry
  // -------------------------------------------------------------------------

  describe("StealthRegistry", function () {
    it("registerViewingKey: happy path stores key", async function () {
      const { registry, alice } = await loadFixture(deployPoolWithRegistryFixture);
      const x = 111n;
      const y = 222n;
      await expect(registry.connect(alice).registerViewingKey(x, y))
        .to.emit(registry, "ViewingKeyRegistered")
        .withArgs(await alice.getAddress(), x, y);
      const [vkX, vkY] = await registry.getViewingKey(await alice.getAddress());
      expect(vkX).to.equal(x);
      expect(vkY).to.equal(y);
    });

    it("registerViewingKey: zero key reverts", async function () {
      const { registry, alice } = await loadFixture(deployPoolWithRegistryFixture);
      await expect(
        registry.connect(alice).registerViewingKey(0n, 0n)
      ).to.be.revertedWith("StealthRegistry: zero key");
    });

    it("registerViewingKey: non-zero X only succeeds", async function () {
      const { registry, alice } = await loadFixture(deployPoolWithRegistryFixture);
      await expect(registry.connect(alice).registerViewingKey(1n, 0n)).to.not.be.reverted;
    });

    it("registerViewingKey: overwriting key updates it", async function () {
      const { registry, alice } = await loadFixture(deployPoolWithRegistryFixture);
      await registry.connect(alice).registerViewingKey(1n, 2n);
      await registry.connect(alice).registerViewingKey(3n, 4n);
      const [vkX, vkY] = await registry.getViewingKey(await alice.getAddress());
      expect(vkX).to.equal(3n);
      expect(vkY).to.equal(4n);
    });

    it("getViewingKey: unregistered address returns (0, 0)", async function () {
      const { registry, bob } = await loadFixture(deployPoolWithRegistryFixture);
      const [vkX, vkY] = await registry.getViewingKey(await bob.getAddress());
      expect(vkX).to.equal(0n);
      expect(vkY).to.equal(0n);
    });

    it("announceStealthPayment: emits StealthPayment event", async function () {
      const { registry, alice } = await loadFixture(deployPoolWithRegistryFixture);
      const commitment = nonZeroCommitment();
      await expect(
        registry.connect(alice).announceStealthPayment(commitment, 1n, 2n, 3n, 4n, 5n, 6n)
      ).to.emit(registry, "StealthPayment");
    });

    it("announceStealthPayment: emits with correct commitment", async function () {
      const { registry, alice } = await loadFixture(deployPoolWithRegistryFixture);
      const commitment = nonZeroCommitment();
      const tx = registry.connect(alice).announceStealthPayment(commitment, 1n, 2n, 3n, 4n, 5n, 6n);
      await expect(tx).to.emit(registry, "StealthPayment").withArgs(commitment, 1n, 2n, 3n, 4n, 5n, 6n);
    });

    it("StealthRegistry VERSION is 1.0.0", async function () {
      const { registry } = await loadFixture(deployPoolWithRegistryFixture);
      expect(await registry.VERSION()).to.equal("1.0.0");
    });
  });

  // -------------------------------------------------------------------------
  // PoolLens
  // -------------------------------------------------------------------------

  describe("PoolLens", function () {
    it("getSnapshot returns valid struct", async function () {
      const { pool, lens } = await loadFixture(deployPoolWithLensFixture);
      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.depositCount).to.equal(0n);
    });

    it("snapshot.version is 1.0.0", async function () {
      const { pool, lens } = await loadFixture(deployPoolWithLensFixture);
      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.version).to.equal("1.0.0");
    });

    it("snapshot.owner is deployer", async function () {
      const { pool, lens, owner } = await loadFixture(deployPoolWithLensFixture);
      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.owner).to.equal(await owner.getAddress());
    });

    it("snapshot.isPaused is false initially", async function () {
      const { pool, lens } = await loadFixture(deployPoolWithLensFixture);
      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.isPaused).to.be.false;
    });

    it("snapshot.activeNotes is 0 initially", async function () {
      const { pool, lens } = await loadFixture(deployPoolWithLensFixture);
      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.activeNotes).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // DepositReceipt
  // -------------------------------------------------------------------------

  describe("DepositReceipt", function () {
    it("name is correct", async function () {
      const { receipt } = await loadFixture(deployPoolWithReceiptFixture);
      expect(await receipt.name()).to.equal("ZK Private Payment Receipt");
    });

    it("symbol is correct", async function () {
      const { receipt } = await loadFixture(deployPoolWithReceiptFixture);
      expect(await receipt.symbol()).to.equal("ZKPR");
    });

    it("soulbound: transfer reverts", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receipt = await ReceiptFactory.deploy(await pool.getAddress());
      await pool.connect(owner).setDepositReceipt(await receipt.getAddress());
      await doDeposit(pool, alice);
      await expect(
        receipt.connect(alice).transferFrom(await alice.getAddress(), await bob.getAddress(), 0)
      ).to.be.revertedWith("DepositReceipt: soulbound");
    });

    it("mint: non-pool reverts", async function () {
      const { receipt, alice, bob } = await loadFixture(deployPoolWithReceiptFixture);
      await expect(
        receipt.connect(alice).mint(await bob.getAddress(), nonZeroCommitment(), ethers.parseEther("1"))
      ).to.be.revertedWith("DepositReceipt: only pool");
    });
  });

  // -------------------------------------------------------------------------
  // ERC165
  // -------------------------------------------------------------------------

  describe("ERC165", function () {
    it("supportsInterface ERC165 returns true", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.supportsInterface("0x01ffc9a7")).to.be.true;
    });

    it("supportsInterface random returns false", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.supportsInterface("0xdeadbeef")).to.be.false;
    });
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe("Constants", function () {
    it("VERSION is 1.0.0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.VERSION()).to.equal("1.0.0");
    });

    it("TIMELOCK_DELAY is 86400", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.TIMELOCK_DELAY()).to.equal(86400n);
    });

    it("ROOT_HISTORY_SIZE is 30", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.ROOT_HISTORY_SIZE()).to.equal(30);
    });
  });

  // -------------------------------------------------------------------------
  // Hash functions
  // -------------------------------------------------------------------------

  describe("Hash", function () {
    it("verifyHash returns non-zero result", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const a = 12345n;
      const b = 67890n;
      const result = await pool.verifyHash(a, b);
      expect(result).to.not.equal(0n);
    });

    it("verifyHash is deterministic", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const a = nonZeroCommitment();
      const b = nonZeroCommitment();
      const r1 = await pool.verifyHash(a, b);
      const r2 = await pool.verifyHash(a, b);
      expect(r1).to.equal(r2);
    });

    it("verifyHash is non-commutative", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const r1 = await pool.verifyHash(1n, 2n);
      const r2 = await pool.verifyHash(2n, 1n);
      expect(r1).to.not.equal(r2);
    });
  });
});
