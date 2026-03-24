import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { buildPoseidon } from "circomlibjs";
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

// ---------------------------------------------------------------------------
// Poseidon helpers — matching circuit logic exactly
// ---------------------------------------------------------------------------

/**
 * Compute note commitment: Poseidon(amount, blinding, ownerPubKeyX)
 * Matches the circuit constraint for note commitments.
 */
async function computeCommitment(
  amount: bigint,
  blinding: bigint,
  ownerPubKeyX: bigint
): Promise<bigint> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([amount, blinding, ownerPubKeyX]));
}

/**
 * Compute nullifier: Poseidon(commitment, spendingKey)
 * Matches the circuit constraint for nullifiers.
 */
async function computeNullifier(
  commitment: bigint,
  spendingKey: bigint
): Promise<bigint> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([commitment, spendingKey]));
}

/** Returns a random 31-byte field element (always < FIELD_SIZE). */
function randomFieldElement(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
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
    5, // tree height 5 for speed
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie, relayer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: ZK Private Payments (real Poseidon)", function () {
  // -------------------------------------------------------------------------
  // 1. Full deposit → transfer → withdraw cycle
  // -------------------------------------------------------------------------

  describe("Full deposit → transfer → withdraw cycle", function () {
    it("Alice deposits, transfers to Bob, Bob withdraws — balances correct", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      // Alice's note parameters
      const aliceAmount = ethers.parseEther("1");
      const aliceBlinding = randomFieldElement();
      const alicePubKeyX = randomFieldElement();
      const aliceSpendingKey = randomFieldElement();

      const aliceCommitment = await computeCommitment(
        aliceAmount,
        aliceBlinding,
        alicePubKeyX
      );

      // Alice deposits 1 ETH
      await pool.connect(alice).deposit(aliceCommitment, { value: aliceAmount });
      expect(await pool.commitments(aliceCommitment)).to.be.true;

      const rootAfterDeposit = await pool.getLastRoot();

      // Alice spends her note via transfer — creates 0.7 ETH note for Bob, 0.3 ETH change for Alice
      const bobAmount = ethers.parseEther("0.7");
      const changeAmount = ethers.parseEther("0.3");

      const bobBlinding = randomFieldElement();
      const bobPubKeyX = randomFieldElement();
      const changeBlinding = randomFieldElement();

      const bobCommitment = await computeCommitment(
        bobAmount,
        bobBlinding,
        bobPubKeyX
      );
      const aliceChangeCommitment = await computeCommitment(
        changeAmount,
        changeBlinding,
        alicePubKeyX
      );

      const aliceNullifier = await computeNullifier(
        aliceCommitment,
        aliceSpendingKey
      );

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterDeposit,
        aliceNullifier,
        bobCommitment,
        aliceChangeCommitment
      );

      // Alice's nullifier is spent
      expect(await pool.nullifiers(aliceNullifier)).to.be.true;
      // Both output commitments are in the tree
      expect(await pool.commitments(bobCommitment)).to.be.true;
      expect(await pool.commitments(aliceChangeCommitment)).to.be.true;

      const rootAfterTransfer = await pool.getLastRoot();

      // Bob withdraws his 0.7 ETH
      const bobSpendingKey = randomFieldElement();
      const bobNullifier = await computeNullifier(bobCommitment, bobSpendingKey);

      const bobBefore = await ethers.provider.getBalance(bob.address);

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterTransfer,
        bobNullifier,
        bobAmount,
        bob.address,
        0n, // no further change
        ethers.ZeroAddress,
        0n
      );

      const bobAfter = await ethers.provider.getBalance(bob.address);

      // Bob received exactly 0.7 ETH
      expect(bobAfter - bobBefore).to.equal(bobAmount);
      // Bob's nullifier is spent
      expect(await pool.nullifiers(bobNullifier)).to.be.true;
      // Pool retains Alice's 0.3 ETH change
      expect(
        await ethers.provider.getBalance(await pool.getAddress())
      ).to.equal(changeAmount);
    });

    it("Alice's nullifier cannot be reused after transfer", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const amount = ethers.parseEther("1");
      const blinding = randomFieldElement();
      const pubKeyX = randomFieldElement();
      const spendingKey = randomFieldElement();

      const commitment = await computeCommitment(amount, blinding, pubKeyX);
      const nullifier = await computeNullifier(commitment, spendingKey);

      await pool.connect(alice).deposit(commitment, { value: amount });
      const root = await pool.getLastRoot();

      const out1 = await computeCommitment(
        ethers.parseEther("0.5"),
        randomFieldElement(),
        randomFieldElement()
      );
      const out2 = await computeCommitment(
        ethers.parseEther("0.5"),
        randomFieldElement(),
        randomFieldElement()
      );

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      const rootAfterTransfer = await pool.getLastRoot();

      const freshOut1 = await computeCommitment(
        ethers.parseEther("0.5"),
        randomFieldElement(),
        randomFieldElement()
      );
      const freshOut2 = await computeCommitment(
        ethers.parseEther("0.5"),
        randomFieldElement(),
        randomFieldElement()
      );

      await expect(
        pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          rootAfterTransfer,
          nullifier, // same nullifier reused
          freshOut1,
          freshOut2
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Multiple deposits then batch transfers
  // -------------------------------------------------------------------------

  describe("Multiple deposits then batch transfers", function () {
    it("3 users deposit, transfer between them, all nullifiers and commitments tracked", async function () {
      const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

      // Amounts for each user
      const amountAlice = ethers.parseEther("1");
      const amountBob = ethers.parseEther("2");
      const amountCharlie = ethers.parseEther("3");

      // Compute real commitments
      const aliceCommitment = await computeCommitment(
        amountAlice,
        randomFieldElement(),
        randomFieldElement()
      );
      const bobCommitment = await computeCommitment(
        amountBob,
        randomFieldElement(),
        randomFieldElement()
      );
      const charlieCommitment = await computeCommitment(
        amountCharlie,
        randomFieldElement(),
        randomFieldElement()
      );

      // All three deposit
      await pool
        .connect(alice)
        .deposit(aliceCommitment, { value: amountAlice });
      await pool.connect(bob).deposit(bobCommitment, { value: amountBob });
      await pool
        .connect(charlie)
        .deposit(charlieCommitment, { value: amountCharlie });

      expect(await pool.commitments(aliceCommitment)).to.be.true;
      expect(await pool.commitments(bobCommitment)).to.be.true;
      expect(await pool.commitments(charlieCommitment)).to.be.true;
      expect(await pool.nextIndex()).to.equal(3);

      const rootAfterDeposits = await pool.getLastRoot();

      // Alice transfers to Bob (spend Alice's note, create 2 outputs)
      const aliceSpendingKey = randomFieldElement();
      const aliceNullifier = await computeNullifier(
        aliceCommitment,
        aliceSpendingKey
      );

      const out1 = await computeCommitment(
        amountAlice,
        randomFieldElement(),
        randomFieldElement()
      );
      const out2 = await computeCommitment(
        0n, // zero-value change note
        randomFieldElement(),
        randomFieldElement()
      );

      // Note: out2 cannot be 0 as a field element — only cannot be 0n literal.
      // Our computed Poseidon hash is never zero.
      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterDeposits,
        aliceNullifier,
        out1,
        out2
      );

      expect(await pool.nullifiers(aliceNullifier)).to.be.true;
      expect(await pool.commitments(out1)).to.be.true;
      expect(await pool.commitments(out2)).to.be.true;

      const rootAfterTransfer = await pool.getLastRoot();

      // Bob withdraws his 2 ETH
      const bobSpendingKey = randomFieldElement();
      const bobNullifier = await computeNullifier(bobCommitment, bobSpendingKey);

      const bobBefore = await ethers.provider.getBalance(bob.address);

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterTransfer,
        bobNullifier,
        amountBob,
        bob.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      const bobAfter = await ethers.provider.getBalance(bob.address);
      expect(bobAfter - bobBefore).to.equal(amountBob);
      expect(await pool.nullifiers(bobNullifier)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // 3. Double-spend prevention with real nullifiers
  // -------------------------------------------------------------------------

  describe("Double-spend prevention with real nullifiers", function () {
    it("rejects double-spend: same Poseidon nullifier used twice in withdraw", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const amount = ethers.parseEther("2");
      const blinding = randomFieldElement();
      const pubKeyX = randomFieldElement();
      const spendingKey = randomFieldElement();

      const commitment = await computeCommitment(amount, blinding, pubKeyX);
      const nullifier = await computeNullifier(commitment, spendingKey);

      await pool.connect(alice).deposit(commitment, { value: amount });
      const root = await pool.getLastRoot();

      // First withdrawal — succeeds
      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        ethers.parseEther("1"),
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      expect(await pool.nullifiers(nullifier)).to.be.true;

      const rootAfterWithdraw = await pool.getLastRoot();

      // Second withdrawal with the same nullifier — must revert
      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          rootAfterWithdraw,
          nullifier,
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it("distinct notes produce distinct nullifiers (no collision)", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const amount1 = ethers.parseEther("1");
      const amount2 = ethers.parseEther("2");

      const blinding1 = randomFieldElement();
      const blinding2 = randomFieldElement();
      const pubKey1 = randomFieldElement();
      const pubKey2 = randomFieldElement();
      const spendingKey1 = randomFieldElement();
      const spendingKey2 = randomFieldElement();

      const commitment1 = await computeCommitment(amount1, blinding1, pubKey1);
      const commitment2 = await computeCommitment(amount2, blinding2, pubKey2);

      const nullifier1 = await computeNullifier(commitment1, spendingKey1);
      const nullifier2 = await computeNullifier(commitment2, spendingKey2);

      expect(nullifier1).to.not.equal(nullifier2);

      await pool.connect(alice).deposit(commitment1, { value: amount1 });
      await pool.connect(bob).deposit(commitment2, { value: amount2 });

      const root = await pool.getLastRoot();

      // Spend both nullifiers independently
      const out1a = await computeCommitment(
        amount1,
        randomFieldElement(),
        randomFieldElement()
      );
      const out1b = await computeCommitment(
        0n,
        randomFieldElement(),
        randomFieldElement()
      );

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier1,
        out1a,
        out1b
      );

      const rootAfter1 = await pool.getLastRoot();

      const out2a = await computeCommitment(
        amount2,
        randomFieldElement(),
        randomFieldElement()
      );
      const out2b = await computeCommitment(
        0n,
        randomFieldElement(),
        randomFieldElement()
      );

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfter1,
        nullifier2,
        out2a,
        out2b
      );

      expect(await pool.nullifiers(nullifier1)).to.be.true;
      expect(await pool.nullifiers(nullifier2)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // 4. Withdrawal with change note
  // -------------------------------------------------------------------------

  describe("Withdrawal with change note", function () {
    it("2 ETH deposit — withdraw 1.5 ETH with 0.5 ETH change note in tree", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const depositAmount = ethers.parseEther("2");
      const withdrawAmount = ethers.parseEther("1.5");
      const changeAmount = ethers.parseEther("0.5");

      const blinding = randomFieldElement();
      const pubKeyX = randomFieldElement();
      const spendingKey = randomFieldElement();

      const commitment = await computeCommitment(
        depositAmount,
        blinding,
        pubKeyX
      );
      const nullifier = await computeNullifier(commitment, spendingKey);

      // Change note — new blinding, same owner
      const changeBlinding = randomFieldElement();
      const changeCommitment = await computeCommitment(
        changeAmount,
        changeBlinding,
        pubKeyX
      );

      await pool.connect(alice).deposit(commitment, { value: depositAmount });
      const root = await pool.getLastRoot();

      const bobBefore = await ethers.provider.getBalance(bob.address);

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        withdrawAmount,
        bob.address,
        changeCommitment,
        ethers.ZeroAddress,
        0n
      );

      const bobAfter = await ethers.provider.getBalance(bob.address);

      // Bob received 1.5 ETH
      expect(bobAfter - bobBefore).to.equal(withdrawAmount);
      // Change commitment is now in the Merkle tree
      expect(await pool.commitments(changeCommitment)).to.be.true;
      // Pool retains 0.5 ETH
      expect(
        await ethers.provider.getBalance(await pool.getAddress())
      ).to.equal(changeAmount);
    });

    it("change commitment note can be re-spent in a subsequent transfer", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const depositAmount = ethers.parseEther("2");
      const withdrawAmount = ethers.parseEther("1.5");
      const changeAmount = ethers.parseEther("0.5");

      const pubKeyX = randomFieldElement();
      const spendingKey = randomFieldElement();

      const commitment = await computeCommitment(
        depositAmount,
        randomFieldElement(),
        pubKeyX
      );
      const nullifier = await computeNullifier(commitment, spendingKey);

      const changeBlinding = randomFieldElement();
      const changeCommitment = await computeCommitment(
        changeAmount,
        changeBlinding,
        pubKeyX
      );

      await pool.connect(alice).deposit(commitment, { value: depositAmount });
      const rootBeforeWithdraw = await pool.getLastRoot();

      // Withdraw with change
      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootBeforeWithdraw,
        nullifier,
        withdrawAmount,
        bob.address,
        changeCommitment,
        ethers.ZeroAddress,
        0n
      );

      const rootAfterWithdraw = await pool.getLastRoot();
      expect(await pool.commitments(changeCommitment)).to.be.true;

      // Now spend the change commitment via a transfer
      const changeNullifier = await computeNullifier(changeCommitment, spendingKey);
      const newOut1 = await computeCommitment(
        changeAmount,
        randomFieldElement(),
        randomFieldElement()
      );
      const newOut2 = await computeCommitment(
        0n,
        randomFieldElement(),
        randomFieldElement()
      );

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterWithdraw,
        changeNullifier,
        newOut1,
        newOut2
      );

      expect(await pool.nullifiers(changeNullifier)).to.be.true;
      expect(await pool.commitments(newOut1)).to.be.true;
      expect(await pool.commitments(newOut2)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // 5. Commitment integrity — off-chain vs on-chain consistency
  // -------------------------------------------------------------------------

  describe("Commitment integrity", function () {
    it("on-chain Deposit event commitment matches off-chain Poseidon computation", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const amount = ethers.parseEther("1");
      const blinding = randomFieldElement();
      const pubKeyX = randomFieldElement();

      const commitment = await computeCommitment(amount, blinding, pubKeyX);

      const tx = await pool
        .connect(alice)
        .deposit(commitment, { value: amount });
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      // Extract the Deposit event log
      const poolInterface = pool.interface;
      const depositLog = receipt!.logs
        .map((log) => {
          try {
            return poolInterface.parseLog({ topics: log.topics as string[], data: log.data });
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.name === "Deposit");

      expect(depositLog).to.not.be.null;
      // The indexed commitment in the event must equal our off-chain computation
      expect(depositLog!.args.commitment).to.equal(commitment);
    });

    it("off-chain nullifier matches the spent nullifier tracked on-chain", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const amount = ethers.parseEther("1");
      const blinding = randomFieldElement();
      const pubKeyX = randomFieldElement();
      const spendingKey = randomFieldElement();

      const commitment = await computeCommitment(amount, blinding, pubKeyX);
      const nullifier = await computeNullifier(commitment, spendingKey);

      await pool.connect(alice).deposit(commitment, { value: amount });
      const root = await pool.getLastRoot();

      const out1 = await computeCommitment(
        ethers.parseEther("0.6"),
        randomFieldElement(),
        randomFieldElement()
      );
      const out2 = await computeCommitment(
        ethers.parseEther("0.4"),
        randomFieldElement(),
        randomFieldElement()
      );

      // Nullifier not yet spent
      expect(await pool.nullifiers(nullifier)).to.be.false;

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      // Nullifier now marked spent — matches our off-chain computation
      expect(await pool.nullifiers(nullifier)).to.be.true;
    });

    it("same blinding + amount + pubKey always produces identical commitment", async function () {
      const amount = ethers.parseEther("1");
      const blinding = randomFieldElement();
      const pubKeyX = randomFieldElement();

      const c1 = await computeCommitment(amount, blinding, pubKeyX);
      const c2 = await computeCommitment(amount, blinding, pubKeyX);

      expect(c1).to.equal(c2);
    });

    it("different blinding produces different commitment (binding)", async function () {
      const amount = ethers.parseEther("1");
      const pubKeyX = randomFieldElement();

      const c1 = await computeCommitment(amount, randomFieldElement(), pubKeyX);
      const c2 = await computeCommitment(amount, randomFieldElement(), pubKeyX);

      // Overwhelmingly likely to differ given 31-byte random blindings
      expect(c1).to.not.equal(c2);
    });

    it("different amount produces different commitment (hiding)", async function () {
      const blinding = randomFieldElement();
      const pubKeyX = randomFieldElement();

      const c1 = await computeCommitment(ethers.parseEther("1"), blinding, pubKeyX);
      const c2 = await computeCommitment(ethers.parseEther("2"), blinding, pubKeyX);

      expect(c1).to.not.equal(c2);
    });
  });
});
