import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
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

// Produces a random field element (31 bytes ensures < FIELD_SIZE)
function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier =
    await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier =
    await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5, // small tree for tests (32 leaves)
    hasherAddress
  );

  return { pool, owner, alice, bob, relayer };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deposits into the pool and returns the current (post-deposit) root.
 */
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

describe("ConfidentialPool", function () {
  // -------------------------------------------------------------------------
  // 1. Deployment
  // -------------------------------------------------------------------------

  describe("Deployment", function () {
    it("stores transferVerifier address", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const addr = await pool.transferVerifier();
      expect(addr).to.be.properAddress;
      expect(addr).to.not.equal(ethers.ZeroAddress);
    });

    it("stores withdrawVerifier address", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const addr = await pool.withdrawVerifier();
      expect(addr).to.be.properAddress;
      expect(addr).to.not.equal(ethers.ZeroAddress);
    });

    it("sets the correct tree height", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.levels()).to.equal(5);
    });

    it("starts with nextIndex = 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.nextIndex()).to.equal(0);
    });

    it("has a non-zero initial root", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const root = await pool.getLastRoot();
      expect(root).to.not.equal(0n);
    });

    it("reverts when transferVerifier is zero address", async function () {
      const [signer] = await ethers.getSigners();
      const hasherAddress = await deployHasher();
      const WithdrawVerifier =
        await ethers.getContractFactory("WithdrawVerifier");
      const withdrawVerifier = await WithdrawVerifier.deploy();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      await expect(
        Pool.deploy(
          ethers.ZeroAddress,
          await withdrawVerifier.getAddress(),
          5,
          hasherAddress
        )
      ).to.be.revertedWith("ConfidentialPool: zero transfer verifier");
    });

    it("stores the deployment chain ID (31337 for Hardhat)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.deployedChainId()).to.equal(31337n);
    });

    it("deposit succeeds on the correct chain", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      await expect(
        pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") })
      ).to.emit(pool, "Deposit");
    });

    it("reverts when withdrawVerifier is zero address", async function () {
      const hasherAddress = await deployHasher();
      const TransferVerifier =
        await ethers.getContractFactory("TransferVerifier");
      const transferVerifier = await TransferVerifier.deploy();
      const Pool = await ethers.getContractFactory("ConfidentialPool");
      await expect(
        Pool.deploy(
          await transferVerifier.getAddress(),
          ethers.ZeroAddress,
          5,
          hasherAddress
        )
      ).to.be.revertedWith("ConfidentialPool: zero withdraw verifier");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Deposit
  // -------------------------------------------------------------------------

  describe("Deposit", function () {
    it("emits Deposit event with correct fields", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      const value = ethers.parseEther("1");

      await expect(pool.connect(alice).deposit(commitment, { value }))
        .to.emit(pool, "Deposit")
        .withArgs(commitment, 0, value, await ethers.provider.getBlock("latest").then((b) => b!.timestamp + 1));
    });

    it("marks commitment as stored", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      expect(await pool.commitments(commitment)).to.be.true;
    });

    it("increments nextIndex after deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });
      expect(await pool.nextIndex()).to.equal(1);
    });

    it("updates the Merkle root after deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const rootBefore = await pool.getLastRoot();
      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });
      const rootAfter = await pool.getLastRoot();
      expect(rootAfter).to.not.equal(rootBefore);
    });

    it("accepts the pool ETH balance", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const value = ethers.parseEther("2.5");
      await pool.connect(alice).deposit(randomCommitment(), { value });
      expect(
        await ethers.provider.getBalance(await pool.getAddress())
      ).to.equal(value);
    });

    it("reverts when commitment is zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).deposit(0n, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: zero commitment");
    });

    it("reverts when msg.value is zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: zero deposit");
    });

    it("reverts on duplicate commitment", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(commitment, { value: ethers.parseEther("1") });
      await expect(
        pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
    });

    it("reverts when commitment >= FIELD_SIZE", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool
          .connect(alice)
          .deposit(FIELD_SIZE, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: commitment >= field size");
    });

    it("multiple deposits all mark commitments correctly", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const c1 = randomCommitment();
      const c2 = randomCommitment();
      await pool.connect(alice).deposit(c1, { value: ethers.parseEther("1") });
      await pool.connect(bob).deposit(c2, { value: ethers.parseEther("1") });
      expect(await pool.commitments(c1)).to.be.true;
      expect(await pool.commitments(c2)).to.be.true;
      expect(await pool.nextIndex()).to.equal(2);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Transfer
  // -------------------------------------------------------------------------

  describe("Transfer", function () {
    it("marks the nullifier as spent after transfer", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment);
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      expect(await pool.nullifiers(nullifier)).to.be.true;
    });

    it("inserts both output commitments into the tree", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment);
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        out1,
        out2
      );

      expect(await pool.commitments(out1)).to.be.true;
      expect(await pool.commitments(out2)).to.be.true;
    });

    it("emits Transfer event with correct args", async function () {
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

    it("updates the Merkle root after transfer", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment);

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );

      const rootAfter = await pool.getLastRoot();
      expect(rootAfter).to.not.equal(root);
    });

    it("reverts on double-spend (nullifier already spent)", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment);
      const nullifier = randomCommitment();

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        randomCommitment(),
        randomCommitment()
      );

      // Must get fresh root since tree state changed
      const rootAfter = await pool.getLastRoot();

      await expect(
        pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          rootAfter,
          nullifier,
          randomCommitment(),
          randomCommitment()
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it("reverts for unknown root", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const fakeRoot = randomCommitment();

      await expect(
        pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          fakeRoot,
          randomCommitment(),
          randomCommitment(),
          randomCommitment()
        )
      ).to.be.revertedWith("ConfidentialPool: unknown root");
    });

    it("reverts when outputCommitment1 is zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(pool, alice, randomCommitment());

      await expect(
        pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          0n,
          randomCommitment()
        )
      ).to.be.revertedWith("ConfidentialPool: zero output commitment");
    });

    it("reverts when outputCommitment2 is zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(pool, alice, randomCommitment());

      await expect(
        pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          randomCommitment(),
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: zero output commitment");
    });

    it("transfer doesn't change pool ETH balance", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const commitment = randomCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment, depositAmount);

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

    it("consecutive transfers with different nullifiers both succeed", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const commitment = randomCommitment();
      const root = await depositAndGetRoot(pool, alice, commitment, depositAmount);

      const nullifier1 = randomCommitment();
      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier1,
        randomCommitment(),
        randomCommitment()
      );

      const rootAfterFirst = await pool.getLastRoot();
      const nullifier2 = randomCommitment();
      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterFirst,
        nullifier2,
        randomCommitment(),
        randomCommitment()
      );

      expect(await pool.nullifiers(nullifier1)).to.be.true;
      expect(await pool.nullifiers(nullifier2)).to.be.true;
    });

    it("reverts when outputCommitment1 >= FIELD_SIZE", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(pool, alice, randomCommitment());

      await expect(
        pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          FIELD_SIZE,
          randomCommitment()
        )
      ).to.be.revertedWith("ConfidentialPool: output commitment >= field size");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Withdrawal
  // -------------------------------------------------------------------------

  describe("Withdrawal", function () {
    it("sends ETH to recipient and marks nullifier spent", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        depositAmount
      );
      const nullifier = randomCommitment();
      const withdrawAmount = ethers.parseEther("0.5");

      const bobBefore = await ethers.provider.getBalance(bob.address);

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        withdrawAmount,
        bob.address,
        0n, // no change commitment
        ethers.ZeroAddress,
        0n
      );

      const bobAfter = await ethers.provider.getBalance(bob.address);
      expect(bobAfter - bobBefore).to.equal(withdrawAmount);
      expect(await pool.nullifiers(nullifier)).to.be.true;
    });

    it("emits Withdrawal event with correct args", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        depositAmount
      );
      const nullifier = randomCommitment();
      const withdrawAmount = ethers.parseEther("1");

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          nullifier,
          withdrawAmount,
          bob.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      )
        .to.emit(pool, "Withdrawal")
        .withArgs(nullifier, withdrawAmount, bob.address, 0n, ethers.ZeroAddress, 0n);
    });

    it("inserts change commitment when non-zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("2");
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        depositAmount
      );
      const changeCommitment = randomCommitment();
      const recipientAddr = alice.address;

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        ethers.parseEther("1"),
        recipientAddr,
        changeCommitment,
        ethers.ZeroAddress,
        0n
      );

      expect(await pool.commitments(changeCommitment)).to.be.true;
    });

    it("does not insert change commitment when zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        ethers.parseEther("1")
      );

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        ethers.parseEther("1"),
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      // nextIndex advanced by 1 (deposit) but NOT by withdrawal without change
      expect(await pool.nextIndex()).to.equal(1);
    });

    it("reverts on double-spend", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("2");
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        depositAmount
      );
      const nullifier = randomCommitment();

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

      const rootAfter = await pool.getLastRoot();

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          rootAfter,
          nullifier,
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it("reverts for unknown root", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          randomCommitment(),
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: unknown root");
    });

    it("reverts when recipient is zero address", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        ethers.parseEther("1")
      );

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          ethers.ZeroAddress,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: zero recipient");
    });

    it("reverts when amount is zero", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        ethers.parseEther("1")
      );

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          0n,
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: zero withdrawal amount");
    });

    it("reverts when pool balance is insufficient", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        ethers.parseEther("1")
      );

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("10"), // more than deposited
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: insufficient pool balance");
    });

    it("reverts when changeCommitment >= FIELD_SIZE", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        ethers.parseEther("1")
      );

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          FIELD_SIZE,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: change commitment >= field size");
    });

    it("withdraw with fee: recipient gets (amount - fee), relayer gets fee", async function () {
      const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositAmount);

      const withdrawAmount = ethers.parseEther("1");
      const fee = ethers.parseEther("0.01");
      const recipientAmount = withdrawAmount - fee;

      const bobBefore = await ethers.provider.getBalance(bob.address);
      const relayerBefore = await ethers.provider.getBalance(relayer.address);

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        withdrawAmount,
        bob.address,
        0n,
        relayer.address,
        fee
      );

      const bobAfter = await ethers.provider.getBalance(bob.address);
      const relayerAfter = await ethers.provider.getBalance(relayer.address);

      expect(bobAfter - bobBefore).to.equal(recipientAmount);
      expect(relayerAfter - relayerBefore).to.equal(fee);
    });

    it("reverts when fee exceeds amount", async function () {
      const { pool, alice, bob, relayer } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        ethers.parseEther("1")
      );

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          bob.address,
          0n,
          relayer.address,
          ethers.parseEther("1.01") // fee > amount
        )
      ).to.be.revertedWith("ConfidentialPool: fee exceeds amount");
    });

    it("reverts when non-zero fee is paired with zero relayer address", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(
        pool,
        alice,
        randomCommitment(),
        ethers.parseEther("1")
      );

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          bob.address,
          0n,
          ethers.ZeroAddress, // zero relayer
          ethers.parseEther("0.01") // non-zero fee
        )
      ).to.be.revertedWith("ConfidentialPool: zero relayer for non-zero fee");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Integration
  // -------------------------------------------------------------------------

  describe("Integration", function () {
    it("deposit → transfer → withdraw flow", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      // Alice deposits 1 ETH
      const depositCommitment = randomCommitment();
      await pool
        .connect(alice)
        .deposit(depositCommitment, { value: ethers.parseEther("1") });
      const rootAfterDeposit = await pool.getLastRoot();

      // Transfer: spend deposit commitment, create 2 new commitments
      const transferNullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();
      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterDeposit,
        transferNullifier,
        out1,
        out2
      );
      const rootAfterTransfer = await pool.getLastRoot();

      // Withdraw: send 1 ETH to Bob, no change
      const withdrawNullifier = randomCommitment();
      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterTransfer,
        withdrawNullifier,
        ethers.parseEther("1"),
        bob.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      expect(await pool.nullifiers(transferNullifier)).to.be.true;
      expect(await pool.nullifiers(withdrawNullifier)).to.be.true;
      expect(
        await ethers.provider.getBalance(await pool.getAddress())
      ).to.equal(0n);
    });

    it("multiple deposits then transfer", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      // Three deposits from different users
      const c1 = randomCommitment();
      const c2 = randomCommitment();
      const c3 = randomCommitment();
      await pool.connect(alice).deposit(c1, { value: ethers.parseEther("1") });
      await pool.connect(bob).deposit(c2, { value: ethers.parseEther("1") });
      await pool.connect(alice).deposit(c3, { value: ethers.parseEther("1") });

      const rootAfterDeposits = await pool.getLastRoot();
      expect(await pool.nextIndex()).to.equal(3);

      // Transfer using that root
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();
      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterDeposits,
        nullifier,
        out1,
        out2
      );

      expect(await pool.nextIndex()).to.equal(5); // 3 deposits + 2 outputs
    });

    it("withdrawal with change commitment completes full UTXO cycle", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("3");

      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: depositAmount });
      const root = await pool.getLastRoot();

      const changeCommitment = randomCommitment();
      const withdrawAmount = ethers.parseEther("2");
      const nullifier = randomCommitment();

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        withdrawAmount,
        alice.address,
        changeCommitment,
        ethers.ZeroAddress,
        0n
      );

      // Change commitment should be in the tree
      expect(await pool.commitments(changeCommitment)).to.be.true;
      // Pool retains 1 ETH
      expect(
        await ethers.provider.getBalance(await pool.getAddress())
      ).to.equal(ethers.parseEther("1"));
    });

    it("isKnownRoot returns false for zero", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.isKnownRoot(0n)).to.be.false;
    });

    it("isKnownRoot returns true for current root", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") });
      const root = await pool.getLastRoot();
      expect(await pool.isKnownRoot(root)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // 6. BatchDeposit
  // -------------------------------------------------------------------------

  describe("BatchDeposit", function () {
    it("deposits 3 notes: commitments stored, events emitted, root changes", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
      const amounts = [
        ethers.parseEther("1"),
        ethers.parseEther("2"),
        ethers.parseEther("0.5"),
      ];
      const totalAmount = amounts.reduce((a, b) => a + b, 0n);

      const rootBefore = await pool.getLastRoot();

      const tx = await pool.connect(alice).batchDeposit(commitments, amounts, { value: totalAmount });
      const receipt = await tx.wait();

      // All commitments stored
      for (const c of commitments) {
        expect(await pool.commitments(c)).to.be.true;
      }

      // nextIndex advanced by 3
      expect(await pool.nextIndex()).to.equal(3);

      // Root changed
      const rootAfter = await pool.getLastRoot();
      expect(rootAfter).to.not.equal(rootBefore);

      // 3 Deposit events emitted
      const depositEvents = receipt!.logs.filter(
        (log) => pool.interface.parseLog(log)?.name === "Deposit"
      );
      expect(depositEvents.length).to.equal(3);
    });

    it("reverts when total amount does not match msg.value", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: incorrect total amount");
    });

    it("reverts when a commitment is duplicated within the batch", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = randomCommitment();
      const commitments = [c, c];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ethers.parseEther("2") })
      ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
    });

    it("reverts when a commitment was already deposited individually", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = randomCommitment();
      await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });

      const commitments = [randomCommitment(), c];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ethers.parseEther("2") })
      ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
    });

    it("reverts when batch is empty", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).batchDeposit([], [], { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: empty batch");
    });

    it("pool balance tracks correctly after batch deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments = [randomCommitment(), randomCommitment(), randomCommitment()];
      const amounts = [
        ethers.parseEther("1"),
        ethers.parseEther("2"),
        ethers.parseEther("0.5"),
      ];
      const totalAmount = amounts.reduce((a, b) => a + b, 0n);

      await pool.connect(alice).batchDeposit(commitments, amounts, { value: totalAmount });

      expect(await pool.getPoolBalance()).to.equal(totalAmount);
      expect(
        await ethers.provider.getBalance(await pool.getAddress())
      ).to.equal(totalAmount);
    });

    it("reverts when batch exceeds 10 commitments", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments = Array.from({ length: 11 }, () => randomCommitment());
      const amounts = Array.from({ length: 11 }, () => ethers.parseEther("1"));
      const total = ethers.parseEther("11");

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.be.revertedWith("ConfidentialPool: batch too large");
    });

    it("reverts when arrays have different lengths", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ethers.parseEther("1")];

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: arrays length mismatch");
    });

    it("respects denomination restrictions", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const d = ethers.parseEther("1");
      await pool.connect(owner).addDenomination(d);

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [d, ethers.parseEther("0.5")]; // second is not allowed
      const total = d + ethers.parseEther("0.5");

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });

    it("accepts batch when all amounts match allowed denomination", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const d = ethers.parseEther("1");
      await pool.connect(owner).addDenomination(d);

      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [d, d];
      const total = d * 2n;

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.emit(pool, "Deposit");
    });

    it("reverts when paused", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).pause();

      const commitments = [randomCommitment()];
      const amounts = [ethers.parseEther("1")];

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------
  // 7. View / Getter functions
  // -------------------------------------------------------------------------

  describe("View functions", function () {
    it("isSpent returns false before any withdrawal", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const nullifier = randomCommitment();
      expect(await pool.isSpent(nullifier)).to.be.false;
    });

    it("isSpent returns true after withdrawal", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), ethers.parseEther("1"));
      const nullifier = randomCommitment();
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
      expect(await pool.isSpent(nullifier)).to.be.true;
    });

    it("isCommitted returns false before deposit", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      expect(await pool.isCommitted(commitment)).to.be.false;
    });

    it("isCommitted returns true after deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      expect(await pool.isCommitted(commitment)).to.be.true;
    });

    it("getDepositCount returns 0 before any deposit", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getDepositCount()).to.equal(0);
    });

    it("getDepositCount increments with each deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      expect(await pool.getDepositCount()).to.equal(1);
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      expect(await pool.getDepositCount()).to.equal(2);
    });

    it("getDepositCount matches nextIndex", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      expect(await pool.getDepositCount()).to.equal(await pool.nextIndex());
    });

    it("getPoolBalance returns 0 before any deposit", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getPoolBalance()).to.equal(0n);
    });

    it("getPoolBalance matches contract ETH balance after deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const value = ethers.parseEther("2.5");
      await pool.connect(alice).deposit(randomCommitment(), { value });
      expect(await pool.getPoolBalance()).to.equal(value);
      expect(await pool.getPoolBalance()).to.equal(
        await ethers.provider.getBalance(await pool.getAddress())
      );
    });

    it("getPoolBalance decreases after withdrawal", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositValue = ethers.parseEther("2");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositValue);
      const withdrawAmount = ethers.parseEther("1");

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        withdrawAmount,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      expect(await pool.getPoolBalance()).to.equal(depositValue - withdrawAmount);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Denominations
  // -------------------------------------------------------------------------

  describe("Denominations", function () {
    it("addDenomination by owner succeeds and emits event", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const d = ethers.parseEther("1");
      await expect(pool.connect(owner).addDenomination(d))
        .to.emit(pool, "DenominationAdded")
        .withArgs(d);
      expect(await pool.allowedDenominations(d)).to.be.true;
    });

    it("getDenominations returns the full list", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const d1 = ethers.parseEther("0.1");
      const d2 = ethers.parseEther("1");
      await pool.connect(owner).addDenomination(d1);
      await pool.connect(owner).addDenomination(d2);
      const list = await pool.getDenominations();
      expect(list.length).to.equal(2);
      expect(list[0]).to.equal(d1);
      expect(list[1]).to.equal(d2);
    });

    it("removeDenomination by owner succeeds and emits event", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const d = ethers.parseEther("1");
      await pool.connect(owner).addDenomination(d);
      await expect(pool.connect(owner).removeDenomination(d))
        .to.emit(pool, "DenominationRemoved")
        .withArgs(d);
      expect(await pool.allowedDenominations(d)).to.be.false;
    });

    it("deposit with allowed denomination succeeds", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const d = ethers.parseEther("1");
      await pool.connect(owner).addDenomination(d);
      const commitment = randomCommitment();
      await expect(pool.connect(alice).deposit(commitment, { value: d }))
        .to.emit(pool, "Deposit");
    });

    it("deposit with non-allowed denomination reverts", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).addDenomination(ethers.parseEther("1"));
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("0.5") })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });

    it("only owner can add denomination", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).addDenomination(ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("only owner can remove denomination", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).addDenomination(ethers.parseEther("1"));
      await expect(
        pool.connect(alice).removeDenomination(ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("addDenomination reverts for zero value", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(owner).addDenomination(0n)
      ).to.be.revertedWith("ConfidentialPool: zero denomination");
    });

    it("addDenomination reverts for duplicate", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      const d = ethers.parseEther("1");
      await pool.connect(owner).addDenomination(d);
      await expect(
        pool.connect(owner).addDenomination(d)
      ).to.be.revertedWith("ConfidentialPool: denomination exists");
    });

    it("removeDenomination reverts when denomination not found", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(owner).removeDenomination(ethers.parseEther("1"))
      ).to.be.revertedWith("ConfidentialPool: denomination not found");
    });

    it("when no denominations set, any amount is accepted (backwards compatible)", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      // No denominations configured — any non-zero amount works
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("0.123") })
      ).to.emit(pool, "Deposit");
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("7.77") })
      ).to.emit(pool, "Deposit");
    });

    it("deposit after removing denomination reverts with non-allowed amount", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const d = ethers.parseEther("1");
      await pool.connect(owner).addDenomination(d);
      await pool.connect(owner).removeDenomination(d);
      // denominationList still has one entry but allowedDenominations[d] is false
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: d })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });
  });

  // -------------------------------------------------------------------------
  // 9. MinDepositAge (withdrawal timelock)
  // -------------------------------------------------------------------------

  describe("MinDepositAge", function () {
    it("defaults to 0 (disabled) and allows immediate withdrawal after deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      expect(await pool.minDepositAge()).to.equal(0n);

      const root = await depositAndGetRoot(pool, alice, randomCommitment(), ethers.parseEther("1"));

      // Should succeed immediately with minDepositAge == 0
      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.not.be.reverted;
    });

    it("only owner can call setMinDepositAge", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await expect(
        pool.connect(alice).setMinDepositAge(5n)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setMinDepositAge emits MinDepositAgeUpdated event", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);
      await expect(pool.connect(owner).setMinDepositAge(5n))
        .to.emit(pool, "MinDepositAgeUpdated")
        .withArgs(5n);
    });

    it("reverts withdrawal when called too soon after last deposit", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setMinDepositAge(5n);

      const root = await depositAndGetRoot(pool, alice, randomCommitment(), ethers.parseEther("1"));

      // Attempt withdrawal immediately — should revert
      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: withdrawal too soon after last deposit");
    });

    it("allows withdrawal after the required number of blocks have elapsed", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setMinDepositAge(5n);

      const root = await depositAndGetRoot(pool, alice, randomCommitment(), ethers.parseEther("1"));

      // Advance 5 blocks
      await mine(5);

      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.not.be.reverted;
    });

    it("resetting minDepositAge to 0 allows immediate withdrawal", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setMinDepositAge(5n);

      const root = await depositAndGetRoot(pool, alice, randomCommitment(), ethers.parseEther("1"));

      // Reset delay to 0
      await pool.connect(owner).setMinDepositAge(0n);

      // Should now succeed immediately
      await expect(
        pool.withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          randomCommitment(),
          ethers.parseEther("1"),
          alice.address,
          0n,
          ethers.ZeroAddress,
          0n
        )
      ).to.not.be.reverted;
    });

    it("lastDepositBlock is updated on single deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const blockBefore = await ethers.provider.getBlockNumber();
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      const lastDepositBlock = await pool.lastDepositBlock();
      expect(lastDepositBlock).to.be.greaterThan(blockBefore);
    });

    it("lastDepositBlock is updated on batchDeposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const blockBefore = await ethers.provider.getBlockNumber();
      const commitments = [randomCommitment(), randomCommitment()];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];
      await pool.connect(alice).batchDeposit(commitments, amounts, { value: ethers.parseEther("2") });
      const lastDepositBlock = await pool.lastDepositBlock();
      expect(lastDepositBlock).to.be.greaterThan(blockBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Root History
  // -------------------------------------------------------------------------

  describe("Root History", function () {
    it("getRootHistory returns array of length ROOT_HISTORY_SIZE (30)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const history = await pool.getRootHistory();
      expect(history.length).to.equal(30);
    });

    it("getRootHistory first slot is the initial non-zero root", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const history = await pool.getRootHistory();
      const lastRoot = await pool.getLastRoot();
      expect(history[0]).to.equal(lastRoot);
    });

    it("getValidRootCount is 1 before any deposit (only initial root)", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.getValidRootCount()).to.equal(1);
    });

    it("after 1 deposit, getRootHistory contains at least 2 non-zero entries", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      const history = await pool.getRootHistory();
      const nonZero = history.filter((r) => r !== 0n);
      expect(nonZero.length).to.be.at.least(2);
    });

    it("getValidRootCount increases after each deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const countBefore = await pool.getValidRootCount();
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      const countAfter = await pool.getValidRootCount();
      expect(countAfter).to.be.greaterThan(countBefore);
    });

    it("most recent root in getRootHistory matches getLastRoot after deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      const lastRoot = await pool.getLastRoot();
      const history = await pool.getRootHistory();
      expect(history.some((r) => r === lastRoot)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // 10. Analytics / Stats
  // -------------------------------------------------------------------------

  describe("Analytics", function () {
    it("totalDeposited starts at 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.totalDeposited()).to.equal(0n);
    });

    it("totalDeposited increments on deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const value = ethers.parseEther("1.5");
      await pool.connect(alice).deposit(randomCommitment(), { value });
      expect(await pool.totalDeposited()).to.equal(value);
    });

    it("totalDeposited accumulates across multiple deposits", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const v1 = ethers.parseEther("1");
      const v2 = ethers.parseEther("2");
      await pool.connect(alice).deposit(randomCommitment(), { value: v1 });
      await pool.connect(bob).deposit(randomCommitment(), { value: v2 });
      expect(await pool.totalDeposited()).to.equal(v1 + v2);
    });

    it("totalDeposited increments on batchDeposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amounts = [ethers.parseEther("1"), ethers.parseEther("2")];
      const total = amounts[0] + amounts[1];
      await pool.connect(alice).batchDeposit(
        [randomCommitment(), randomCommitment()],
        amounts,
        { value: total }
      );
      expect(await pool.totalDeposited()).to.equal(total);
    });

    it("totalWithdrawn starts at 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.totalWithdrawn()).to.equal(0n);
    });

    it("totalWithdrawn increments on withdrawal", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositValue = ethers.parseEther("2");
      const withdrawAmount = ethers.parseEther("1");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositValue);
      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        withdrawAmount,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      expect(await pool.totalWithdrawn()).to.equal(withdrawAmount);
    });

    it("totalWithdrawn accumulates across multiple withdrawals", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const v1 = ethers.parseEther("1");
      const v2 = ethers.parseEther("0.5");

      const root1 = await depositAndGetRoot(pool, alice, randomCommitment(), ethers.parseEther("2"));
      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root1,
        randomCommitment(),
        v1,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      const root2 = await pool.getLastRoot();
      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root2,
        randomCommitment(),
        v2,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      expect(await pool.totalWithdrawn()).to.equal(v1 + v2);
    });

    it("withdrawalCount starts at 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.withdrawalCount()).to.equal(0n);
    });

    it("withdrawalCount increments on each withdrawal", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositValue = ethers.parseEther("3");
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), depositValue);

      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        ethers.parseEther("1"),
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      expect(await pool.withdrawalCount()).to.equal(1n);

      const root2 = await pool.getLastRoot();
      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root2,
        randomCommitment(),
        ethers.parseEther("1"),
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );
      expect(await pool.withdrawalCount()).to.equal(2n);
    });

    it("totalTransfers starts at 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.totalTransfers()).to.equal(0n);
    });

    it("totalTransfers increments on each transfer", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const root = await depositAndGetRoot(pool, alice, randomCommitment(), ethers.parseEther("1"));

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );
      expect(await pool.totalTransfers()).to.equal(1n);

      const root2 = await pool.getLastRoot();
      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root2,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );
      expect(await pool.totalTransfers()).to.equal(2n);
    });

    it("uniqueDepositorCount starts at 0", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      expect(await pool.uniqueDepositorCount()).to.equal(0n);
    });

    it("uniqueDepositorCount increments for the first deposit by a new address", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      expect(await pool.uniqueDepositorCount()).to.equal(1n);
      await pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      expect(await pool.uniqueDepositorCount()).to.equal(2n);
    });

    it("uniqueDepositorCount does not increment for repeat deposits by same address", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
      expect(await pool.uniqueDepositorCount()).to.equal(1n);
    });

    it("uniqueDepositorCount tracks batchDeposit callers as unique depositors", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];
      const total = amounts[0] + amounts[1];
      await pool.connect(alice).batchDeposit(
        [randomCommitment(), randomCommitment()],
        amounts,
        { value: total }
      );
      expect(await pool.uniqueDepositorCount()).to.equal(1n);
    });

    it("getPoolStats returns all values correctly", async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const depositValue = ethers.parseEther("3");
      const withdrawAmount = ethers.parseEther("1");

      // Two distinct depositors
      await pool.connect(alice).deposit(randomCommitment(), { value: depositValue });
      await pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") });

      const rootAfterDeposits = await pool.getLastRoot();

      // One transfer
      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterDeposits,
        randomCommitment(),
        randomCommitment(),
        randomCommitment()
      );

      const rootAfterTransfer = await pool.getLastRoot();

      // One withdrawal of 1 ETH from alice's 3 ETH deposit
      await pool.withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterTransfer,
        randomCommitment(),
        withdrawAmount,
        alice.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      const stats = await pool.getPoolStats();
      // _totalDeposited
      expect(stats[0]).to.equal(depositValue + ethers.parseEther("1"));
      // _totalWithdrawn
      expect(stats[1]).to.equal(withdrawAmount);
      // _totalTransfers
      expect(stats[2]).to.equal(1n);
      // _depositCount (nextIndex: 2 deposits + 2 transfer outputs = 4)
      expect(stats[3]).to.equal(await pool.nextIndex());
      // _withdrawalCount
      expect(stats[4]).to.equal(1n);
      // _uniqueDepositors
      expect(stats[5]).to.equal(2n);
      // _poolBalance
      expect(stats[6]).to.equal(
        await ethers.provider.getBalance(await pool.getAddress())
      );
    });
  });

  // -------------------------------------------------------------------------
  // Commitment Index
  // -------------------------------------------------------------------------

  describe("Commitment Index", function () {
    it("getCommitmentIndex returns 0 for the first deposit", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      expect(await pool.getCommitmentIndex(commitment)).to.equal(0);
    });

    it("getCommitmentIndex reverts for an unknown commitment", async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const unknown = randomCommitment();
      await expect(pool.getCommitmentIndex(unknown)).to.be.revertedWith(
        "commitment not found"
      );
    });

    it("multiple deposits have sequential indices", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c0 = randomCommitment();
      const c1 = randomCommitment();
      const c2 = randomCommitment();

      await pool.connect(alice).deposit(c0, { value: ethers.parseEther("1") });
      await pool.connect(alice).deposit(c1, { value: ethers.parseEther("1") });
      await pool.connect(alice).deposit(c2, { value: ethers.parseEther("1") });

      expect(await pool.getCommitmentIndex(c0)).to.equal(0);
      expect(await pool.getCommitmentIndex(c1)).to.equal(1);
      expect(await pool.getCommitmentIndex(c2)).to.equal(2);
    });

    it("batchDeposit indexes each commitment sequentially", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c0 = randomCommitment();
      const c1 = randomCommitment();
      const amounts = [ethers.parseEther("1"), ethers.parseEther("2")];
      const total = amounts[0] + amounts[1];

      await pool.connect(alice).batchDeposit([c0, c1], amounts, { value: total });

      expect(await pool.getCommitmentIndex(c0)).to.equal(0);
      expect(await pool.getCommitmentIndex(c1)).to.equal(1);
    });

    it("transfer output commitments are indexed correctly", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositCommitment = randomCommitment();
      const root = await depositAndGetRoot(pool, alice, depositCommitment);
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      // deposit was at index 0; out1 gets index 1, out2 gets index 2
      expect(await pool.getCommitmentIndex(out1)).to.equal(1);
      expect(await pool.getCommitmentIndex(out2)).to.equal(2);
    });

    it("commitmentIndex mapping matches getCommitmentIndex", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = randomCommitment();
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      const fromMapping = await pool.commitmentIndex(commitment);
      const fromGetter = await pool.getCommitmentIndex(commitment);
      expect(fromMapping).to.equal(fromGetter);
    });
  });
});
