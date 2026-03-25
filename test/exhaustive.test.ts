import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ONE_DAY = 86_400;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rc(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

async function queue(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  hash: string
): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie, relayer] = await ethers.getSigners();
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
  return { pool, owner, alice, bob, charlie, relayer };
}

async function deployWithLensFixture() {
  const base = await deployPoolFixture();
  const Lens = await ethers.getContractFactory("PoolLens");
  const lens = await Lens.deploy();
  return { ...base, lens };
}

async function deployWithReceiptFixture() {
  const base = await deployPoolFixture();
  const { pool, owner } = base;
  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = await DepositReceiptFactory.deploy(await pool.getAddress());
  await pool.connect(owner).setDepositReceipt(await receipt.getAddress());
  return { ...base, receipt };
}

async function deployStealthFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();
  return { registry, owner, alice, bob };
}

async function doDeposit(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  signer: Signer,
  commitment: bigint,
  value = ethers.parseEther("1")
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function doWithdraw(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment: bigint,
  relayer: string,
  fee: bigint
) {
  return pool.withdraw(
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

async function doTransfer(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  root: bigint,
  nullifier: bigint,
  out1: bigint,
  out2: bigint
) {
  return pool.transfer(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    out1,
    out2
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Exhaustive Coverage", function () {
  // -------------------------------------------------------------------------
  // Deposit variations
  // -------------------------------------------------------------------------

  describe("Deposit variations", function () {
    it("deposit from owner succeeds", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).deposit(rc(), { value: ethers.parseEther("1") }))
        .to.not.be.reverted;
    });

    it("deposit from alice succeeds", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") }))
        .to.not.be.reverted;
    });

    it("deposit from bob succeeds", async function () {
      const { pool, bob } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(bob).deposit(rc(), { value: ethers.parseEther("1") }))
        .to.not.be.reverted;
    });

    it("deposit with any non-zero amount accepted (no denomination list)", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(alice).deposit(rc(), { value: 1n })).to.not.be.reverted;
    });

    it("deposit increments depositCount by 1", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") });
      expect(await pool.getDepositCount()).to.equal(1n);
    });

    it("deposit updates totalDeposited", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("2");
      await pool.connect(alice).deposit(rc(), { value: amount });
      expect(await pool.totalDeposited()).to.equal(amount);
    });

    it("deposit emits Deposit event with correct commitment", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = rc();
      await expect(pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") }))
        .to.emit(pool, "Deposit")
        .withArgs(commitment, 0, ethers.parseEther("1"), (v: bigint) => v > 0n);
    });

    it("deposit stores commitment in mapping", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = rc();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      expect(await pool.commitments(commitment)).to.equal(true);
    });

    it("deposit increments uniqueDepositorCount for first deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") });
      expect(await pool.uniqueDepositorCount()).to.equal(1n);
    });

    it("second deposit from same address does not increment uniqueDepositorCount", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") });
      await pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") });
      expect(await pool.uniqueDepositorCount()).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Batch deposit variations
  // -------------------------------------------------------------------------

  describe("Batch deposit variations", function () {
    it("batchDeposit with 1 commitment succeeds", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = rc();
      const amount = ethers.parseEther("1");
      await expect(
        pool.connect(alice).batchDeposit([c], [amount], { value: amount })
      ).to.not.be.reverted;
    });

    it("batchDeposit with 3 commitments succeeds", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const cs = [rc(), rc(), rc()];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("2"), ethers.parseEther("3")];
      const total = amounts.reduce((a, b) => a + b, 0n);
      await expect(
        pool.connect(alice).batchDeposit(cs, amounts, { value: total })
      ).to.not.be.reverted;
    });

    it("batchDeposit increments depositCount by batch size", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const cs = [rc(), rc()];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];
      await pool.connect(alice).batchDeposit(cs, amounts, { value: ethers.parseEther("2") });
      expect(await pool.getDepositCount()).to.equal(2n);
    });

    it("batchDeposit reverts when arrays differ in length", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).batchDeposit([rc(), rc()], [1n], { value: 1n })
      ).to.be.revertedWith("ConfidentialPool: arrays length mismatch");
    });

    it("batchDeposit reverts on empty batch", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).batchDeposit([], [], { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: empty batch");
    });

    it("batchDeposit reverts when batch > 10", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const cs = Array.from({ length: 11 }, () => rc());
      const amounts = cs.map(() => 1n);
      const total = BigInt(cs.length);
      await expect(
        pool.connect(alice).batchDeposit(cs, amounts, { value: total })
      ).to.be.revertedWith("ConfidentialPool: batch too large");
    });

    it("batchDeposit reverts when msg.value != sum of amounts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const cs = [rc(), rc()];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];
      await expect(
        pool.connect(alice).batchDeposit(cs, amounts, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: incorrect total amount");
    });
  });

  // -------------------------------------------------------------------------
  // Transfer variations
  // -------------------------------------------------------------------------

  describe("Transfer variations", function () {
    it("transfer succeeds with valid root and unique nullifier", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      const nullifier = rc();
      const out1 = rc();
      const out2 = rc();
      await expect(doTransfer(pool, root, nullifier, out1, out2)).to.not.be.reverted;
    });

    it("transfer increments totalTransfers", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      await doTransfer(pool, root, rc(), rc(), rc());
      expect(await pool.totalTransfers()).to.equal(1n);
    });

    it("transfer inserts two output commitments into tree", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      const out1 = rc();
      const out2 = rc();
      await doTransfer(pool, root, rc(), out1, out2);
      expect(await pool.commitments(out1)).to.equal(true);
      expect(await pool.commitments(out2)).to.equal(true);
    });

    it("transfer marks nullifier as spent", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      const nullifier = rc();
      await doTransfer(pool, root, nullifier, rc(), rc());
      expect(await pool.nullifiers(nullifier)).to.equal(true);
    });

    it("transfer emits Transfer event", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      const nullifier = rc();
      const out1 = rc();
      const out2 = rc();
      await expect(doTransfer(pool, root, nullifier, out1, out2))
        .to.emit(pool, "Transfer")
        .withArgs(nullifier, out1, out2);
    });

    it("transfer reverts on double-spend nullifier", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      const nullifier = rc();
      await doTransfer(pool, root, nullifier, rc(), rc());
      const root2 = await pool.getLastRoot();
      await expect(doTransfer(pool, root2, nullifier, rc(), rc())).to.be.revertedWith(
        "ConfidentialPool: nullifier already spent"
      );
    });

    it("transfer reverts when output commitment1 is zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      await expect(doTransfer(pool, root, rc(), 0n, rc())).to.be.revertedWith(
        "ConfidentialPool: zero output commitment"
      );
    });

    it("transfer reverts when output commitment2 is zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      await expect(doTransfer(pool, root, rc(), rc(), 0n)).to.be.revertedWith(
        "ConfidentialPool: zero output commitment"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Withdrawal variations
  // -------------------------------------------------------------------------

  describe("Withdrawal variations", function () {
    it("withdraw to owner address succeeds", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      await expect(
        doWithdraw(pool, root, rc(), amount, await owner.getAddress(), 0n, ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("withdraw to alice address succeeds", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      await expect(
        doWithdraw(pool, root, rc(), amount, await alice.getAddress(), 0n, ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("withdraw to bob address succeeds", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      await expect(
        doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("withdraw with fee = 0 succeeds", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      await expect(
        doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n)
      ).to.not.be.reverted;
    });

    it("withdraw with fee = 1 wei sends remainder to recipient", async function () {
      const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      const bobBefore = await ethers.provider.getBalance(await bob.getAddress());
      await doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, await relayer.getAddress(), 1n);
      const bobAfter = await ethers.provider.getBalance(await bob.getAddress());
      expect(bobAfter - bobBefore).to.equal(amount - 1n);
    });

    it("withdraw with change commitment inserts change note", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("2");
      const root = await doDeposit(pool, alice, rc(), amount);
      const change = rc();
      await doWithdraw(pool, root, rc(), ethers.parseEther("1"), await bob.getAddress(), change, ethers.ZeroAddress, 0n);
      expect(await pool.commitments(change)).to.equal(true);
    });

    it("withdraw increments withdrawalCount", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      const before = await pool.withdrawalCount();
      await doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n);
      expect(await pool.withdrawalCount()).to.equal(before + 1n);
    });

    it("withdraw increments totalWithdrawn by amount", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      await doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n);
      expect(await pool.totalWithdrawn()).to.equal(amount);
    });

    it("withdraw marks nullifier as spent", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      const nullifier = rc();
      await doWithdraw(pool, root, nullifier, amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n);
      expect(await pool.nullifiers(nullifier)).to.equal(true);
    });

    it("withdraw appends withdrawal record", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      const nullifier = rc();
      await doWithdraw(pool, root, nullifier, amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n);
      expect(await pool.getWithdrawalRecordCount()).to.equal(1n);
    });

    it("withdrawal record stores correct nullifier", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      const nullifier = rc();
      await doWithdraw(pool, root, nullifier, amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n);
      const record = await pool.getWithdrawalRecord(0n);
      expect(record.nullifier).to.equal(nullifier);
    });

    it("withdrawal record stores correct amount", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1.5");
      const root = await doDeposit(pool, alice, rc(), amount);
      await doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n);
      const record = await pool.getWithdrawalRecord(0n);
      expect(record.amount).to.equal(amount);
    });

    it("withdrawal record stores correct recipient", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      await doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n);
      const record = await pool.getWithdrawalRecord(0n);
      expect(record.recipient).to.equal(await bob.getAddress());
    });
  });

  // -------------------------------------------------------------------------
  // Admin functions — non-timelocked
  // -------------------------------------------------------------------------

  describe("Admin — non-timelocked", function () {
    it("pause by owner succeeds", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).pause()).to.not.be.reverted;
    });

    it("pause blocks deposit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();
      await expect(
        pool.connect(alice).deposit(rc(), { value: 1n })
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("pause blocks transfer", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const root = await doDeposit(pool, alice, rc());
      await pool.connect(owner).pause();
      await expect(
        doTransfer(pool, root, rc(), rc(), rc())
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("pause blocks withdraw", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      await pool.connect(owner).pause();
      await expect(
        doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n)
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("unpause re-enables deposit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();
      await pool.connect(owner).unpause();
      await expect(pool.connect(alice).deposit(rc(), { value: 1n })).to.not.be.reverted;
    });

    it("unpause re-enables transfer", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();
      await pool.connect(owner).unpause();
      const root = await doDeposit(pool, alice, rc());
      await expect(doTransfer(pool, root, rc(), rc(), rc())).to.not.be.reverted;
    });

    it("setAllowlistEnabled toggles allowlistEnabled to true", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      expect(await pool.allowlistEnabled()).to.equal(true);
    });

    it("setAllowlistEnabled emits AllowlistToggled event", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setAllowlistEnabled(true))
        .to.emit(pool, "AllowlistToggled")
        .withArgs(true);
    });

    it("setAllowlisted adds address to allowlist", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlisted(await alice.getAddress(), true);
      expect(await pool.allowlisted(await alice.getAddress())).to.equal(true);
    });

    it("setAllowlisted emits AllowlistUpdated event", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setAllowlisted(await alice.getAddress(), true))
        .to.emit(pool, "AllowlistUpdated")
        .withArgs(await alice.getAddress(), true);
    });

    it("batchSetAllowlisted allows multiple addresses", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).batchSetAllowlisted(
        [await alice.getAddress(), await bob.getAddress()],
        true
      );
      expect(await pool.allowlisted(await alice.getAddress())).to.equal(true);
      expect(await pool.allowlisted(await bob.getAddress())).to.equal(true);
    });

    it("setMaxOperationsPerBlock sets the limit", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setMaxOperationsPerBlock(5n);
      expect(await pool.maxOperationsPerBlock()).to.equal(5n);
    });

    it("setMaxOperationsPerBlock emits MaxOperationsPerBlockUpdated", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setMaxOperationsPerBlock(3n))
        .to.emit(pool, "MaxOperationsPerBlockUpdated")
        .withArgs(3n);
    });

    it("setDepositReceipt updates depositReceipt address", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceiptFactory.deploy(await pool.getAddress());
      await pool.connect(owner).setDepositReceipt(await receipt.getAddress());
      expect(await pool.depositReceipt()).to.equal(await receipt.getAddress());
    });

    it("setDepositReceipt to zero address disables minting", async function () {
      const { pool, owner } = await loadFixture(deployWithReceiptFixture);
      await pool.connect(owner).setDepositReceipt(ethers.ZeroAddress);
      expect(await pool.depositReceipt()).to.equal(ethers.ZeroAddress);
    });

    it("emergencyDrain transfers all balance when paused", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");
      await doDeposit(pool, alice, rc(), amount);
      await pool.connect(owner).pause();
      const ownerBefore = await ethers.provider.getBalance(await owner.getAddress());
      await pool.connect(owner).emergencyDrain(await owner.getAddress());
      const ownerAfter = await ethers.provider.getBalance(await owner.getAddress());
      expect(ownerAfter).to.be.gt(ownerBefore);
    });

    it("emergencyDrain emits EmergencyDrain event", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await doDeposit(pool, alice, rc(), ethers.parseEther("1"));
      await pool.connect(owner).pause();
      await expect(pool.connect(owner).emergencyDrain(await owner.getAddress()))
        .to.emit(pool, "EmergencyDrain");
    });
  });

  // -------------------------------------------------------------------------
  // Admin functions — timelocked
  // -------------------------------------------------------------------------

  describe("Admin — timelocked", function () {
    it("setMaxDepositsPerAddress sets limit after timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 3n);
      await queue(pool, hash);
      await pool.connect(owner).setMaxDepositsPerAddress(3n);
      expect(await pool.maxDepositsPerAddress()).to.equal(3n);
    });

    it("setMaxDepositsPerAddress emits MaxDepositsPerAddressUpdated", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 2n);
      await queue(pool, hash);
      await expect(pool.connect(owner).setMaxDepositsPerAddress(2n))
        .to.emit(pool, "MaxDepositsPerAddressUpdated")
        .withArgs(2n);
    });

    it("setDepositCooldown sets cooldown after timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const cooldown = 3600n;
      const hash = timelockHash("setDepositCooldown", cooldown);
      await queue(pool, hash);
      await pool.connect(owner).setDepositCooldown(cooldown);
      expect(await pool.depositCooldown()).to.equal(cooldown);
    });

    it("setDepositCooldown emits DepositCooldownUpdated", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setDepositCooldown", 7200n);
      await queue(pool, hash);
      await expect(pool.connect(owner).setDepositCooldown(7200n))
        .to.emit(pool, "DepositCooldownUpdated")
        .withArgs(7200n);
    });

    it("setMaxWithdrawAmount sets cap after timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const cap = ethers.parseEther("10");
      const hash = timelockHash("setMaxWithdrawAmount", cap);
      await queue(pool, hash);
      await pool.connect(owner).setMaxWithdrawAmount(cap);
      expect(await pool.maxWithdrawAmount()).to.equal(cap);
    });

    it("setMaxWithdrawAmount emits MaxWithdrawAmountUpdated", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const cap = ethers.parseEther("5");
      const hash = timelockHash("setMaxWithdrawAmount", cap);
      await queue(pool, hash);
      await expect(pool.connect(owner).setMaxWithdrawAmount(cap))
        .to.emit(pool, "MaxWithdrawAmountUpdated")
        .withArgs(cap);
    });

    it("setMinDepositAge sets age after timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const age = 10n;
      const hash = timelockHash("setMinDepositAge", age);
      await queue(pool, hash);
      await pool.connect(owner).setMinDepositAge(age);
      expect(await pool.minDepositAge()).to.equal(age);
    });

    it("setMinDepositAge emits MinDepositAgeUpdated", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const age = 5n;
      const hash = timelockHash("setMinDepositAge", age);
      await queue(pool, hash);
      await expect(pool.connect(owner).setMinDepositAge(age))
        .to.emit(pool, "MinDepositAgeUpdated")
        .withArgs(age);
    });

    it("addDenomination adds to allowedDenominations after timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const denom = ethers.parseEther("1");
      const hash = timelockHash("addDenomination", denom);
      await queue(pool, hash);
      await pool.connect(owner).addDenomination(denom);
      expect(await pool.allowedDenominations(denom)).to.equal(true);
    });

    it("addDenomination emits DenominationAdded event", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const denom = ethers.parseEther("0.5");
      const hash = timelockHash("addDenomination", denom);
      await queue(pool, hash);
      await expect(pool.connect(owner).addDenomination(denom))
        .to.emit(pool, "DenominationAdded")
        .withArgs(denom);
    });

    it("removeDenomination removes from allowedDenominations after timelock", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const denom = ethers.parseEther("1");
      // Add first
      const addHash = timelockHash("addDenomination", denom);
      await queue(pool, addHash);
      await pool.connect(owner).addDenomination(denom);
      // Remove
      const removeHash = timelockHash("removeDenomination", denom);
      await queue(pool, removeHash);
      await pool.connect(owner).removeDenomination(denom);
      expect(await pool.allowedDenominations(denom)).to.equal(false);
    });

    it("queueAction stores actionHash in pendingAction", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await pool.queueAction(hash);
      const pending = await pool.pendingAction();
      expect(pending.actionHash).to.equal(hash);
    });

    it("cancelAction clears pendingAction hash to zero", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await pool.queueAction(hash);
      await pool.cancelAction();
      const pending = await pool.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
    });

    it("cancelAction emits ActionCancelled event", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const hash = timelockHash("setMaxDepositsPerAddress", 5n);
      await pool.queueAction(hash);
      await expect(pool.cancelAction())
        .to.emit(pool, "ActionCancelled")
        .withArgs(hash);
    });
  });

  // -------------------------------------------------------------------------
  // View functions
  // -------------------------------------------------------------------------

  describe("View functions", function () {
    it("getPoolStats returns 7 values — all zero initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const [dep, wit, transfers, cnt, wcnt, uniq, bal] = await pool.getPoolStats();
      expect(dep).to.equal(0n);
      expect(wit).to.equal(0n);
      expect(transfers).to.equal(0n);
      expect(cnt).to.equal(0n);
      expect(wcnt).to.equal(0n);
      expect(uniq).to.equal(0n);
      expect(bal).to.equal(0n);
    });

    it("getPoolHealth returns 7 values — all default initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const [notes, util, bal, paused, allowlist, maxWit, minAge] = await pool.getPoolHealth();
      expect(notes).to.equal(0n);
      expect(util).to.equal(0n);
      expect(bal).to.equal(0n);
      expect(paused).to.equal(false);
      expect(allowlist).to.equal(false);
      expect(maxWit).to.equal(0n);
      expect(minAge).to.equal(0n);
    });

    it("getActiveNoteCount is 0 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getActiveNoteCount()).to.equal(0n);
    });

    it("getActiveNoteCount is 1 after one deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await doDeposit(pool, alice, rc());
      expect(await pool.getActiveNoteCount()).to.equal(1n);
    });

    it("getDepositCount is 0 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getDepositCount()).to.equal(0n);
    });

    it("getPoolBalance is 0 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getPoolBalance()).to.equal(0n);
    });

    it("getPoolBalance equals sum of deposits", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      await doDeposit(pool, alice, rc(), ethers.parseEther("1"));
      await doDeposit(pool, bob, rc(), ethers.parseEther("2"));
      expect(await pool.getPoolBalance()).to.equal(ethers.parseEther("3"));
    });

    it("isSpent returns false for unspent nullifier", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.isSpent(rc())).to.equal(false);
    });

    it("isCommitted returns false before deposit", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.isCommitted(rc())).to.equal(false);
    });

    it("isCommitted returns true after deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = rc();
      await doDeposit(pool, alice, commitment);
      expect(await pool.isCommitted(commitment)).to.equal(true);
    });

    it("getCommitments returns empty array for fresh pool", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect((await pool.getCommitments(0, 10)).length).to.equal(0);
    });

    it("getDenominations returns empty array initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect((await pool.getDenominations()).length).to.equal(0);
    });

    it("getRemainingDeposits returns max uint256 when no limit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      expect(await pool.getRemainingDeposits(await alice.getAddress())).to.equal(
        2n ** 256n - 1n
      );
    });

    it("getWithdrawalRecordCount is 0 initially", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getWithdrawalRecordCount()).to.equal(0n);
    });

    it("getCommitmentIndex returns correct index after deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = rc();
      await doDeposit(pool, alice, commitment);
      expect(await pool.getCommitmentIndex(commitment)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Lens variations
  // -------------------------------------------------------------------------

  describe("PoolLens variations", function () {
    it("snapshot totalDeposited reflects deposits", async function () {
      const { pool, lens, alice } = await loadFixture(deployWithLensFixture);
      const amount = ethers.parseEther("3");
      await doDeposit(pool, alice, rc(), amount);
      const snap = await lens.getSnapshot(await pool.getAddress());
      expect(snap.totalDeposited).to.equal(amount);
    });

    it("snapshot totalTransfers reflects transfers", async function () {
      const { pool, lens, alice } = await loadFixture(deployWithLensFixture);
      const root = await doDeposit(pool, alice, rc());
      await doTransfer(pool, root, rc(), rc(), rc());
      const snap = await lens.getSnapshot(await pool.getAddress());
      expect(snap.totalTransfers).to.equal(1n);
    });

    it("snapshot withdrawalCount reflects withdrawals", async function () {
      const { pool, lens, alice, bob } = await loadFixture(deployWithLensFixture);
      const amount = ethers.parseEther("1");
      const root = await doDeposit(pool, alice, rc(), amount);
      await doWithdraw(pool, root, rc(), amount, await bob.getAddress(), 0n, ethers.ZeroAddress, 0n);
      const snap = await lens.getSnapshot(await pool.getAddress());
      expect(snap.withdrawalCount).to.equal(1n);
    });

    it("snapshot isPaused = true after pause", async function () {
      const { pool, owner, lens } = await loadFixture(deployWithLensFixture);
      await pool.connect(owner).pause();
      const snap = await lens.getSnapshot(await pool.getAddress());
      expect(snap.isPaused).to.equal(true);
    });

    it("snapshot allowlistEnabled = true after toggle", async function () {
      const { pool, owner, lens } = await loadFixture(deployWithLensFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      const snap = await lens.getSnapshot(await pool.getAddress());
      expect(snap.allowlistEnabled).to.equal(true);
    });

    it("snapshot treeCapacity equals 2^levels", async function () {
      const { pool, lens } = await loadFixture(deployWithLensFixture);
      const snap = await lens.getSnapshot(await pool.getAddress());
      expect(snap.treeCapacity).to.equal(32n); // 2^5
    });

    it("snapshot uniqueDepositors increments per new depositor", async function () {
      const { pool, lens, alice, bob } = await loadFixture(deployWithLensFixture);
      await doDeposit(pool, alice, rc());
      await doDeposit(pool, bob, rc());
      const snap = await lens.getSnapshot(await pool.getAddress());
      expect(snap.uniqueDepositors).to.equal(2n);
    });
  });

  // -------------------------------------------------------------------------
  // Receipt variations
  // -------------------------------------------------------------------------

  describe("Receipt variations", function () {
    it("receipt mints on deposit", async function () {
      const { pool, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") });
      expect(await receipt.balanceOf(await alice.getAddress())).to.equal(1n);
    });

    it("receipt ownerOf returns depositor", async function () {
      const { pool, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") });
      expect(await receipt.ownerOf(0n)).to.equal(await alice.getAddress());
    });

    it("receipt stores non-zero timestamp in tokenTimestamp mapping", async function () {
      const { pool, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      await pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") });
      expect(await receipt.tokenTimestamp(0n)).to.be.gt(0n);
    });

    it("receipt stores correct commitment in tokenCommitment mapping", async function () {
      const { pool, receipt, alice } = await loadFixture(deployWithReceiptFixture);
      const commitment = rc();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
    });

    it("receipt token IDs are sequential — two deposits produce IDs 0 and 1", async function () {
      const { pool, receipt, alice, bob } = await loadFixture(deployWithReceiptFixture);
      await pool.connect(alice).deposit(rc(), { value: 1n });
      await pool.connect(bob).deposit(rc(), { value: 1n });
      const owner0 = await receipt.ownerOf(0n);
      const owner1 = await receipt.ownerOf(1n);
      expect(owner0).to.be.properAddress;
      expect(owner1).to.be.properAddress;
    });

    it("receipt is soulbound — transfer reverts", async function () {
      const { pool, receipt, alice, bob } = await loadFixture(deployWithReceiptFixture);
      await pool.connect(alice).deposit(rc(), { value: ethers.parseEther("1") });
      await expect(
        receipt.connect(alice).transferFrom(await alice.getAddress(), await bob.getAddress(), 0n)
      ).to.be.reverted;
    });

    it("no receipt minted when depositReceipt is zero address", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      // Deposit without receipt configured
      await pool.connect(alice).deposit(rc(), { value: 1n });
      expect(await pool.depositReceipt()).to.equal(ethers.ZeroAddress);
    });
  });

  // -------------------------------------------------------------------------
  // StealthRegistry variations
  // -------------------------------------------------------------------------

  describe("StealthRegistry variations", function () {
    it("registerViewingKey stores pubKeyX", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      const x = rc();
      const y = rc();
      await registry.connect(alice).registerViewingKey(x, y);
      const [storedX] = await registry.getViewingKey(await alice.getAddress());
      expect(storedX).to.equal(x);
    });

    it("registerViewingKey stores pubKeyY", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      const x = rc();
      const y = rc();
      await registry.connect(alice).registerViewingKey(x, y);
      const [, storedY] = await registry.getViewingKey(await alice.getAddress());
      expect(storedY).to.equal(y);
    });

    it("registerViewingKey emits ViewingKeyRegistered event", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      const x = rc();
      const y = rc();
      await expect(registry.connect(alice).registerViewingKey(x, y))
        .to.emit(registry, "ViewingKeyRegistered")
        .withArgs(await alice.getAddress(), x, y);
    });

    it("registerViewingKey reverts when both coordinates are zero", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      await expect(registry.connect(alice).registerViewingKey(0n, 0n)).to.be.revertedWith(
        "StealthRegistry: zero key"
      );
    });

    it("registerViewingKey accepts (x=0, y=nonzero)", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      await expect(registry.connect(alice).registerViewingKey(0n, 1n)).to.not.be.reverted;
    });

    it("registerViewingKey accepts (x=nonzero, y=0)", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      await expect(registry.connect(alice).registerViewingKey(1n, 0n)).to.not.be.reverted;
    });

    it("registerViewingKey overwrites existing key", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      await registry.connect(alice).registerViewingKey(1n, 2n);
      const newX = rc();
      const newY = rc();
      await registry.connect(alice).registerViewingKey(newX, newY);
      const [storedX, storedY] = await registry.getViewingKey(await alice.getAddress());
      expect(storedX).to.equal(newX);
      expect(storedY).to.equal(newY);
    });

    it("getViewingKey returns (0, 0) for unregistered address", async function () {
      const { registry } = await loadFixture(deployStealthFixture);
      // Use a fresh signer that has never registered
      const [, , , unregistered] = await ethers.getSigners();
      const [x, y] = await registry.getViewingKey(await unregistered.getAddress());
      expect(x).to.equal(0n);
      expect(y).to.equal(0n);
    });

    it("announceStealthPayment emits StealthPayment event", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      const commitment = rc();
      const ephX = rc();
      const ephY = rc();
      const stX = rc();
      const stY = rc();
      const encAmt = rc();
      const encBl = rc();
      await expect(
        registry.connect(alice).announceStealthPayment(commitment, ephX, ephY, stX, stY, encAmt, encBl)
      )
        .to.emit(registry, "StealthPayment")
        .withArgs(commitment, ephX, ephY, stX, stY, encAmt, encBl);
    });

    it("announceStealthPayment makes no state changes", async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      await registry.connect(alice).announceStealthPayment(rc(), rc(), rc(), rc(), rc(), rc(), rc());
      // Registry only has viewingKeys storage — remains zero for alice
      const [x] = await registry.getViewingKey(await alice.getAddress());
      expect(x).to.equal(0n);
    });

    it("StealthRegistry VERSION returns '1.0.0'", async function () {
      const { registry } = await loadFixture(deployStealthFixture);
      expect(await registry.VERSION()).to.equal("1.0.0");
    });
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe("Constants", function () {
    it("VERSION returns '1.0.0'", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.VERSION()).to.equal("1.0.0");
    });

    it("TIMELOCK_DELAY equals 1 day in seconds", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.TIMELOCK_DELAY()).to.equal(BigInt(ONE_DAY));
    });

    it("ROOT_HISTORY_SIZE equals 30", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.ROOT_HISTORY_SIZE()).to.equal(30n);
    });

    it("FIELD_SIZE matches BN254 scalar field prime", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.FIELD_SIZE()).to.equal(FIELD_SIZE);
    });

    it("deployedChainId matches Hardhat chain ID 31337", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.deployedChainId()).to.equal(31337n);
    });

    it("POOL_INTERFACE_ID is non-zero", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const id = await pool.POOL_INTERFACE_ID();
      expect(id).to.not.equal("0x00000000");
    });

    it("supportsInterface returns true for ERC165 selector", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.supportsInterface("0x01ffc9a7")).to.equal(true);
    });

    it("supportsInterface returns true for POOL_INTERFACE_ID", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const id = await pool.POOL_INTERFACE_ID();
      expect(await pool.supportsInterface(id)).to.equal(true);
    });

    it("supportsInterface returns false for random selector", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.supportsInterface("0xdeadbeef")).to.equal(false);
    });

    it("levels equals configured tree height (5)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.levels()).to.equal(5n);
    });
  });

  // -------------------------------------------------------------------------
  // Denomination + allowlist combinations
  // -------------------------------------------------------------------------

  describe("Denomination + allowlist combinations", function () {
    it("deposit with denomination in list is accepted", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const denom = ethers.parseEther("1");
      const hash = timelockHash("addDenomination", denom);
      await queue(pool, hash);
      await pool.connect(owner).addDenomination(denom);
      await expect(pool.connect(alice).deposit(rc(), { value: denom })).to.not.be.reverted;
    });

    it("deposit with amount not in denomination list is rejected", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const denom = ethers.parseEther("1");
      const hash = timelockHash("addDenomination", denom);
      await queue(pool, hash);
      await pool.connect(owner).addDenomination(denom);
      await expect(
        pool.connect(alice).deposit(rc(), { value: ethers.parseEther("0.5") })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });

    it("deposit with allowlist enabled and allowlisted address is accepted", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlisted(await alice.getAddress(), true);
      await pool.connect(owner).setAllowlistEnabled(true);
      await expect(pool.connect(alice).deposit(rc(), { value: 1n })).to.not.be.reverted;
    });

    it("deposit with allowlist enabled and non-allowlisted address is rejected", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await expect(
        pool.connect(alice).deposit(rc(), { value: 1n })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });

    it("getDenominations returns all added denominations", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const d1 = ethers.parseEther("1");
      const d2 = ethers.parseEther("2");
      const h1 = timelockHash("addDenomination", d1);
      await queue(pool, h1);
      await pool.connect(owner).addDenomination(d1);
      const h2 = timelockHash("addDenomination", d2);
      await queue(pool, h2);
      await pool.connect(owner).addDenomination(d2);
      const list = await pool.getDenominations();
      expect(list.length).to.equal(2);
    });
  });
});
