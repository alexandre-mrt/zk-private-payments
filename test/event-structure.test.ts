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

const MERKLE_TREE_HEIGHT = 5;
const ONE_DAY = 24 * 60 * 60;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
}

type PoolFixture = Awaited<ReturnType<typeof deployPoolFixture>>;

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

async function deployStealthFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();
  return { registry, owner, alice, bob };
}

/** Deposits and returns the Merkle root. */
async function depositAndGetRoot(
  pool: PoolFixture["pool"],
  signer: PoolFixture["alice"],
  commitment: bigint,
  value = ethers.parseEther("1")
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      [name, value]
    )
  );
}

async function timelockQueue(
  pool: PoolFixture["pool"],
  hash: string
): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Event Structure & Topic Encoding Tests
// ---------------------------------------------------------------------------

describe("Event Structure", function () {
  // -------------------------------------------------------------------------
  // Deposit event — indexed commitment
  // -------------------------------------------------------------------------

  it("Deposit event has commitment as indexed topic", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: ethers.parseEther("1") });
    const receipt = await tx.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);

    expect(log, "Deposit log not found").to.not.be.undefined;

    // topics[0] = event selector
    // topics[1] = first indexed param: commitment
    const expectedTopic1 = ethers.zeroPadValue(ethers.toBeHex(commitment), 32);
    expect(log!.topics[1]).to.equal(expectedTopic1);
  });

  it("Deposit event has 4 non-indexed args (commitment, leafIndex, amount, timestamp)", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();
    const amount = ethers.parseEther("1");

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: amount });
    const receipt = await tx.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);

    expect(log, "Deposit log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(parsed).to.not.be.null;
    expect(parsed!.name).to.equal("Deposit");

    // event Deposit(uint256 indexed commitment, uint32 leafIndex, uint256 amount, uint256 timestamp)
    expect(parsed!.args["commitment"]).to.equal(commitment);
    expect(parsed!.args["leafIndex"]).to.equal(0n); // first deposit
    expect(parsed!.args["amount"]).to.equal(amount);
    expect(parsed!.args["timestamp"]).to.be.greaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // Transfer event — indexed nullifier
  // -------------------------------------------------------------------------

  it("Transfer event has nullifier as indexed topic", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();
    const root = await depositAndGetRoot(pool, alice, commitment);
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    const tx = await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      out1,
      out2
    );
    const receipt = await tx.wait();

    const transferTopic = pool.interface.getEvent("Transfer").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === transferTopic);

    expect(log, "Transfer log not found").to.not.be.undefined;

    // topics[1] = indexed nullifier
    const expectedNullifierTopic = ethers.zeroPadValue(
      ethers.toBeHex(nullifier),
      32
    );
    expect(log!.topics[1]).to.equal(expectedNullifierTopic);
  });

  it("Transfer event has 3 args (nullifier indexed, outputCommitment1, outputCommitment2)", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();
    const root = await depositAndGetRoot(pool, alice, commitment);
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    const tx = await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      out1,
      out2
    );
    const receipt = await tx.wait();

    const transferTopic = pool.interface.getEvent("Transfer").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === transferTopic);

    const parsed = pool.interface.parseLog(log!);
    expect(parsed!.name).to.equal("Transfer");

    // event Transfer(uint256 indexed nullifier, uint256 outputCommitment1, uint256 outputCommitment2)
    expect(parsed!.args["nullifier"]).to.equal(nullifier);
    expect(parsed!.args["outputCommitment1"]).to.equal(out1);
    expect(parsed!.args["outputCommitment2"]).to.equal(out2);
  });

  // -------------------------------------------------------------------------
  // Withdrawal event — indexed nullifier
  // -------------------------------------------------------------------------

  it("Withdrawal event has nullifier as indexed topic", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);
    const depositAmount = ethers.parseEther("1");
    const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);
    const nullifier = randomCommitment();
    const withdrawAmount = ethers.parseEther("0.9");
    const fee = ethers.parseEther("0.1");

    const tx = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      withdrawAmount,
      bob.address,
      0n,
      relayer.address,
      fee
    );
    const receipt = await tx.wait();

    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);

    expect(log, "Withdrawal log not found").to.not.be.undefined;

    // topics[1] = indexed nullifier
    const expectedNullifierTopic = ethers.zeroPadValue(
      ethers.toBeHex(nullifier),
      32
    );
    expect(log!.topics[1]).to.equal(expectedNullifierTopic);
  });

  it("Withdrawal event has 6 args recoverable via parseLog", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);
    const depositAmount = ethers.parseEther("1");
    const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);
    const nullifier = randomCommitment();
    const withdrawAmount = ethers.parseEther("0.9");
    const fee = ethers.parseEther("0.1");
    const changeCommitment = 0n;

    const tx = await pool.withdraw(
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
    );
    const receipt = await tx.wait();

    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);

    const parsed = pool.interface.parseLog(log!);
    expect(parsed!.name).to.equal("Withdrawal");

    // event Withdrawal(uint256 indexed nullifier, uint256 amount, address recipient, uint256 changeCommitment, address relayer, uint256 fee)
    expect(parsed!.args["nullifier"]).to.equal(nullifier);
    expect(parsed!.args["amount"]).to.equal(withdrawAmount);
    expect(parsed!.args["recipient"]).to.equal(bob.address);
    expect(parsed!.args["changeCommitment"]).to.equal(changeCommitment);
    expect(parsed!.args["relayer"]).to.equal(relayer.address);
    expect(parsed!.args["fee"]).to.equal(fee);
  });

  // -------------------------------------------------------------------------
  // StealthPayment event — indexed commitment + 7 total args
  // -------------------------------------------------------------------------

  it("StealthPayment event has commitment as indexed topic", async function () {
    const { registry, alice } = await loadFixture(deployStealthFixture);
    const commitment = randomCommitment();
    const ephemeralX = randomCommitment();
    const ephemeralY = randomCommitment();
    const stealthX = randomCommitment();
    const stealthY = randomCommitment();
    const encAmount = randomCommitment();
    const encBlinding = randomCommitment();

    const tx = await registry
      .connect(alice)
      .announceStealthPayment(
        commitment,
        ephemeralX,
        ephemeralY,
        stealthX,
        stealthY,
        encAmount,
        encBlinding
      );
    const receipt = await tx.wait();

    const stealthTopic = registry.interface.getEvent("StealthPayment").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === stealthTopic);

    expect(log, "StealthPayment log not found").to.not.be.undefined;

    // topics[1] = indexed commitment
    const expectedTopic1 = ethers.zeroPadValue(ethers.toBeHex(commitment), 32);
    expect(log!.topics[1]).to.equal(expectedTopic1);
  });

  it("StealthPayment event has 7 args recoverable via parseLog", async function () {
    const { registry, alice } = await loadFixture(deployStealthFixture);
    const commitment = randomCommitment();
    const ephemeralX = randomCommitment();
    const ephemeralY = randomCommitment();
    const stealthX = randomCommitment();
    const stealthY = randomCommitment();
    const encAmount = randomCommitment();
    const encBlinding = randomCommitment();

    const tx = await registry
      .connect(alice)
      .announceStealthPayment(
        commitment,
        ephemeralX,
        ephemeralY,
        stealthX,
        stealthY,
        encAmount,
        encBlinding
      );
    const receipt = await tx.wait();

    const stealthTopic = registry.interface.getEvent("StealthPayment").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === stealthTopic);

    const parsed = registry.interface.parseLog(log!);
    expect(parsed!.name).to.equal("StealthPayment");

    // event StealthPayment(uint256 indexed commitment, uint256 ephemeralPubKeyX,
    //   uint256 ephemeralPubKeyY, uint256 stealthPubKeyX, uint256 stealthPubKeyY,
    //   uint256 encryptedAmount, uint256 encryptedBlinding)
    expect(parsed!.args["commitment"]).to.equal(commitment);
    expect(parsed!.args["ephemeralPubKeyX"]).to.equal(ephemeralX);
    expect(parsed!.args["ephemeralPubKeyY"]).to.equal(ephemeralY);
    expect(parsed!.args["stealthPubKeyX"]).to.equal(stealthX);
    expect(parsed!.args["stealthPubKeyY"]).to.equal(stealthY);
    expect(parsed!.args["encryptedAmount"]).to.equal(encAmount);
    expect(parsed!.args["encryptedBlinding"]).to.equal(encBlinding);
  });

  // -------------------------------------------------------------------------
  // DenominationAdded event structure
  // -------------------------------------------------------------------------

  it("DenominationAdded event has correct structure and denomination value", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    const denom = ethers.parseEther("0.5");
    const hash = timelockHash("addDenomination", denom);

    await timelockQueue(pool.connect(owner), hash);
    const tx = await pool.connect(owner).addDenomination(denom);
    const receipt = await tx.wait();

    const denomTopic = pool.interface.getEvent("DenominationAdded").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === denomTopic);

    expect(log, "DenominationAdded log not found").to.not.be.undefined;

    // DenominationAdded has no indexed params — only topics[0] (selector)
    expect(log!.topics).to.have.length(1);

    const parsed = pool.interface.parseLog(log!);
    expect(parsed!.name).to.equal("DenominationAdded");
    expect(parsed!.args["denomination"]).to.equal(denom);
  });

  // -------------------------------------------------------------------------
  // AllowlistToggled event structure
  // -------------------------------------------------------------------------

  it("AllowlistToggled event has correct structure and enabled flag", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const txEnable = await pool.connect(owner).setAllowlistEnabled(true);
    const receiptEnable = await txEnable.wait();

    const toggleTopic = pool.interface.getEvent("AllowlistToggled").topicHash;
    const logEnable = receiptEnable!.logs.find(
      (l) => l.topics[0] === toggleTopic
    );

    expect(logEnable, "AllowlistToggled(true) log not found").to.not.be
      .undefined;

    const parsedEnable = pool.interface.parseLog(logEnable!);
    expect(parsedEnable!.args["enabled"]).to.equal(true);

    // Disable
    const txDisable = await pool.connect(owner).setAllowlistEnabled(false);
    const receiptDisable = await txDisable.wait();

    const logDisable = receiptDisable!.logs.find(
      (l) => l.topics[0] === toggleTopic
    );
    const parsedDisable = pool.interface.parseLog(logDisable!);
    expect(parsedDisable!.args["enabled"]).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // Deposit events — unique topics across multiple txs
  // -------------------------------------------------------------------------

  it("Deposit events from multiple txs have unique indexed topics (distinct commitments)", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const commitmentA = randomCommitment();
    const commitmentB = randomCommitment();
    expect(commitmentA).to.not.equal(commitmentB);

    const txA = await pool
      .connect(alice)
      .deposit(commitmentA, { value: ethers.parseEther("1") });
    const receiptA = await txA.wait();

    const txB = await pool
      .connect(bob)
      .deposit(commitmentB, { value: ethers.parseEther("1") });
    const receiptB = await txB.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const logA = receiptA!.logs.find((l) => l.topics[0] === depositTopic);
    const logB = receiptB!.logs.find((l) => l.topics[0] === depositTopic);

    expect(logA, "Deposit log A not found").to.not.be.undefined;
    expect(logB, "Deposit log B not found").to.not.be.undefined;

    expect(logA!.topics[1]).to.not.equal(logB!.topics[1]);
  });

  // -------------------------------------------------------------------------
  // Event count matches operation count after 5 deposits
  // -------------------------------------------------------------------------

  it("event count matches operation count after 5 deposits", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const poolAddress = await pool.getAddress();
    let totalDepositEvents = 0;

    for (let i = 0; i < 5; i++) {
      const tx = await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });
      const receipt = await tx.wait();
      totalDepositEvents += receipt!.logs.filter(
        (l) =>
          l.address.toLowerCase() === poolAddress.toLowerCase() &&
          l.topics[0] === depositTopic
      ).length;
    }

    expect(totalDepositEvents).to.equal(5);
  });

  // -------------------------------------------------------------------------
  // Topic hash encoding — selector matches keccak256 of signature
  // -------------------------------------------------------------------------

  it("Deposit event topic[0] matches keccak256 of its ABI signature", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const expectedTopic = ethers.id("Deposit(uint256,uint32,uint256,uint256)");
    const actualTopic = pool.interface.getEvent("Deposit").topicHash;

    expect(actualTopic).to.equal(expectedTopic);
  });

  it("Transfer event topic[0] matches keccak256 of its ABI signature", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const expectedTopic = ethers.id(
      "Transfer(uint256,uint256,uint256)"
    );
    const actualTopic = pool.interface.getEvent("Transfer").topicHash;

    expect(actualTopic).to.equal(expectedTopic);
  });

  it("Withdrawal event topic[0] matches keccak256 of its ABI signature", async function () {
    const { pool } = await loadFixture(deployPoolFixture);

    const expectedTopic = ethers.id(
      "Withdrawal(uint256,uint256,address,uint256,address,uint256)"
    );
    const actualTopic = pool.interface.getEvent("Withdrawal").topicHash;

    expect(actualTopic).to.equal(expectedTopic);
  });

  it("StealthPayment event topic[0] matches keccak256 of its ABI signature", async function () {
    const { registry } = await loadFixture(deployStealthFixture);

    const expectedTopic = ethers.id(
      "StealthPayment(uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
    );
    const actualTopic = registry.interface.getEvent("StealthPayment").topicHash;

    expect(actualTopic).to.equal(expectedTopic);
  });
});
