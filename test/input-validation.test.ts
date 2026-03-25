import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_UINT256 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ONE_ETH = ethers.parseEther("1");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Standard pool — both placeholder verifiers always return true. */
async function deployPoolFixture() {
  const [owner, alice, bob, relayer, stranger] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  )) as unknown as ConfidentialPool;

  return { pool, owner, alice, bob, relayer, stranger };
}

/**
 * Small-tree pool (height=1 → 2 leaves) for tree-full tests.
 */
async function deploySmallTreePoolFixture() {
  const [owner, alice] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    1, // height 1 = 2 leaves
    hasherAddress
  )) as unknown as ConfidentialPool;

  return { pool, owner, alice };
}

/**
 * Pool with false withdraw verifier — for "invalid withdrawal proof" path.
 */
async function deployPoolFalseWithdrawFixture() {
  const [owner, alice] = await ethers.getSigners();
  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const FalseWithdraw = await ethers.getContractFactory(
    "MockFalseWithdrawVerifier"
  );
  const falseWithdraw = await FalseWithdraw.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await falseWithdraw.getAddress(),
    5,
    hasherAddress
  )) as unknown as ConfidentialPool;

  return { pool, owner, alice };
}

async function depositNote(
  pool: ConfidentialPool,
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  value: bigint = ONE_ETH,
  commitment?: bigint
): Promise<{ commitment: bigint; root: bigint }> {
  const c = commitment ?? randomCommitment();
  await pool.connect(signer).deposit(c, { value });
  const root = await pool.getLastRoot();
  return { commitment: c, root };
}

/** Queue an action and advance time past the timelock. */
async function timelockExecute(
  pool: ConfidentialPool,
  name: string,
  value: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      [name, value]
    )
  );
  await pool.queueAction(actionHash);
  await time.increase(24 * 60 * 60 + 1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Input Validation Exhaustive", function () {
  // -------------------------------------------------------------------------
  // deposit() — invalid commitment values
  // -------------------------------------------------------------------------

  describe("deposit() — invalid commitment values", function () {
    it("deposit(0): zero commitment reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).deposit(0n, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: zero commitment");
    });

    it("deposit(FIELD_SIZE): field overflow reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).deposit(FIELD_SIZE, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: commitment >= field size");
    });

    it("deposit(FIELD_SIZE+1): field overflow reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).deposit(FIELD_SIZE + 1n, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: commitment >= field size");
    });

    it("deposit(MAX_UINT256): field overflow reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).deposit(MAX_UINT256, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: commitment >= field size");
    });

    it("deposit duplicate commitment: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = randomCommitment();

      await pool.connect(alice).deposit(c, { value: ONE_ETH });

      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
    });
  });

  // -------------------------------------------------------------------------
  // deposit() — wrong ETH amounts
  // -------------------------------------------------------------------------

  describe("deposit() — wrong ETH amounts", function () {
    it("deposit with 0 ETH: zero deposit reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: zero deposit");
    });

    it("deposit with denomination amount but denomination list is active: wrong denom reverts", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      // Add 1 ETH denomination through timelock
      await timelockExecute(pool, "addDenomination", ONE_ETH);
      await pool.connect(owner).addDenomination(ONE_ETH);

      // 0.5 ETH is not in the denomination list
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH / 2n })
      ).to.be.revertedWith(
        "ConfidentialPool: amount not an allowed denomination"
      );
    });
  });

  // -------------------------------------------------------------------------
  // deposit() — paused and tree-full states
  // -------------------------------------------------------------------------

  describe("deposit() — pause and capacity states", function () {
    it("deposit when paused: reverts with EnforcedPause", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).pause();

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("deposit when tree full: reverts with MerkleTree: tree is full", async function () {
      const { pool, alice } = await loadFixture(deploySmallTreePoolFixture);

      // Fill both leaves of height=1 tree
      await depositNote(pool, alice);
      await depositNote(pool, alice);

      // Third deposit must revert
      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("MerkleTree: tree is full");
    });
  });

  // -------------------------------------------------------------------------
  // batchDeposit() — invalid inputs
  // -------------------------------------------------------------------------

  describe("batchDeposit() — invalid inputs", function () {
    it("empty batch: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).batchDeposit([], [], { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: empty batch");
    });

    it("batch > 10 entries: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitments = Array.from({ length: 11 }, () => randomCommitment());
      const amounts = Array.from({ length: 11 }, () => ONE_ETH);

      await expect(
        pool
          .connect(alice)
          .batchDeposit(commitments, amounts, { value: ONE_ETH * 11n })
      ).to.be.revertedWith("ConfidentialPool: batch too large");
    });

    it("mismatched arrays (2 commitments, 1 amount): reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool
          .connect(alice)
          .batchDeposit(
            [randomCommitment(), randomCommitment()],
            [ONE_ETH],
            { value: ONE_ETH }
          )
      ).to.be.revertedWith("ConfidentialPool: arrays length mismatch");
    });

    it("wrong total (msg.value < sum of amounts): reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool
          .connect(alice)
          .batchDeposit(
            [randomCommitment(), randomCommitment()],
            [ONE_ETH, ONE_ETH],
            { value: ONE_ETH } // should be 2 ETH
          )
      ).to.be.revertedWith("ConfidentialPool: incorrect total amount");
    });

    it("zero amount in batch entry: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool
          .connect(alice)
          .batchDeposit(
            [randomCommitment(), randomCommitment()],
            [ONE_ETH, 0n],
            { value: ONE_ETH } // total matches but second amount is 0
          )
      ).to.be.revertedWith("ConfidentialPool: zero amount in batch");
    });

    it("zero commitment in batch: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool
          .connect(alice)
          .batchDeposit(
            [randomCommitment(), 0n],
            [ONE_ETH, ONE_ETH],
            { value: ONE_ETH * 2n }
          )
      ).to.be.revertedWith("ConfidentialPool: zero commitment");
    });

    it("field-overflow commitment in batch: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool
          .connect(alice)
          .batchDeposit(
            [randomCommitment(), FIELD_SIZE],
            [ONE_ETH, ONE_ETH],
            { value: ONE_ETH * 2n }
          )
      ).to.be.revertedWith("ConfidentialPool: commitment >= field size");
    });

    it("duplicate commitment in batch (second entry same as first): reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = randomCommitment();

      // Deposit c individually first so it's already committed
      await pool.connect(alice).deposit(c, { value: ONE_ETH });

      await expect(
        pool
          .connect(alice)
          .batchDeposit(
            [randomCommitment(), c],
            [ONE_ETH, ONE_ETH],
            { value: ONE_ETH * 2n }
          )
      ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
    });

    it("batch when paused: reverts with EnforcedPause", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).pause();

      await expect(
        pool
          .connect(alice)
          .batchDeposit(
            [randomCommitment()],
            [ONE_ETH],
            { value: ONE_ETH }
          )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------
  // transfer() — invalid inputs
  // -------------------------------------------------------------------------

  describe("transfer() — invalid inputs", function () {
    it("transfer with zero outputCommitment1: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool
          .connect(alice)
          .transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifier, 0n, randomCommitment())
      ).to.be.revertedWith("ConfidentialPool: zero output commitment");
    });

    it("transfer with zero outputCommitment2: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool
          .connect(alice)
          .transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifier, randomCommitment(), 0n)
      ).to.be.revertedWith("ConfidentialPool: zero output commitment");
    });

    it("transfer with field-overflow outputCommitment1: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool
          .connect(alice)
          .transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifier, FIELD_SIZE, randomCommitment())
      ).to.be.revertedWith(
        "ConfidentialPool: output commitment >= field size"
      );
    });

    it("transfer with field-overflow outputCommitment2: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool
          .connect(alice)
          .transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifier, randomCommitment(), FIELD_SIZE)
      ).to.be.revertedWith(
        "ConfidentialPool: output commitment >= field size"
      );
    });

    it("transfer with unknown root: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await depositNote(pool, alice);
      const unknownRoot = randomCommitment();
      const nullifier = randomCommitment();

      await expect(
        pool
          .connect(alice)
          .transfer(
            DUMMY_PA,
            DUMMY_PB,
            DUMMY_PC,
            unknownRoot,
            nullifier,
            randomCommitment(),
            randomCommitment()
          )
      ).to.be.revertedWith("ConfidentialPool: unknown root");
    });

    it("transfer with spent nullifier: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      // First transfer spends nullifier
      await pool
        .connect(alice)
        .transfer(DUMMY_PA, DUMMY_PB, DUMMY_PC, root, nullifier, out1, out2);

      const newRoot = await pool.getLastRoot();

      await expect(
        pool
          .connect(alice)
          .transfer(
            DUMMY_PA,
            DUMMY_PB,
            DUMMY_PC,
            newRoot,
            nullifier,
            randomCommitment(),
            randomCommitment()
          )
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it("transfer with nullifier >= FIELD_SIZE: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);

      await expect(
        pool
          .connect(alice)
          .transfer(
            DUMMY_PA,
            DUMMY_PB,
            DUMMY_PC,
            root,
            FIELD_SIZE,
            randomCommitment(),
            randomCommitment()
          )
      ).to.be.revertedWith("ConfidentialPool: nullifier >= field size");
    });

    it("transfer when paused: reverts with EnforcedPause", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);

      await pool.connect(owner).pause();

      await expect(
        pool
          .connect(alice)
          .transfer(
            DUMMY_PA,
            DUMMY_PB,
            DUMMY_PC,
            root,
            randomCommitment(),
            randomCommitment(),
            randomCommitment()
          )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------
  // withdraw() — invalid inputs
  // -------------------------------------------------------------------------

  describe("withdraw() — invalid inputs", function () {
    it("withdraw with zero amount: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          0n,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: zero withdrawal amount");
    });

    it("withdraw with zero recipient: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          ONE_ETH,
          ZERO_ADDRESS as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: zero recipient");
    });

    it("withdraw with insufficient pool balance: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice, ONE_ETH);
      const nullifier = randomCommitment();
      const overAmount = ONE_ETH + 1n;

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          overAmount,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: insufficient pool balance");
    });

    it("withdraw with field-overflow nullifier: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          FIELD_SIZE,
          ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier >= field size");
    });

    it("withdraw with spent nullifier: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      // First withdrawal succeeds (placeholder verifier returns true)
      await pool.connect(alice).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        ONE_ETH,
        alice.address as `0x${string}`,
        0n,
        ZERO_ADDRESS as `0x${string}`,
        0n
      );

      // Pool balance is now 0 — re-deposit to avoid "insufficient balance" before "already spent"
      const { root: root2 } = await depositNote(pool, alice);

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root2,
          nullifier,
          ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it("withdraw with unknown root: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await depositNote(pool, alice);
      const unknownRoot = randomCommitment();
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          unknownRoot,
          nullifier,
          ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: unknown root");
    });

    it("withdraw when paused: reverts with EnforcedPause", async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);

      await pool.connect(owner).pause();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          randomCommitment(),
          ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("withdraw with invalid proof: reverts", async function () {
      const { pool, alice } = await loadFixture(deployPoolFalseWithdrawFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA,
          DUMMY_PB,
          DUMMY_PC,
          root,
          nullifier,
          ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: invalid withdrawal proof");
    });
  });

  // -------------------------------------------------------------------------
  // Admin invalid inputs — non-owner access
  // -------------------------------------------------------------------------

  describe("admin — non-owner calls", function () {
    it("pause by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).pause()
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("unpause by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, owner, stranger } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).pause();

      await expect(
        pool.connect(stranger).unpause()
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("queueAction by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).queueAction(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("cancelAction by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, owner, stranger } = await loadFixture(deployPoolFixture);

      // Queue so there is a valid pending action for owner — then stranger tries to cancel
      const nonZeroHash = ethers.keccak256(ethers.toUtf8Bytes("test-action"));
      await pool.connect(owner).queueAction(nonZeroHash);

      await expect(
        pool.connect(stranger).cancelAction()
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setAllowlistEnabled by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).setAllowlistEnabled(true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setAllowlisted by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).setAllowlisted(stranger.address, true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("batchSetAllowlisted by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).batchSetAllowlisted([stranger.address], true)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setDepositReceipt by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).setDepositReceipt(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setMaxOperationsPerBlock by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).setMaxOperationsPerBlock(10n)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setMaxDepositsPerAddress by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).setMaxDepositsPerAddress(5n)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setDepositCooldown by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).setDepositCooldown(3600n)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setMaxWithdrawAmount by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).setMaxWithdrawAmount(ONE_ETH)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("setMinDepositAge by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).setMinDepositAge(5n)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("addDenomination by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).addDenomination(ONE_ETH)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("removeDenomination by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, stranger } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(stranger).removeDenomination(ONE_ETH)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("emergencyDrain by non-owner: reverts with OwnableUnauthorizedAccount", async function () {
      const { pool, owner, stranger } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).pause();

      await expect(
        pool
          .connect(stranger)
          .emergencyDrain(stranger.address as `0x${string}`)
      ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // Admin invalid inputs — timelock guards
  // -------------------------------------------------------------------------

  describe("admin — timelock guards", function () {
    it("cancelAction with no pending: reverts", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(owner).cancelAction()
      ).to.be.revertedWith("ConfidentialPool: no pending action");
    });

    it("execute before delay: reverts with ConfidentialPool: timelock not expired", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 3n]
        )
      );
      await pool.connect(owner).queueAction(actionHash);

      // Do not advance time — timelock has not expired
      await expect(
        pool.connect(owner).setMaxDepositsPerAddress(3n)
      ).to.be.revertedWith("ConfidentialPool: timelock not expired");
    });

    it("execute wrong hash: reverts with ConfidentialPool: action not queued", async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      // Queue hash for value=5, but try to execute with value=99
      const queuedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 5n]
        )
      );
      await pool.connect(owner).queueAction(queuedHash);
      await time.increase(24 * 60 * 60 + 1);

      await expect(
        pool.connect(owner).setMaxDepositsPerAddress(99n)
      ).to.be.revertedWith("ConfidentialPool: action not queued");
    });
  });
});
