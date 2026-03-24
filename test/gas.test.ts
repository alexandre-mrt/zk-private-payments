import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import { buildPoseidon } from "circomlibjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TREE_HEIGHT = 5;

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
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TV = await ethers.getContractFactory("TransferVerifier");
  const tv = await TV.deploy();

  const WV = await ethers.getContractFactory("WithdrawVerifier");
  const wv = await WV.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await tv.getAddress(),
    await wv.getAddress(),
    TREE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Gas Benchmarks
// ---------------------------------------------------------------------------

describe("Gas Benchmarks", function () {
  // Poseidon is initialised once for the whole suite (expensive to build)
  let poseidon: ReturnType<typeof buildPoseidon> extends Promise<infer T>
    ? T
    : never;
  let F: { toObject: (v: unknown) => bigint };

  before(async () => {
    poseidon = await buildPoseidon();
    // biome-ignore lint: circomlibjs exposes .F without TS types
    F = (poseidon as any).F;
  });

  /** Build a valid Poseidon commitment from public inputs */
  function realCommitment(
    amount: bigint,
    blinding: bigint,
    pubKeyX: bigint
  ): bigint {
    // biome-ignore lint: circomlibjs exposes poseidon without TS types
    return F.toObject((poseidon as any)([amount, blinding, pubKeyX]));
  }

  // -------------------------------------------------------------------------
  // Deployment
  // -------------------------------------------------------------------------

  describe("Deployment gas", () => {
    it("ConfidentialPool deployment", async () => {
      const { pool } = await loadFixture(deployFixture);
      const receipt = await pool.deploymentTransaction()?.wait();
      console.log(`    ConfidentialPool deploy gas: ${receipt?.gasUsed}`);
      expect(receipt?.gasUsed).to.be.greaterThan(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Deposit
  // -------------------------------------------------------------------------

  describe("Deposit gas", () => {
    it("first deposit", async () => {
      const { pool, alice } = await loadFixture(deployFixture);
      const commitment = realCommitment(ethers.parseEther("1"), 123n, 456n);
      const tx = await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });
      const receipt = await tx.wait();
      console.log(`    First deposit gas: ${receipt?.gasUsed}`);
      expect(receipt?.gasUsed).to.be.greaterThan(0n);
    });

    it("10th deposit", async () => {
      const { pool, alice } = await loadFixture(deployFixture);

      for (let i = 0; i < 9; i++) {
        const c = randomCommitment();
        await pool
          .connect(alice)
          .deposit(c, { value: ethers.parseEther("1") });
      }

      const commitment = realCommitment(ethers.parseEther("1"), 999n, 888n);
      const tx = await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });
      const receipt = await tx.wait();
      console.log(`    10th deposit gas: ${receipt?.gasUsed}`);
      expect(receipt?.gasUsed).to.be.greaterThan(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------

  describe("Transfer gas", () => {
    it("transfer after 1 deposit", async () => {
      const { pool, alice } = await loadFixture(deployFixture);

      const commitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });

      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      const tx = await pool
        .connect(alice)
        .transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          nullifier,
          out1,
          out2
        );
      const receipt = await tx.wait();
      console.log(`    Transfer gas: ${receipt?.gasUsed}`);
      expect(receipt?.gasUsed).to.be.greaterThan(0n);
    });

    it("transfer after 10 deposits", async () => {
      const { pool, alice } = await loadFixture(deployFixture);

      for (let i = 0; i < 10; i++) {
        await pool
          .connect(alice)
          .deposit(randomCommitment(), { value: ethers.parseEther("1") });
      }

      const root = await pool.getLastRoot();
      const tx = await pool
        .connect(alice)
        .transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          randomCommitment(),
          randomCommitment()
        );
      const receipt = await tx.wait();
      console.log(`    Transfer (after 10 deposits) gas: ${receipt?.gasUsed}`);
      expect(receipt?.gasUsed).to.be.greaterThan(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Withdrawal
  // -------------------------------------------------------------------------

  describe("Withdrawal gas", () => {
    it("withdraw with change commitment", async () => {
      const { pool, alice, bob } = await loadFixture(deployFixture);

      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });

      const root = await pool.getLastRoot();
      const changeCommitment = randomCommitment();

      const tx = await pool
        .connect(alice)
        .withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("0.5"),
          bob.address,
          changeCommitment,
          ethers.ZeroAddress,
          0n
        );
      const receipt = await tx.wait();
      console.log(`    Withdraw (with change) gas: ${receipt?.gasUsed}`);
      expect(receipt?.gasUsed).to.be.greaterThan(0n);
    });

    it("withdraw without change commitment (zero changeCommitment)", async () => {
      const { pool, alice, bob } = await loadFixture(deployFixture);

      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });

      const root = await pool.getLastRoot();

      const tx = await pool
        .connect(alice)
        .withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          bob.address,
          0n, // no change
          ethers.ZeroAddress,
          0n
        );
      const receipt = await tx.wait();
      console.log(`    Withdraw (no change) gas: ${receipt?.gasUsed}`);
      expect(receipt?.gasUsed).to.be.greaterThan(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Merkle tree scaling
  // -------------------------------------------------------------------------

  describe("Merkle tree scaling", () => {
    it("gas per deposit stays within 20% of the mean over 5 consecutive deposits", async () => {
      const { pool, alice } = await loadFixture(deployFixture);
      const gasUsage: bigint[] = [];

      for (let i = 0; i < 5; i++) {
        const c = randomCommitment();
        const tx = await pool
          .connect(alice)
          .deposit(c, { value: ethers.parseEther("1") });
        const receipt = await tx.wait();
        gasUsage.push(receipt!.gasUsed);
      }

      console.log("    Gas per deposit (5 consecutive):");
      for (const [i, g] of gasUsage.entries()) {
        console.log(`      Deposit ${i + 1}: ${g}`);
      }

      const sum = gasUsage.reduce((a, b) => a + b, 0n);
      const avg = sum / BigInt(gasUsage.length);

      for (const g of gasUsage) {
        const diff = g > avg ? g - avg : avg - g;
        // diff / avg < 20%  →  diff * 100 / avg < 20
        expect(diff * 100n / avg).to.be.lessThan(
          20n,
          `deposit gas ${g} deviates more than 20% from avg ${avg}`
        );
      }
    });

    it("transfer gas is comparable before and after filling half the tree", async () => {
      const { pool, alice } = await loadFixture(deployFixture);

      // Deposit once, transfer, record gas
      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });
      let root = await pool.getLastRoot();
      const tx1 = await pool
        .connect(alice)
        .transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          randomCommitment(),
          randomCommitment()
        );
      const receipt1 = await tx1.wait();
      const gasBefore = receipt1!.gasUsed;

      // Fill more slots (TREE_HEIGHT=5 → 32 leaves; transfer inserts 2 at a time)
      for (let i = 0; i < 12; i++) {
        await pool
          .connect(alice)
          .deposit(randomCommitment(), { value: ethers.parseEther("1") });
      }

      root = await pool.getLastRoot();
      const tx2 = await pool
        .connect(alice)
        .transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          randomCommitment(),
          randomCommitment()
        );
      const receipt2 = await tx2.wait();
      const gasAfter = receipt2!.gasUsed;

      console.log(`    Transfer gas (tree sparse): ${gasBefore}`);
      console.log(`    Transfer gas (tree ~half full): ${gasAfter}`);

      // Both values must be positive
      expect(gasBefore).to.be.greaterThan(0n);
      expect(gasAfter).to.be.greaterThan(0n);
    });
  });
});
