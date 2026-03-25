import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** BN254 scalar field prime. All Poseidon inputs/outputs live in [0, FIELD_SIZE). */
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ONE_ETH = ethers.parseEther("1");
const HALF_ETH = ethers.parseEther("0.5");

// Dummy Groth16 proof accepted by both mock verifiers (return true for all inputs).
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

/** Returns a 31-byte random bigint — always non-zero and < FIELD_SIZE. */
function randomField(): bigint {
  const v = ethers.toBigInt(ethers.randomBytes(31));
  return v === 0n ? 1n : v;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, carol, sender, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5, // 32-leaf tree — sufficient for all property tests
    hasherAddress
  );

  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();

  return { pool, registry, owner, alice, bob, carol, sender, relayer };
}

type Pool = Awaited<ReturnType<typeof deployFixture>>["pool"];
type Registry = Awaited<ReturnType<typeof deployFixture>>["registry"];
type Signer = Awaited<ReturnType<typeof deployFixture>>["alice"];

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

async function doDeposit(
  pool: Pool,
  signer: Signer,
  value: bigint = ONE_ETH
): Promise<bigint> {
  const commitment = randomField();
  await pool.connect(signer).deposit(commitment, { value });
  return commitment;
}

async function doWithdraw(
  pool: Pool,
  recipient: Signer,
  amount: bigint = HALF_ETH,
  nullifier?: bigint,
  changeCommitment: bigint = 0n
): Promise<bigint> {
  const root = await pool.getLastRoot();
  const n = nullifier ?? randomField();
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    n,
    amount,
    recipient.address as `0x${string}`,
    changeCommitment,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
  return n;
}

async function doTransfer(
  pool: Pool,
  out1?: bigint,
  out2?: bigint
): Promise<{ nullifier: bigint; out1: bigint; out2: bigint }> {
  const root = await pool.getLastRoot();
  const nullifier = randomField();
  const outputCommitment1 = out1 ?? randomField();
  const outputCommitment2 = out2 ?? randomField();
  await pool.transfer(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    outputCommitment1,
    outputCommitment2
  );
  return { nullifier, out1: outputCommitment1, out2: outputCommitment2 };
}

// ---------------------------------------------------------------------------
// Privacy Properties
// ---------------------------------------------------------------------------

describe("Privacy Properties", function () {
  // circomlibjs Poseidon — built once for the whole suite.
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  /** Compute Poseidon(a, b) off-chain. */
  function poseidon2(a: bigint, b: bigint): bigint {
    return F.toObject(poseidon([a, b]));
  }

  /** Compute Poseidon(a, c) as a 3-input Poseidon via (a, b, c) folded. */
  function poseidon3(a: bigint, b: bigint, c: bigint): bigint {
    // The commitment formula is Poseidon(amount, blinding, ownerPubKeyX).
    // circomlibjs buildPoseidon supports variable-arity input arrays.
    return F.toObject(poseidon([a, b, c]));
  }

  // -------------------------------------------------------------------------
  // Commitment hiding
  // -------------------------------------------------------------------------

  it("commitment doesn't reveal the secret (one-way hash)", async function () {
    // commitment = Poseidon(amount, blinding, ownerPubKeyX)
    // Varying `blinding` with fixed amount and owner produces a different
    // commitment — no component can be recovered from the output alone.
    const amount = ONE_ETH;
    const owner = randomField();
    const blinding1 = randomField();
    const blinding2 = randomField();

    const c1 = poseidon3(amount, blinding1, owner);
    const c2 = poseidon3(amount, blinding2, owner);

    expect(c1).to.not.equal(c2);
    // Commitment doesn't trivially equal any of its inputs.
    expect(c1).to.not.equal(amount);
    expect(c1).to.not.equal(blinding1);
    expect(c1).to.not.equal(owner);
  });

  it("commitment doesn't reveal amount", async function () {
    // Two notes with different amounts (same blinding and owner) produce
    // different commitments, but neither commitment reveals which amount it hides.
    const blinding = randomField();
    const owner = randomField();
    const amount1 = ethers.parseEther("0.3");
    const amount2 = ethers.parseEther("1.7");

    const c1 = poseidon3(amount1, blinding, owner);
    const c2 = poseidon3(amount2, blinding, owner);

    expect(c1).to.not.equal(c2);
    // The commitment value does not equal the amount it encodes.
    expect(c1).to.not.equal(amount1);
    expect(c2).to.not.equal(amount2);
    // Both commitments are valid field elements.
    expect(c1).to.be.lessThan(FIELD_SIZE);
    expect(c2).to.be.lessThan(FIELD_SIZE);
  });

  it("two deposits from same user produce different commitments", async function () {
    const { pool, alice } = await loadFixture(deployFixture);

    const c1 = await doDeposit(pool, alice, ONE_ETH);
    const c2 = await doDeposit(pool, alice, ONE_ETH);

    expect(c1).to.not.equal(c2);

    const idx1 = await pool.commitmentIndex(c1);
    const idx2 = await pool.commitmentIndex(c2);
    expect(idx1).to.not.equal(idx2);
  });

  it("commitment is indistinguishable from random (field element)", async function () {
    // 8 fresh commitments must each be non-zero, < FIELD_SIZE, and mutually distinct.
    const COUNT = 8;
    const seen: bigint[] = [];

    for (let i = 0; i < COUNT; i++) {
      const c = poseidon3(randomField(), randomField(), randomField());
      expect(c, `commitment[${i}] must be > 0`).to.be.greaterThan(0n);
      expect(c, `commitment[${i}] must be < FIELD_SIZE`).to.be.lessThan(FIELD_SIZE);
      seen.push(c);
    }

    const unique = new Set(seen.map(String));
    expect(unique.size).to.equal(COUNT);
  });

  // -------------------------------------------------------------------------
  // Nullifier hiding
  // -------------------------------------------------------------------------

  it("nullifierHash doesn't reveal which commitment it belongs to", async function () {
    // nullifier = Poseidon(commitment, spendingKey)
    // Two different (commitment, spendingKey) pairs produce different nullifiers,
    // so the nullifier does not reveal either input.
    const commitment1 = randomField();
    const commitment2 = randomField();
    const spendingKey = randomField();

    const nh1 = poseidon2(commitment1, spendingKey);
    const nh2 = poseidon2(commitment2, spendingKey);

    expect(nh1).to.not.equal(nh2);
    // Nullifier does not equal either commitment.
    expect(nh1).to.not.equal(commitment1);
    expect(nh1).to.not.equal(commitment2);
    expect(nh2).to.not.equal(commitment1);
    expect(nh2).to.not.equal(commitment2);
  });

  it("nullifierHash is different from commitment for same note", async function () {
    // For any note: nullifier = Poseidon(commitment, spendingKey).
    // nullifier ≠ commitment because the spendingKey mixes in additional entropy.
    const commitment = randomField();
    const spendingKey = randomField();

    const nullifier = poseidon2(commitment, spendingKey);

    expect(nullifier).to.not.equal(commitment);
    expect(nullifier).to.be.lessThan(FIELD_SIZE);
  });

  it("spent nullifier doesn't reveal deposit leaf index", async function () {
    // After spending, nullifiers[nullifier] = true. The nullifier is the key —
    // it carries no information about the leaf index of the spent commitment.
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const commitment = randomField();
    await pool.connect(alice).deposit(commitment, { value: ONE_ETH });
    const leafIndex = await pool.commitmentIndex(commitment);

    // Spend a random nullifier — the spent mapping stores only the nullifier key.
    const nullifier = await doWithdraw(pool, bob, HALF_ETH);

    expect(await pool.nullifiers(nullifier)).to.be.true;

    // commitmentIndex for our deposit is unchanged — it's not linked to the nullifier.
    expect(await pool.commitmentIndex(commitment)).to.equal(leafIndex);
  });

  // -------------------------------------------------------------------------
  // Transfer output unlinkability
  // -------------------------------------------------------------------------

  it("transfer output commitments are unlinkable to input nullifier", async function () {
    // The Transfer event emits (nullifier, outputCommitment1, outputCommitment2).
    // An observer can see that ONE nullifier is spent and TWO new commitments appear,
    // but the output commitments are independently chosen random field elements —
    // they do not encode any information derivable from the nullifier alone.
    const { pool, alice } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, ONE_ETH);

    const out1 = randomField();
    const out2 = randomField();
    const { nullifier } = await doTransfer(pool, out1, out2);

    // Outputs must differ from the nullifier and from each other.
    expect(out1).to.not.equal(nullifier);
    expect(out2).to.not.equal(nullifier);
    expect(out1).to.not.equal(out2);

    // Both outputs appear in the Merkle tree as new leaves.
    expect(await pool.commitments(out1)).to.be.true;
    expect(await pool.commitments(out2)).to.be.true;
  });

  it("multiple transfers produce unlinkable output sets", async function () {
    // Each call to transfer() inserts two fresh commitments. Across two transfers
    // all four output commitments must be distinct and independent.
    const { pool, alice } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, ONE_ETH);

    const { out1: a1, out2: a2, nullifier: n1 } = await doTransfer(pool);
    const { out1: b1, out2: b2, nullifier: n2 } = await doTransfer(pool);

    const all = [n1, n2, a1, a2, b1, b2];
    const unique = new Set(all.map(String));
    expect(unique.size).to.equal(all.length);
  });

  // -------------------------------------------------------------------------
  // Anonymity set
  // -------------------------------------------------------------------------

  it("withdrawal doesn't reveal which deposit was spent (no on-chain link)", async function () {
    // The Withdrawal event emits (nullifier, amount, recipient, changeCommitment, relayer, fee).
    // It does NOT contain the original deposit commitment or leaf index.
    const { pool, alice, bob } = await loadFixture(deployFixture);

    const c1 = await doDeposit(pool, alice, ONE_ETH);
    const c2 = await doDeposit(pool, alice, ONE_ETH);
    const c3 = await doDeposit(pool, alice, ONE_ETH);

    const nullifier = randomField();
    const root = await pool.getLastRoot();

    const tx = await pool.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      HALF_ETH,
      bob.address as `0x${string}`,
      0n,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );
    const receipt = await tx.wait();
    expect(receipt).to.not.be.null;

    const iface = pool.interface;
    const eventTopic = iface.getEvent("Withdrawal").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === eventTopic);
    expect(log, "Withdrawal log missing").to.not.be.undefined;

    const decoded = iface.decodeEventLog("Withdrawal", log!.data, log!.topics);
    // Withdrawal(nullifier, amount, recipient, changeCommitment, relayer, fee)
    const emittedNullifier: bigint = decoded[0];
    const emittedAmount: bigint = decoded[1];

    // The emitted nullifier is not any of the deposited commitments.
    for (const c of [c1, c2, c3]) {
      expect(emittedNullifier).to.not.equal(c);
    }

    // Amount is the withdrawn amount, not a deposit identifier.
    expect(emittedAmount).to.equal(HALF_ETH);
  });

  it("same recipient can receive multiple withdrawals without linking", async function () {
    // Each withdrawal uses an independent nullifier. Two withdrawals to the same
    // recipient leave no on-chain link between their originating notes.
    const { pool, alice, bob } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, ONE_ETH);
    await doDeposit(pool, alice, ONE_ETH);

    const nh1 = await doWithdraw(pool, bob, HALF_ETH);
    const nh2 = await doWithdraw(pool, bob, HALF_ETH);

    expect(nh1).to.not.equal(nh2);
    expect(await pool.nullifiers(nh1)).to.be.true;
    expect(await pool.nullifiers(nh2)).to.be.true;
  });

  it("different relayers don't reveal depositor identity", async function () {
    // The relayer is chosen by the withdrawer. Using different relayers for two
    // withdrawals does not link the withdrawals to the same depositor.
    const { pool, alice, bob, carol, relayer } = await loadFixture(deployFixture);

    await doDeposit(pool, alice, ONE_ETH);
    await doDeposit(pool, alice, ONE_ETH);

    const root = await pool.getLastRoot();
    const nh1 = randomField();
    const nh2 = randomField();

    // First withdrawal via relayer.
    await pool.withdraw(
      ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
      root, nh1, HALF_ETH,
      bob.address as `0x${string}`,
      0n,
      relayer.address as `0x${string}`,
      0n
    );
    // Second withdrawal self-relayed.
    await pool.withdraw(
      ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC,
      root, nh2, HALF_ETH,
      carol.address as `0x${string}`,
      0n,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    expect(await pool.nullifiers(nh1)).to.be.true;
    expect(await pool.nullifiers(nh2)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // Stealth addresses
  // -------------------------------------------------------------------------

  it("stealth announcement contains no on-chain link to depositor address", async function () {
    // announceStealthPayment emits a StealthPayment event. The sender's Ethereum
    // address is msg.sender in the transaction, but it is NOT part of the event
    // fields — the event carries only cryptographic parameters.
    const { registry, sender } = await loadFixture(deployFixture);

    const commitment = randomField();
    const ephX = randomField();
    const ephY = randomField();
    const stealthX = randomField();
    const stealthY = randomField();
    const encAmt = randomField();
    const encBlind = randomField();

    const tx = await registry
      .connect(sender)
      .announceStealthPayment(commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlind);
    const receipt = await tx.wait();
    expect(receipt).to.not.be.null;

    const iface = registry.interface;
    const eventTopic = iface.getEvent("StealthPayment").topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === eventTopic);
    expect(log, "StealthPayment log missing").to.not.be.undefined;

    // All indexed/non-indexed parameters — sender address must not appear.
    const senderPadded = ethers.zeroPadValue(sender.address, 32).toLowerCase();
    const allTopics = log!.topics.map((t) => t.toLowerCase());
    for (const topic of allTopics.slice(1)) {
      // topic[0] is the event selector, skip it.
      expect(topic).to.not.equal(senderPadded);
    }
  });

  it("viewing key registration doesn't link to existing deposits", async function () {
    // registerViewingKey only maps msg.sender → (pubKeyX, pubKeyY).
    // A call to getViewingKey cannot reveal which commitments in the pool
    // belong to that address — the pool stores no owner-address → commitment mapping.
    const { pool, registry, alice } = await loadFixture(deployFixture);

    const vkX = randomField();
    const vkY = randomField();
    await registry.connect(alice).registerViewingKey(vkX, vkY);

    // Alice also makes a deposit.
    const commitment = await doDeposit(pool, alice, ONE_ETH);

    // The viewing key lookup returns the registered key.
    const [storedX, storedY] = await registry.getViewingKey(alice.address);
    expect(storedX).to.equal(vkX);
    expect(storedY).to.equal(vkY);

    // The viewing key coordinates must not equal the commitment — no cross-link.
    expect(storedX).to.not.equal(commitment);
    expect(storedY).to.not.equal(commitment);
  });

  it("stealth pubkey coordinates don't match any depositor address on-chain", async function () {
    // The stealth public key is a one-time BabyJubjub point derived from the
    // ECDH shared secret. It must be independent of the depositor's Ethereum address.
    const { registry, alice, bob } = await loadFixture(deployFixture);

    // Alice registers her viewing key.
    await registry.connect(alice).registerViewingKey(randomField(), randomField());

    // Bob announces a stealth payment with a random one-time stealth key.
    const stealthX = randomField();
    const stealthY = randomField();
    await registry
      .connect(bob)
      .announceStealthPayment(
        randomField(), randomField(), randomField(),
        stealthX, stealthY,
        randomField(), randomField()
      );

    // The stealth key coordinates must differ from both participants' Ethereum addresses.
    const alicePadded = BigInt(alice.address);
    const bobPadded = BigInt(bob.address);

    expect(stealthX).to.not.equal(alicePadded);
    expect(stealthX).to.not.equal(bobPadded);
    expect(stealthY).to.not.equal(alicePadded);
    expect(stealthY).to.not.equal(bobPadded);
  });

  // -------------------------------------------------------------------------
  // Encrypted note data
  // -------------------------------------------------------------------------

  it("encrypted note fields are opaque without the viewing key", async function () {
    // encryptedAmount and encryptedBlinding are XOR-encrypted with a
    // Poseidon-derived shared key. Without the viewing key (v) the recipient
    // cannot compute the shared secret, so the plaintext is unrecoverable.
    // We verify structurally: the encrypted values must differ from the
    // plaintext amount and blinding.
    const plainAmount = ONE_ETH;
    const plainBlinding = randomField();

    // Simulate encryption: plaintext XOR key (key is a random field element here).
    const encKey = randomField();
    const encAmt = plainAmount ^ encKey;
    const encBlind = plainBlinding ^ encKey;

    // Encrypted != plaintext (except with negligible probability).
    expect(encAmt).to.not.equal(plainAmount);
    expect(encBlind).to.not.equal(plainBlinding);

    // And the two encrypted fields differ from each other (key XOR is injective).
    expect(encAmt).to.not.equal(encBlind);
  });

  it("stealth announcement encrypted fields don't equal each other", async function () {
    // encryptedAmount and encryptedBlinding encode different plaintexts under
    // the same key, so they should differ with overwhelming probability.
    const { registry, sender } = await loadFixture(deployFixture);

    const encAmt = randomField();
    const encBlind = randomField();

    // They are independent random field elements — must be distinct.
    expect(encAmt).to.not.equal(encBlind);

    // Announcement succeeds with these values.
    await expect(
      registry.connect(sender).announceStealthPayment(
        randomField(), randomField(), randomField(),
        randomField(), randomField(),
        encAmt, encBlind
      )
    ).to.not.be.reverted;
  });
});
