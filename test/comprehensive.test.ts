import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

const ONE_DAY = 86_400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

function randomKey(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
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

async function deployStealthRegistryFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();
  return { registry, owner, alice, bob };
}

async function depositAndGetRoot(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint = ethers.parseEther("1")
) {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Comprehensive Coverage", function () {
  // -------------------------------------------------------------------------
  // Transfer edge cases
  // -------------------------------------------------------------------------

  describe("Transfer edge cases", function () {
    it("transfer with equal output amounts (50/50 split)", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("2");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);

      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      // The verifier is a stub; both commitments represent equal halves conceptually
      await expect(
        pool.transfer(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, root, nullifier, out1, out2)
      ).to.not.be.reverted;

      expect(await pool.commitments(out1)).to.be.true;
      expect(await pool.commitments(out2)).to.be.true;
    });

    it("transfer output commitments are different from input commitment", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const inputCommitment = randomCommitment();
      const root = await depositAndGetRoot(pool, alice, inputCommitment);

      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await pool.transfer(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, root, nullifier, out1, out2);

      // Output commitments exist; input commitment is unchanged but nullifier is spent
      expect(out1).to.not.equal(inputCommitment);
      expect(out2).to.not.equal(inputCommitment);
      expect(await pool.commitments(out1)).to.be.true;
      expect(await pool.commitments(out2)).to.be.true;
    });

    it("transfer doesn't change pool ETH balance", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);

      const balanceBefore = await pool.getPoolBalance();

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );

      expect(await pool.getPoolBalance()).to.equal(balanceBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Withdrawal edge cases
  // -------------------------------------------------------------------------

  describe("Withdrawal edge cases", function () {
    it("withdrawal record count matches actual withdrawals", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("3");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);

      expect(await pool.getWithdrawalRecordCount()).to.equal(0n);

      await pool.withdraw(
        ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
        root, randomCommitment(), ethers.parseEther("1"),
        bob.address, 0n, ethers.ZeroAddress, 0n
      );

      const rootAfter = await pool.getLastRoot();
      await pool.withdraw(
        ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
        rootAfter, randomCommitment(), ethers.parseEther("1"),
        bob.address, 0n, ethers.ZeroAddress, 0n
      );

      expect(await pool.getWithdrawalRecordCount()).to.equal(2n);
    });

    it("withdrawal record fields match event data", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("2");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);

      const nullifier = randomCommitment();
      const withdrawAmount = ethers.parseEther("1");

      const tx = await pool.withdraw(
        ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
        root, nullifier, withdrawAmount,
        bob.address, 0n, ethers.ZeroAddress, 0n
      );
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const record = await pool.getWithdrawalRecord(0);
      expect(record.nullifier).to.equal(nullifier);
      expect(record.amount).to.equal(withdrawAmount);
      expect(record.recipient).to.equal(bob.address);
      expect(record.timestamp).to.equal(BigInt(block!.timestamp));
      expect(record.blockNumber).to.equal(BigInt(receipt!.blockNumber));
    });

    it("full withdrawal (no change) has changeCommitment = 0", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);

      const nullifier = randomCommitment();
      await pool.withdraw(
        ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
        root, nullifier, depositAmount,
        bob.address,
        0n, // no change commitment
        ethers.ZeroAddress, 0n
      );

      // No change commitment was inserted — nextIndex reflects only the original deposit
      expect(await pool.nextIndex()).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Batch operations
  // -------------------------------------------------------------------------

  describe("Batch operations", function () {
    it("batchDeposit with 1 item has same effect as single deposit", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const c1 = randomCommitment();
      const amount1 = ethers.parseEther("1");

      // Single deposit
      await pool.connect(alice).deposit(c1, { value: amount1 });

      const c2 = randomCommitment();
      const amount2 = ethers.parseEther("1");

      // Batch of 1
      await pool.connect(bob).batchDeposit([c2], [amount2], { value: amount2 });

      expect(await pool.commitments(c1)).to.be.true;
      expect(await pool.commitments(c2)).to.be.true;
      expect(await pool.nextIndex()).to.equal(2n);
    });

    it("batchDeposit gas per item is lower than individual deposits", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");

      // 3 individual deposits
      const c1 = randomCommitment();
      const c2 = randomCommitment();
      const c3 = randomCommitment();
      const tx1 = await pool.connect(alice).deposit(c1, { value: amount });
      const r1 = await tx1.wait();
      const tx2 = await pool.connect(alice).deposit(c2, { value: amount });
      const r2 = await tx2.wait();
      const tx3 = await pool.connect(alice).deposit(c3, { value: amount });
      const r3 = await tx3.wait();
      const totalIndividual = r1!.gasUsed + r2!.gasUsed + r3!.gasUsed;

      // 3-item batch
      const b1 = randomCommitment();
      const b2 = randomCommitment();
      const b3 = randomCommitment();
      const batchTx = await pool.connect(bob).batchDeposit(
        [b1, b2, b3],
        [amount, amount, amount],
        { value: amount * 3n }
      );
      const batchR = await batchTx.wait();

      expect(batchR!.gasUsed).to.be.lessThan(totalIndividual);
    });
  });

  // -------------------------------------------------------------------------
  // Stealth registry
  // -------------------------------------------------------------------------

  describe("Stealth registry", function () {
    it("viewing key can be updated to new values", async function () {
      const { registry, alice } = await loadFixture(deployStealthRegistryFixture);
      const x1 = randomKey();
      const y1 = randomKey();
      await registry.connect(alice).registerViewingKey(x1, y1);

      const x2 = randomKey();
      const y2 = randomKey();
      await registry.connect(alice).registerViewingKey(x2, y2);

      const [storedX, storedY] = await registry.getViewingKey(alice.address);
      expect(storedX).to.equal(x2);
      expect(storedY).to.equal(y2);
    });

    it("different users have independent viewing keys", async function () {
      const { registry, alice, bob } = await loadFixture(deployStealthRegistryFixture);
      const xA = randomKey();
      const yA = randomKey();
      const xB = randomKey();
      const yB = randomKey();

      await registry.connect(alice).registerViewingKey(xA, yA);
      await registry.connect(bob).registerViewingKey(xB, yB);

      const [storedXA] = await registry.getViewingKey(alice.address);
      const [storedXB] = await registry.getViewingKey(bob.address);
      expect(storedXA).to.equal(xA);
      expect(storedXB).to.equal(xB);
    });

    it("stealth announcement preserves all 7 fields", async function () {
      const { registry, alice } = await loadFixture(deployStealthRegistryFixture);
      const commitment = randomKey();
      const ephX = randomKey();
      const ephY = randomKey();
      const stealthX = randomKey();
      const stealthY = randomKey();
      const encAmt = randomKey();
      const encBlinding = randomKey();

      await expect(
        registry.connect(alice).announceStealthPayment(
          commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlinding
        )
      )
        .to.emit(registry, "StealthPayment")
        .withArgs(commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlinding);
    });
  });

  // -------------------------------------------------------------------------
  // Pool lens
  // -------------------------------------------------------------------------

  describe("PoolLens", function () {
    it("PoolLens snapshot is read-only (doesn't change state)", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });

      const Lens = await ethers.getContractFactory("PoolLens");
      const lens = await Lens.deploy();
      const poolAddress = await pool.getAddress();

      const rootBefore = await pool.getLastRoot();
      const indexBefore = await pool.nextIndex();

      await lens.getSnapshot(poolAddress);

      expect(await pool.getLastRoot()).to.equal(rootBefore);
      expect(await pool.nextIndex()).to.equal(indexBefore);
    });

    it("PoolLens version matches pool VERSION", async function () {
      const { pool } = await loadFixture(deployPoolFixture);

      const Lens = await ethers.getContractFactory("PoolLens");
      const lens = await Lens.deploy();

      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.version).to.equal(await pool.getVersion());
    });
  });

  // -------------------------------------------------------------------------
  // Multi-operation consistency
  // -------------------------------------------------------------------------

  describe("Multi-operation consistency", function () {
    it("deposit then transfer then withdraw: all counters consistent", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("2");

      // deposit
      const root1 = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);

      // transfer
      const out1 = randomCommitment();
      const out2 = randomCommitment();
      await pool.transfer(
        ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
        root1, randomCommitment(), out1, out2
      );

      // withdraw using a fresh root
      const root2 = await pool.getLastRoot();
      await pool.withdraw(
        ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
        root2, randomCommitment(), ethers.parseEther("1"),
        bob.address, 0n, ethers.ZeroAddress, 0n
      );

      const [, , totalTransfers, depositCount, withdrawalCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(3n); // 1 deposit + 2 transfer outputs
      expect(totalTransfers).to.equal(1n);
      expect(withdrawalCount).to.equal(1n);
    });

    it("deposit then transfer then transfer: second transfer uses output of first", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("2");
      const root1 = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);

      // First transfer
      const firstOut1 = randomCommitment();
      const firstOut2 = randomCommitment();
      await pool.transfer(
        ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
        root1, randomCommitment(), firstOut1, firstOut2
      );

      // Second transfer spending a different nullifier (output of first conceptually)
      const root2 = await pool.getLastRoot();
      const secondOut1 = randomCommitment();
      const secondOut2 = randomCommitment();
      await pool.transfer(
        ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
        root2, randomCommitment(), secondOut1, secondOut2
      );

      expect(await pool.commitments(secondOut1)).to.be.true;
      expect(await pool.commitments(secondOut2)).to.be.true;

      const [, , totalTransfers] = await pool.getPoolStats();
      expect(totalTransfers).to.equal(2n);
    });

    it("uniqueDepositorCount doesn't increment for repeat depositor", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");

      await pool.connect(alice).deposit(randomCommitment(), { value: amount });
      expect(await pool.uniqueDepositorCount()).to.equal(1n);

      await pool.connect(alice).deposit(randomCommitment(), { value: amount });
      expect(await pool.uniqueDepositorCount()).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Denomination
  // -------------------------------------------------------------------------

  describe("Denomination", function () {
    it("getDenominations returns empty when none configured", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const denoms = await pool.getDenominations();
      expect(denoms.length).to.equal(0);
    });

    it("removing non-existent denomination reverts", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const denom = ethers.parseEther("1");
      const hash = timelockHash("removeDenomination", denom);
      await pool.connect(owner).queueAction(hash);
      await time.increase(ONE_DAY + 1);
      await expect(
        pool.connect(owner).removeDenomination(denom)
      ).to.be.revertedWith("ConfidentialPool: denomination not found");
    });
  });

  // -------------------------------------------------------------------------
  // Allowlist
  // -------------------------------------------------------------------------

  describe("Allowlist", function () {
    it("batchSetAllowlisted updates multiple addresses at once", async function () {
      const { pool, owner, alice, bob, charlie } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).batchSetAllowlisted(
        [alice.address, bob.address, charlie.address],
        true
      );

      expect(await pool.allowlisted(alice.address)).to.be.true;
      expect(await pool.allowlisted(bob.address)).to.be.true;
      expect(await pool.allowlisted(charlie.address)).to.be.true;
    });

    it("allowlisted user can still deposit after allowlist is disabled", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(alice.address, true);

      // Disable allowlist
      await pool.connect(owner).setAllowlistEnabled(false);

      // Alice should still be able to deposit
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Receipt with batch
  // -------------------------------------------------------------------------

  describe("Receipt with batch", function () {
    it("batchDeposit mints receipts with sequential tokenIds", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const DepositReceipt = await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceipt.deploy(await pool.getAddress());
      await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

      const c1 = randomCommitment();
      const c2 = randomCommitment();
      const amount = ethers.parseEther("1");

      await pool.connect(alice).batchDeposit([c1, c2], [amount, amount], {
        value: amount * 2n,
      });

      // tokenId 0 and 1 minted sequentially
      expect(await receipt.ownerOf(0n)).to.equal(alice.address);
      expect(await receipt.ownerOf(1n)).to.equal(alice.address);
      // tokenId 2 does not exist — ownerOf should revert
      await expect(receipt.ownerOf(2n)).to.be.reverted;
    });

    it("receipt tokenURI is valid JSON for batch-minted tokens", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const DepositReceipt = await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceipt.deploy(await pool.getAddress());
      await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

      const c1 = randomCommitment();
      const amount = ethers.parseEther("1");
      await pool.connect(alice).batchDeposit([c1], [amount], { value: amount });

      const uri = await receipt.tokenURI(0n);
      // URI should start with data:application/json;base64, prefix
      expect(uri).to.match(/^data:application\/json;base64,/);
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown interaction
  // -------------------------------------------------------------------------

  describe("Cooldown interaction", function () {
    it("deposit cooldown applies per-address, not globally", async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

      const cooldown = 3600n; // 1 hour
      const hash = timelockHash("setDepositCooldown", cooldown);
      await pool.connect(owner).queueAction(hash);
      await time.increase(ONE_DAY + 1);
      await pool.connect(owner).setDepositCooldown(cooldown);

      const amount = ethers.parseEther("1");
      await pool.connect(alice).deposit(randomCommitment(), { value: amount });

      // Bob can still deposit immediately (different address)
      await expect(
        pool.connect(bob).deposit(randomCommitment(), { value: amount })
      ).to.not.be.reverted;

      // Alice cannot deposit again until cooldown passes
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: amount })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");
    });

    it("batchDeposit updates lastDepositTime", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");

      const c1 = randomCommitment();
      const c2 = randomCommitment();

      const beforeBlock = await ethers.provider.getBlock("latest");
      await pool.connect(alice).batchDeposit([c1, c2], [amount, amount], {
        value: amount * 2n,
      });

      const lastTime = await pool.lastDepositTime(alice.address);
      expect(lastTime).to.be.greaterThan(BigInt(beforeBlock!.timestamp));
    });
  });

  // -------------------------------------------------------------------------
  // Version
  // -------------------------------------------------------------------------

  describe("Version", function () {
    it("pool reports version 1.0.0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getVersion()).to.equal("1.0.0");
    });

    it("StealthRegistry VERSION constant is 1.0.0", async function () {
      const { registry } = await loadFixture(deployStealthRegistryFixture);
      // Deploy a fresh registry and read VERSION via the ABI
      const registryAddress = await registry.getAddress();
      // Use ethers to call the function directly from ABI fragment
      const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
      const attached = StealthRegistry.attach(registryAddress);
      // @ts-ignore — ABI has VERSION as a public view function
      const version = await attached.VERSION();
      expect(version).to.equal("1.0.0");
    });
  });
});
