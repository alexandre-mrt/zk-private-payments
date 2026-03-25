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

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      [name, value]
    )
  );
}

async function timelockQueue(
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

// ---------------------------------------------------------------------------
// Event Encoding Tests
// ---------------------------------------------------------------------------

describe("Event Encoding", function () {
  // -------------------------------------------------------------------------
  // Deposit event — arg types
  // -------------------------------------------------------------------------

  it("Deposit.commitment is uint256", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: ethers.parseEther("1") });
    const receipt = await tx.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    expect(log, "Deposit log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(parsed).to.not.be.null;

    // uint256 comes back as bigint in ethers v6
    expect(typeof parsed!.args["commitment"]).to.equal("bigint");
  });

  it("Deposit.leafIndex is uint32", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: ethers.parseEther("1") });
    const receipt = await tx.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    const parsed = pool.interface.parseLog(log!);

    // uint32 comes back as bigint in ethers v6; must fit within uint32 range
    expect(typeof parsed!.args["leafIndex"]).to.equal("bigint");
    expect(parsed!.args["leafIndex"]).to.be.lessThanOrEqual(4294967295n);
  });

  it("Deposit.timestamp is uint256", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: ethers.parseEther("1") });
    const receipt = await tx.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["timestamp"]).to.equal("bigint");
    expect(parsed!.args["timestamp"]).to.be.greaterThan(0n);
  });

  it("Deposit.commitment matches the deposited value exactly", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: ethers.parseEther("1") });
    const receipt = await tx.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(parsed!.args["commitment"]).to.equal(commitment);
  });

  it("Deposit.leafIndex starts at 0 and increments", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const tx0 = await pool
      .connect(alice)
      .deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const receipt0 = await tx0.wait();

    const tx1 = await pool
      .connect(alice)
      .deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const receipt1 = await tx1.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;

    const log0 = receipt0!.logs.find((l) => l.topics[0] === depositTopic);
    const log1 = receipt1!.logs.find((l) => l.topics[0] === depositTopic);

    const parsed0 = pool.interface.parseLog(log0!);
    const parsed1 = pool.interface.parseLog(log1!);

    expect(parsed0!.args["leafIndex"]).to.equal(0n);
    expect(parsed1!.args["leafIndex"]).to.equal(1n);
  });

  it("Deposit.timestamp is close to block.timestamp", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: ethers.parseEther("1") });
    const receipt = await tx.wait();

    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const blockTimestamp = BigInt(block!.timestamp);

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);
    const parsed = pool.interface.parseLog(log!);

    const eventTimestamp = parsed!.args["timestamp"] as bigint;
    // Timestamp must match block.timestamp exactly
    expect(eventTimestamp).to.equal(blockTimestamp);
  });

  // -------------------------------------------------------------------------
  // Transfer event — arg types
  // -------------------------------------------------------------------------

  it("Transfer.nullifier is uint256", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    const tx = await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      randomCommitment(),
      randomCommitment()
    );
    const receipt = await tx.wait();

    const transferTopic = pool.interface.getEvent("Transfer").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === transferTopic);
    expect(log, "Transfer log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(typeof parsed!.args["nullifier"]).to.equal("bigint");
  });

  it("Transfer.outputCommitment1 is uint256", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
    const out1 = randomCommitment();

    const tx = await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      out1,
      randomCommitment()
    );
    const receipt = await tx.wait();

    const transferTopic = pool.interface.getEvent("Transfer").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === transferTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["outputCommitment1"]).to.equal("bigint");
    expect(parsed!.args["outputCommitment1"]).to.equal(out1);
  });

  it("Transfer.outputCommitment2 is uint256", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
    const out2 = randomCommitment();

    const tx = await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      randomCommitment(),
      out2
    );
    const receipt = await tx.wait();

    const transferTopic = pool.interface.getEvent("Transfer").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === transferTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["outputCommitment2"]).to.equal("bigint");
    expect(parsed!.args["outputCommitment2"]).to.equal(out2);
  });

  // -------------------------------------------------------------------------
  // Withdrawal event — all 6 fields type-checked
  // -------------------------------------------------------------------------

  it("Withdrawal.nullifier is uint256", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    const tx = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      ethers.parseEther("0.9"),
      bob.address,
      0n,
      relayer.address,
      ethers.parseEther("0.1")
    );
    const receipt = await tx.wait();

    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    expect(log, "Withdrawal log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(typeof parsed!.args["nullifier"]).to.equal("bigint");
    expect(parsed!.args["nullifier"]).to.equal(nullifier);
  });

  it("Withdrawal.amount is uint256", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
    const withdrawAmount = ethers.parseEther("0.9");

    const tx = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      withdrawAmount,
      bob.address,
      0n,
      relayer.address,
      ethers.parseEther("0.1")
    );
    const receipt = await tx.wait();

    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["amount"]).to.equal("bigint");
    expect(parsed!.args["amount"]).to.equal(withdrawAmount);
  });

  it("Withdrawal.recipient is address", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();

    const tx = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      ethers.parseEther("0.9"),
      bob.address,
      0n,
      relayer.address,
      ethers.parseEther("0.1")
    );
    const receipt = await tx.wait();

    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["recipient"]).to.equal("string");
    expect(ethers.isAddress(parsed!.args["recipient"])).to.equal(true);
    expect(parsed!.args["recipient"]).to.equal(bob.address);
  });

  it("Withdrawal.changeCommitment is uint256", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
    const changeCommitment = 0n;

    const tx = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      ethers.parseEther("0.9"),
      bob.address,
      changeCommitment,
      relayer.address,
      ethers.parseEther("0.1")
    );
    const receipt = await tx.wait();

    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["changeCommitment"]).to.equal("bigint");
    expect(parsed!.args["changeCommitment"]).to.equal(changeCommitment);
  });

  it("Withdrawal.relayer is address", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();

    const tx = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      ethers.parseEther("0.9"),
      bob.address,
      0n,
      relayer.address,
      ethers.parseEther("0.1")
    );
    const receipt = await tx.wait();

    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["relayer"]).to.equal("string");
    expect(ethers.isAddress(parsed!.args["relayer"])).to.equal(true);
    expect(parsed!.args["relayer"]).to.equal(relayer.address);
  });

  it("Withdrawal.fee is uint256", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
    const fee = ethers.parseEther("0.1");

    const tx = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      randomCommitment(),
      ethers.parseEther("0.9"),
      bob.address,
      0n,
      relayer.address,
      fee
    );
    const receipt = await tx.wait();

    const withdrawalTopic = pool.interface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === withdrawalTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["fee"]).to.equal("bigint");
    expect(parsed!.args["fee"]).to.equal(fee);
  });

  // -------------------------------------------------------------------------
  // StealthPayment — all 7 fields type-checked
  // -------------------------------------------------------------------------

  it("StealthPayment.commitment is uint256", async function () {
    const { registry, alice } = await loadFixture(deployStealthFixture);
    const commitment = randomCommitment();

    const tx = await registry
      .connect(alice)
      .announceStealthPayment(
        commitment,
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );
    const receipt = await tx.wait();

    const stealthTopic = registry.interface.getEvent("StealthPayment").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === stealthTopic);
    expect(log, "StealthPayment log not found").to.not.be.undefined;

    const parsed = registry.interface.parseLog(log!);
    expect(typeof parsed!.args["commitment"]).to.equal("bigint");
    expect(parsed!.args["commitment"]).to.equal(commitment);
  });

  it("StealthPayment ephemeralPubKeyX and ephemeralPubKeyY are uint256", async function () {
    const { registry, alice } = await loadFixture(deployStealthFixture);
    const ephemeralX = randomCommitment();
    const ephemeralY = randomCommitment();

    const tx = await registry
      .connect(alice)
      .announceStealthPayment(
        randomCommitment(),
        ephemeralX,
        ephemeralY,
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );
    const receipt = await tx.wait();

    const stealthTopic = registry.interface.getEvent("StealthPayment").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === stealthTopic);
    const parsed = registry.interface.parseLog(log!);

    expect(typeof parsed!.args["ephemeralPubKeyX"]).to.equal("bigint");
    expect(typeof parsed!.args["ephemeralPubKeyY"]).to.equal("bigint");
    expect(parsed!.args["ephemeralPubKeyX"]).to.equal(ephemeralX);
    expect(parsed!.args["ephemeralPubKeyY"]).to.equal(ephemeralY);
  });

  it("StealthPayment stealthPubKeyX and stealthPubKeyY are uint256", async function () {
    const { registry, alice } = await loadFixture(deployStealthFixture);
    const stealthX = randomCommitment();
    const stealthY = randomCommitment();

    const tx = await registry
      .connect(alice)
      .announceStealthPayment(
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
        stealthX,
        stealthY,
        randomCommitment(),
        randomCommitment()
      );
    const receipt = await tx.wait();

    const stealthTopic = registry.interface.getEvent("StealthPayment").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === stealthTopic);
    const parsed = registry.interface.parseLog(log!);

    expect(typeof parsed!.args["stealthPubKeyX"]).to.equal("bigint");
    expect(typeof parsed!.args["stealthPubKeyY"]).to.equal("bigint");
    expect(parsed!.args["stealthPubKeyX"]).to.equal(stealthX);
    expect(parsed!.args["stealthPubKeyY"]).to.equal(stealthY);
  });

  it("StealthPayment encryptedAmount and encryptedBlinding are uint256", async function () {
    const { registry, alice } = await loadFixture(deployStealthFixture);
    const encAmount = randomCommitment();
    const encBlinding = randomCommitment();

    const tx = await registry
      .connect(alice)
      .announceStealthPayment(
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
        randomCommitment(),
        encAmount,
        encBlinding
      );
    const receipt = await tx.wait();

    const stealthTopic = registry.interface.getEvent("StealthPayment").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === stealthTopic);
    const parsed = registry.interface.parseLog(log!);

    expect(typeof parsed!.args["encryptedAmount"]).to.equal("bigint");
    expect(typeof parsed!.args["encryptedBlinding"]).to.equal("bigint");
    expect(parsed!.args["encryptedAmount"]).to.equal(encAmount);
    expect(parsed!.args["encryptedBlinding"]).to.equal(encBlinding);
  });

  // -------------------------------------------------------------------------
  // DenominationAdded — denomination value
  // -------------------------------------------------------------------------

  it("DenominationAdded.denomination is uint256 matching the added value", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    const denom = ethers.parseEther("0.5");
    const hash = timelockHash("addDenomination", denom);

    await timelockQueue(pool.connect(owner), hash);
    const tx = await pool.connect(owner).addDenomination(denom);
    const receipt = await tx.wait();

    const denomTopic = pool.interface.getEvent("DenominationAdded").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === denomTopic);
    expect(log, "DenominationAdded log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(typeof parsed!.args["denomination"]).to.equal("bigint");
    expect(parsed!.args["denomination"]).to.equal(denom);
  });

  // -------------------------------------------------------------------------
  // DenominationRemoved — denomination value
  // -------------------------------------------------------------------------

  it("DenominationRemoved.denomination is uint256 matching the removed value", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    const denom = ethers.parseEther("0.25");

    // Add first
    const addHash = timelockHash("addDenomination", denom);
    await timelockQueue(pool.connect(owner), addHash);
    await pool.connect(owner).addDenomination(denom);

    // Remove
    const removeHash = timelockHash("removeDenomination", denom);
    await timelockQueue(pool.connect(owner), removeHash);
    const tx = await pool.connect(owner).removeDenomination(denom);
    const receipt = await tx.wait();

    const removedTopic = pool.interface.getEvent("DenominationRemoved").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === removedTopic);
    expect(log, "DenominationRemoved log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(typeof parsed!.args["denomination"]).to.equal("bigint");
    expect(parsed!.args["denomination"]).to.equal(denom);
  });

  // -------------------------------------------------------------------------
  // AllowlistToggled — bool value
  // -------------------------------------------------------------------------

  it("AllowlistToggled.enabled is bool (true when enabling)", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const tx = await pool.connect(owner).setAllowlistEnabled(true);
    const receipt = await tx.wait();

    const toggleTopic = pool.interface.getEvent("AllowlistToggled").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === toggleTopic);
    expect(log, "AllowlistToggled log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(typeof parsed!.args["enabled"]).to.equal("boolean");
    expect(parsed!.args["enabled"]).to.equal(true);
  });

  it("AllowlistToggled.enabled is bool (false when disabling)", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    // Enable first, then disable
    await pool.connect(owner).setAllowlistEnabled(true);
    const tx = await pool.connect(owner).setAllowlistEnabled(false);
    const receipt = await tx.wait();

    const toggleTopic = pool.interface.getEvent("AllowlistToggled").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === toggleTopic);
    const parsed = pool.interface.parseLog(log!);

    expect(typeof parsed!.args["enabled"]).to.equal("boolean");
    expect(parsed!.args["enabled"]).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // EmergencyDrain — address + uint256 amount
  // -------------------------------------------------------------------------

  it("EmergencyDrain.to is address and amount is uint256", async function () {
    const { pool, owner, alice } = await loadFixture(deployPoolFixture);

    // Deposit ETH so there's a balance to drain
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });

    // Pause the pool (required by emergencyDrain)
    await pool.connect(owner).pause();

    const tx = await pool.connect(owner).emergencyDrain(owner.address as `0x${string}`);
    const receipt = await tx.wait();

    const drainTopic = pool.interface.getEvent("EmergencyDrain").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === drainTopic);
    expect(log, "EmergencyDrain log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(parsed!.name).to.equal("EmergencyDrain");

    // event EmergencyDrain(address indexed to, uint256 amount)
    // "to" is indexed — recovered via parseLog
    expect(typeof parsed!.args["to"]).to.equal("string");
    expect(ethers.isAddress(parsed!.args["to"])).to.equal(true);
    expect(parsed!.args["to"]).to.equal(owner.address);

    expect(typeof parsed!.args["amount"]).to.equal("bigint");
    expect(parsed!.args["amount"]).to.equal(ethers.parseEther("1"));
  });

  // -------------------------------------------------------------------------
  // MaxOperationsPerBlockUpdated — uint256
  // -------------------------------------------------------------------------

  it("MaxOperationsPerBlockUpdated.newMax is uint256", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    const newMax = 5n;

    const tx = await pool.connect(owner).setMaxOperationsPerBlock(newMax);
    const receipt = await tx.wait();

    const updatedTopic = pool.interface.getEvent("MaxOperationsPerBlockUpdated").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === updatedTopic);
    expect(log, "MaxOperationsPerBlockUpdated log not found").to.not.be.undefined;

    const parsed = pool.interface.parseLog(log!);
    expect(parsed!.name).to.equal("MaxOperationsPerBlockUpdated");
    expect(typeof parsed!.args["newMax"]).to.equal("bigint");
    expect(parsed!.args["newMax"]).to.equal(newMax);
  });

  // -------------------------------------------------------------------------
  // Decodability — interface.parseLog round-trip
  // -------------------------------------------------------------------------

  it("Deposit event is decodable via interface.parseLog with all named args", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();
    const amount = ethers.parseEther("1");

    const tx = await pool
      .connect(alice)
      .deposit(commitment, { value: amount });
    const receipt = await tx.wait();

    const depositTopic = pool.interface.getEvent("Deposit").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === depositTopic);

    const parsed = pool.interface.parseLog(log!);
    expect(parsed).to.not.be.null;
    expect(parsed!.name).to.equal("Deposit");

    expect(parsed!.args["commitment"]).to.equal(commitment);
    expect(parsed!.args["leafIndex"]).to.equal(0n);
    expect(parsed!.args["amount"]).to.equal(amount);
    expect(parsed!.args["timestamp"]).to.be.greaterThan(0n);
  });

  it("Transfer event is decodable via interface.parseLog with all named args", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
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
    expect(parsed).to.not.be.null;
    expect(parsed!.name).to.equal("Transfer");

    expect(parsed!.args["nullifier"]).to.equal(nullifier);
    expect(parsed!.args["outputCommitment1"]).to.equal(out1);
    expect(parsed!.args["outputCommitment2"]).to.equal(out2);
  });

  it("Withdrawal event is decodable via interface.parseLog with all named args", async function () {
    const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
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
    expect(parsed).to.not.be.null;
    expect(parsed!.name).to.equal("Withdrawal");

    expect(parsed!.args["nullifier"]).to.equal(nullifier);
    expect(parsed!.args["amount"]).to.equal(withdrawAmount);
    expect(parsed!.args["recipient"]).to.equal(bob.address);
    expect(parsed!.args["changeCommitment"]).to.equal(changeCommitment);
    expect(parsed!.args["relayer"]).to.equal(relayer.address);
    expect(parsed!.args["fee"]).to.equal(fee);
  });

  it("StealthPayment event is decodable via interface.parseLog with all named args", async function () {
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
    expect(parsed).to.not.be.null;
    expect(parsed!.name).to.equal("StealthPayment");

    expect(parsed!.args["commitment"]).to.equal(commitment);
    expect(parsed!.args["ephemeralPubKeyX"]).to.equal(ephemeralX);
    expect(parsed!.args["ephemeralPubKeyY"]).to.equal(ephemeralY);
    expect(parsed!.args["stealthPubKeyX"]).to.equal(stealthX);
    expect(parsed!.args["stealthPubKeyY"]).to.equal(stealthY);
    expect(parsed!.args["encryptedAmount"]).to.equal(encAmount);
    expect(parsed!.args["encryptedBlinding"]).to.equal(encBlinding);
  });
});
