import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

const ONE_DAY = 24 * 60 * 60;

// Produces a random field element (31 bytes ensures < FIELD_SIZE)
function randomCommitment(): bigint {
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
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
    5,
    hasherAddress
  );

  return { pool, owner, alice, bob, relayer };
}

async function deployStealthFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();
  return { registry, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function depositAndGetRoot(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint = ethers.parseEther("1")
) {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

/** Queues a timelocked action and advances time past the 1-day delay. */
async function timelockQueue(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  actionHash: string
) {
  await pool.queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      [name, value]
    )
  );
}

// ---------------------------------------------------------------------------
// Event Emission Tests
// ---------------------------------------------------------------------------

describe("Event Emission", function () {
  // -------------------------------------------------------------------------
  // deposit — Deposit event
  // -------------------------------------------------------------------------

  it("deposit emits Deposit event with amount and commitment", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();
    const amount = ethers.parseEther("1");

    await expect(pool.connect(alice).deposit(commitment, { value: amount }))
      .to.emit(pool, "Deposit")
      .withArgs(
        commitment,
        0n,        // leafIndex: first deposit
        amount,
        (v: bigint) => v > 0n // timestamp
      );
  });

  // -------------------------------------------------------------------------
  // transfer — Transfer event
  // -------------------------------------------------------------------------

  it("transfer emits Transfer event with nullifier and 2 output commitments", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();
    const root = await depositAndGetRoot(pool, alice, commitment);
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    await expect(
      pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      )
    )
      .to.emit(pool, "Transfer")
      .withArgs(nullifier, out1, out2);
  });

  // -------------------------------------------------------------------------
  // withdrawal — Withdrawal event (all 6 fields)
  // -------------------------------------------------------------------------

  it("withdrawal emits Withdrawal event with all 6 fields", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);
    const depositAmount = ethers.parseEther("1");
    const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);
    const nullifier = randomCommitment();
    const withdrawAmount = ethers.parseEther("0.9");
    const fee = ethers.parseEther("0.1");
    const changeCommitment = 0n;

    await expect(
      pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        withdrawAmount,
        bob.address,
        changeCommitment,
        relayer.address,
        fee
      )
    )
      .to.emit(pool, "Withdrawal")
      .withArgs(
        nullifier,
        withdrawAmount,
        bob.address,
        changeCommitment,
        relayer.address,
        fee
      );
  });

  // -------------------------------------------------------------------------
  // batchDeposit(3) — exactly 3 Deposit events
  // -------------------------------------------------------------------------

  it("batchDeposit(3) emits exactly 3 Deposit events", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const amount = ethers.parseEther("1");

    const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
    const amounts = [amount, amount, amount];
    const total = amount * 3n;

    const tx = await pool
      .connect(alice)
      .batchDeposit(commitments, amounts, { value: total });
    const receipt = await tx.wait();

    const poolAddress = await pool.getAddress();
    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const depositLogs = receipt!.logs.filter(
      (log) =>
        log.address.toLowerCase() === poolAddress.toLowerCase() &&
        log.topics[0] === depositTopic
    );

    expect(depositLogs).to.have.length(3);

    // Each log should decode with distinct leaf indices (0, 1, 2)
    for (let i = 0; i < 3; i++) {
      const parsed = pool.interface.parseLog(depositLogs[i]);
      expect(parsed!.args[1]).to.equal(BigInt(i)); // leafIndex
      expect(parsed!.args[2]).to.equal(amount);    // amount
    }
  });

  // -------------------------------------------------------------------------
  // addDenomination — DenominationAdded event
  // -------------------------------------------------------------------------

  it("addDenomination emits DenominationAdded", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    const denom = ethers.parseEther("0.5");
    const hash = timelockHash("addDenomination", denom);

    await timelockQueue(pool.connect(owner), hash);

    await expect(pool.connect(owner).addDenomination(denom))
      .to.emit(pool, "DenominationAdded")
      .withArgs(denom);
  });

  // -------------------------------------------------------------------------
  // setAllowlistEnabled — AllowlistToggled event
  // -------------------------------------------------------------------------

  it("setAllowlistEnabled emits AllowlistToggled", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    await expect(pool.connect(owner).setAllowlistEnabled(true))
      .to.emit(pool, "AllowlistToggled")
      .withArgs(true);

    await expect(pool.connect(owner).setAllowlistEnabled(false))
      .to.emit(pool, "AllowlistToggled")
      .withArgs(false);
  });

  // -------------------------------------------------------------------------
  // emergencyDrain — EmergencyDrain with correct amount
  // -------------------------------------------------------------------------

  it("emergencyDrain emits EmergencyDrain with correct amount", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);
    const depositAmount = ethers.parseEther("2");

    await pool.connect(alice).deposit(randomCommitment(), { value: depositAmount });

    // Must pause first
    await pool.connect(owner).pause();

    await expect(pool.connect(owner).emergencyDrain(owner.address))
      .to.emit(pool, "EmergencyDrain")
      .withArgs(owner.address, depositAmount);
  });

  // -------------------------------------------------------------------------
  // stealth announcement — StealthPayment with 7 fields
  // -------------------------------------------------------------------------

  it("stealth announcement emits StealthPayment with 7 fields", async function () {
    const { registry, alice } = await loadFixture(deployStealthFixture);

    const commitment = randomCommitment();
    const ephemeralX = randomCommitment();
    const ephemeralY = randomCommitment();
    const stealthX = randomCommitment();
    const stealthY = randomCommitment();
    const encAmount = randomCommitment();
    const encBlinding = randomCommitment();

    await expect(
      registry
        .connect(alice)
        .announceStealthPayment(
          commitment,
          ephemeralX,
          ephemeralY,
          stealthX,
          stealthY,
          encAmount,
          encBlinding
        )
    )
      .to.emit(registry, "StealthPayment")
      .withArgs(
        commitment,
        ephemeralX,
        ephemeralY,
        stealthX,
        stealthY,
        encAmount,
        encBlinding
      );
  });

  // -------------------------------------------------------------------------
  // timelock: queue then cancel emits ActionQueued then ActionCancelled
  // -------------------------------------------------------------------------

  it("timelock queue/cancel emits ActionQueued then ActionCancelled", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    const hash = timelockHash("setMinDepositAge", 100n);

    // queue → ActionQueued
    await expect(pool.connect(owner).queueAction(hash))
      .to.emit(pool, "ActionQueued")
      .withArgs(hash, (v: bigint) => v > 0n);

    // cancel → ActionCancelled
    await expect(pool.connect(owner).cancelAction())
      .to.emit(pool, "ActionCancelled")
      .withArgs(hash);
  });

  // -------------------------------------------------------------------------
  // deposit cooldown update emits MinDepositAgeUpdated
  // NOTE: The task spec mentions "DepositCooldownUpdated" but the contract
  //       emits MinDepositAgeUpdated from setMinDepositAge. DepositCooldownUpdated
  //       is declared in the ABI but has no setter that emits it.
  //       See NIGHT_SHIFT_PROBLEMS.md for details.
  // -------------------------------------------------------------------------

  it("deposit cooldown update emits MinDepositAgeUpdated", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    const newAge = 10n;
    const hash = timelockHash("setMinDepositAge", newAge);

    await timelockQueue(pool.connect(owner), hash);

    await expect(pool.connect(owner).setMinDepositAge(newAge))
      .to.emit(pool, "MinDepositAgeUpdated")
      .withArgs(newAge);
  });
});
