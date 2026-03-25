import { expect } from "chai";
import { ethers, network } from "hardhat";
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
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Standard pool fixture — both verifiers always return true (placeholder).
 */
async function deployPoolFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

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

  return { pool, hasherAddress, owner, alice, bob, relayer };
}

/**
 * Pool with false transfer verifier — for "invalid transfer proof" test.
 */
async function deployPoolFalseTransferFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const hasherAddress = await deployHasher();

  const FalseTransfer = await ethers.getContractFactory(
    "MockFalseTransferVerifier"
  );
  const falseTransfer = await FalseTransfer.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await falseTransfer.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  )) as unknown as ConfidentialPool;

  return { pool, owner, alice, bob };
}

/**
 * Pool with false withdraw verifier — for "invalid withdrawal proof" test.
 */
async function deployPoolFalseWithdrawFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
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

  return { pool, owner, alice, bob };
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

async function timelockExecute(
  pool: ConfidentialPool,
  actionHash: string
): Promise<void> {
  await pool.queueAction(actionHash);
  await time.increase(24 * 60 * 60 + 1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Revert Messages", function () {
  // -------------------------------------------------------------------------
  // Constructor guards
  // -------------------------------------------------------------------------

  describe("constructor", function () {
    it('reverts with "ConfidentialPool: zero transfer verifier" when transferVerifier is address(0)', async function () {
      const hasherAddress = await deployHasher();
      const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
      const withdrawVerifier = await WithdrawVerifier.deploy();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(
          ZERO_ADDRESS,
          await withdrawVerifier.getAddress(),
          5,
          hasherAddress
        )
      ).to.be.revertedWith("ConfidentialPool: zero transfer verifier");
    });

    it('reverts with "ConfidentialPool: zero withdraw verifier" when withdrawVerifier is address(0)', async function () {
      const hasherAddress = await deployHasher();
      const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
      const transferVerifier = await TransferVerifier.deploy();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(
          await transferVerifier.getAddress(),
          ZERO_ADDRESS,
          5,
          hasherAddress
        )
      ).to.be.revertedWith("ConfidentialPool: zero withdraw verifier");
    });
  });

  // -------------------------------------------------------------------------
  // deposit()
  // -------------------------------------------------------------------------

  describe("deposit()", function () {
    it('reverts with "ConfidentialPool: block operation limit" when maxOperationsPerBlock is exceeded', async function () {
      // Pre-fill the per-block counter using storage manipulation so that
      // the next deposit lands in a block where the limit is already reached.
      // operationsPerBlock is a mapping at slot 19 (matches blockRateLimit.test.ts).
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setMaxOperationsPerBlock(1n);

      const poolAddr = await pool.getAddress();
      const nextBlock = (await ethers.provider.getBlockNumber()) + 1;
      const SLOT = 19;
      const storageKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256"],
          [nextBlock, SLOT]
        )
      );

      // Set operationsPerBlock[nextBlock] = 1 (= maxOperationsPerBlock)
      await network.provider.send("hardhat_setStorageAt", [
        poolAddr,
        storageKey,
        ethers.zeroPadValue(ethers.toBeHex(1n), 32),
      ]);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: block operation limit");
    });

    it('reverts with "ConfidentialPool: sender not allowlisted" when allowlist is active and sender is not listed', async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setAllowlistEnabled(true);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });

    it('reverts with "ConfidentialPool: zero deposit" when msg.value == 0', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: zero deposit");
    });

    it('reverts with "ConfidentialPool: amount not an allowed denomination" when value does not match a denomination', async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      // Add 1 ETH denomination through timelock
      const denom = ONE_ETH;
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["addDenomination", denom]
        )
      );
      await timelockExecute(pool.connect(owner) as unknown as ConfidentialPool, actionHash);
      await pool.connect(owner).addDenomination(denom);

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH / 2n })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });

    it('reverts with "ConfidentialPool: zero commitment" when commitment == 0', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).deposit(0n, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: zero commitment");
    });

    it('reverts with "ConfidentialPool: commitment >= field size" when commitment == FIELD_SIZE', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).deposit(FIELD_SIZE, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: commitment >= field size");
    });

    it('reverts with "ConfidentialPool: duplicate commitment" when same commitment deposited twice', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const c = randomCommitment();

      await pool.connect(alice).deposit(c, { value: ONE_ETH });

      await expect(
        pool.connect(alice).deposit(c, { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: duplicate commitment");
    });

    it('reverts with "ConfidentialPool: deposit limit reached" when per-address limit is exceeded', async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 1n]
        )
      );
      await timelockExecute(pool.connect(owner) as unknown as ConfidentialPool, actionHash);
      await pool.connect(owner).setMaxDepositsPerAddress(1n);

      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit limit reached");
    });

    it('reverts with "ConfidentialPool: deposit cooldown active" when cooldown has not elapsed', async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const cooldown = 3600n;
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setDepositCooldown", cooldown]
        )
      );
      await timelockExecute(pool.connect(owner) as unknown as ConfidentialPool, actionHash);
      await pool.connect(owner).setDepositCooldown(cooldown);

      await pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH });

      await expect(
        pool.connect(alice).deposit(randomCommitment(), { value: ONE_ETH })
      ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");
    });
  });

  // -------------------------------------------------------------------------
  // batchDeposit()
  // -------------------------------------------------------------------------

  describe("batchDeposit()", function () {
    it('reverts with "ConfidentialPool: arrays length mismatch" when commitments and amounts arrays differ in length', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).batchDeposit(
          [randomCommitment(), randomCommitment()],
          [ONE_ETH],
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("ConfidentialPool: arrays length mismatch");
    });

    it('reverts with "ConfidentialPool: empty batch" when commitments array is empty', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(alice).batchDeposit([], [], { value: 0n })
      ).to.be.revertedWith("ConfidentialPool: empty batch");
    });

    it('reverts with "ConfidentialPool: batch too large" when more than 10 commitments', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitments = Array.from({ length: 11 }, () => randomCommitment());
      const amounts = Array.from({ length: 11 }, () => ONE_ETH);
      const total = ONE_ETH * 11n;

      await expect(
        pool.connect(alice).batchDeposit(commitments, amounts, { value: total })
      ).to.be.revertedWith("ConfidentialPool: batch too large");
    });

    it('reverts with "ConfidentialPool: incorrect total amount" when msg.value does not equal sum of amounts', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const c1 = randomCommitment();
      const c2 = randomCommitment();

      await expect(
        pool.connect(alice).batchDeposit(
          [c1, c2],
          [ONE_ETH, ONE_ETH],
          { value: ONE_ETH } // should be 2 ETH
        )
      ).to.be.revertedWith("ConfidentialPool: incorrect total amount");
    });

    it('reverts with "ConfidentialPool: zero amount in batch" when one amount in batch is zero', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const c1 = randomCommitment();
      const c2 = randomCommitment();

      await expect(
        pool.connect(alice).batchDeposit(
          [c1, c2],
          [ONE_ETH, 0n],
          { value: ONE_ETH } // total matches but one amount is zero
        )
      ).to.be.revertedWith("ConfidentialPool: zero amount in batch");
    });
  });

  // -------------------------------------------------------------------------
  // transfer()
  // -------------------------------------------------------------------------

  describe("transfer()", function () {
    it('reverts with "ConfidentialPool: nullifier >= field size" when nullifier >= FIELD_SIZE', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, FIELD_SIZE, out1, out2
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier >= field size");
    });

    it('reverts with "ConfidentialPool: unknown root" when root is not in ring buffer', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await depositNote(pool, alice);
      const unknownRoot = randomCommitment();
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          unknownRoot, nullifier, out1, out2
        )
      ).to.be.revertedWith("ConfidentialPool: unknown root");
    });

    it('reverts with "ConfidentialPool: nullifier already spent" when nullifier was already used', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      // First transfer spends the nullifier (placeholder verifier returns true)
      await pool.connect(alice).transfer(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root, nullifier, out1, out2
      );

      const newRoot = await pool.getLastRoot();
      const out3 = randomCommitment();
      const out4 = randomCommitment();

      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          newRoot, nullifier, out3, out4
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it('reverts with "ConfidentialPool: zero output commitment" when outputCommitment1 == 0', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, 0n, randomCommitment()
        )
      ).to.be.revertedWith("ConfidentialPool: zero output commitment");
    });

    it('reverts with "ConfidentialPool: zero output commitment" when outputCommitment2 == 0', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, randomCommitment(), 0n
        )
      ).to.be.revertedWith("ConfidentialPool: zero output commitment");
    });

    it('reverts with "ConfidentialPool: output commitment >= field size" when outputCommitment1 >= FIELD_SIZE', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, FIELD_SIZE, randomCommitment()
        )
      ).to.be.revertedWith("ConfidentialPool: output commitment >= field size");
    });

    it('reverts with "ConfidentialPool: invalid transfer proof" when verifier returns false', async function () {
      const { pool, alice } = await loadFixture(deployPoolFalseTransferFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await expect(
        pool.connect(alice).transfer(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, out1, out2
        )
      ).to.be.revertedWith("ConfidentialPool: invalid transfer proof");
    });
  });

  // -------------------------------------------------------------------------
  // withdraw()
  // -------------------------------------------------------------------------

  describe("withdraw()", function () {
    it('reverts with "ConfidentialPool: fee exceeds amount" when fee > amount', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();
      const amount = ONE_ETH / 2n;
      const fee = amount + 1n;

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, amount,
          alice.address as `0x${string}`,
          0n,
          alice.address as `0x${string}`,
          fee
        )
      ).to.be.revertedWith("ConfidentialPool: fee exceeds amount");
    });

    it('reverts with "ConfidentialPool: nullifier >= field size" when nullifier >= FIELD_SIZE', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, FIELD_SIZE, ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier >= field size");
    });

    it('reverts with "ConfidentialPool: nullifier already spent" when nullifier was already used', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await pool.connect(alice).withdraw(
        DUMMY_PA, DUMMY_PB, DUMMY_PC,
        root, nullifier, ONE_ETH,
        alice.address as `0x${string}`,
        0n,
        ZERO_ADDRESS as `0x${string}`,
        0n
      );

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });

    it('reverts with "ConfidentialPool: unknown root" when root is not in ring buffer', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      await depositNote(pool, alice);
      const unknownRoot = randomCommitment();
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          unknownRoot, nullifier, ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: unknown root");
    });

    it('reverts with "ConfidentialPool: zero recipient" when recipient is address(0)', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, ONE_ETH,
          ZERO_ADDRESS as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: zero recipient");
    });

    it('reverts with "ConfidentialPool: zero withdrawal amount" when amount == 0', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, 0n,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: zero withdrawal amount");
    });

    it('reverts with "ConfidentialPool: amount exceeds withdrawal limit" when amount > maxWithdrawAmount', async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const cap = ONE_ETH / 2n;
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxWithdrawAmount", cap]
        )
      );
      await timelockExecute(pool.connect(owner) as unknown as ConfidentialPool, actionHash);
      await pool.connect(owner).setMaxWithdrawAmount(cap);

      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, ONE_ETH, // exceeds cap
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: amount exceeds withdrawal limit");
    });

    it('reverts with "ConfidentialPool: insufficient pool balance" when pool has less ETH than requested', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice, ONE_ETH);
      const nullifier = randomCommitment();
      const overAmount = ONE_ETH + 1n;

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, overAmount,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: insufficient pool balance");
    });

    it('reverts with "ConfidentialPool: withdrawal too soon after last deposit" when minDepositAge not met', async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const age = 5n; // 5 blocks
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMinDepositAge", age]
        )
      );
      await timelockExecute(pool.connect(owner) as unknown as ConfidentialPool, actionHash);
      await pool.connect(owner).setMinDepositAge(age);

      // Deposit and immediately try to withdraw (0 blocks elapsed)
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith(
        "ConfidentialPool: withdrawal too soon after last deposit"
      );
    });

    it('reverts with "ConfidentialPool: invalid withdrawal proof" when verifier returns false', async function () {
      const { pool, alice } = await loadFixture(deployPoolFalseWithdrawFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: invalid withdrawal proof");
    });

    it('reverts with "ConfidentialPool: change commitment >= field size" when changeCommitment >= FIELD_SIZE', async function () {
      // changeCommitment check fires AFTER proof passes — use placeholder verifier (always true)
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, ONE_ETH / 2n,
          alice.address as `0x${string}`,
          FIELD_SIZE, // change commitment >= FIELD_SIZE
          ZERO_ADDRESS as `0x${string}`,
          0n
        )
      ).to.be.revertedWith(
        "ConfidentialPool: change commitment >= field size"
      );
    });

    it('reverts with "ConfidentialPool: zero relayer for non-zero fee" when fee > 0 and relayer is address(0)', async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const { root } = await depositNote(pool, alice);
      const nullifier = randomCommitment();
      const fee = 1n;

      await expect(
        pool.connect(alice).withdraw(
          DUMMY_PA, DUMMY_PB, DUMMY_PC,
          root, nullifier, ONE_ETH,
          alice.address as `0x${string}`,
          0n,
          ZERO_ADDRESS as `0x${string}`, // relayer = address(0) but fee > 0
          fee
        )
      ).to.be.revertedWith(
        "ConfidentialPool: zero relayer for non-zero fee"
      );
    });
  });

  // -------------------------------------------------------------------------
  // MerkleTree constructor guards (exercised via pool deployment)
  // -------------------------------------------------------------------------

  describe("MerkleTree constructor guards", function () {
    it('reverts with "MerkleTree: levels out of range" when levels == 0', async function () {
      const hasherAddress = await deployHasher();
      const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
      const transferVerifier = await TransferVerifier.deploy();
      const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
      const withdrawVerifier = await WithdrawVerifier.deploy();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(
          await transferVerifier.getAddress(),
          await withdrawVerifier.getAddress(),
          0,
          hasherAddress
        )
      ).to.be.revertedWith("MerkleTree: levels out of range");
    });

    it('reverts with "MerkleTree: levels out of range" when levels == 33', async function () {
      const hasherAddress = await deployHasher();
      const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
      const transferVerifier = await TransferVerifier.deploy();
      const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
      const withdrawVerifier = await WithdrawVerifier.deploy();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(
          await transferVerifier.getAddress(),
          await withdrawVerifier.getAddress(),
          33,
          hasherAddress
        )
      ).to.be.revertedWith("MerkleTree: levels out of range");
    });

    it('reverts with "MerkleTree: hasher is zero address" when hasher is address(0)', async function () {
      const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
      const transferVerifier = await TransferVerifier.deploy();
      const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
      const withdrawVerifier = await WithdrawVerifier.deploy();
      const Pool = await ethers.getContractFactory("ConfidentialPool");

      await expect(
        Pool.deploy(
          await transferVerifier.getAddress(),
          await withdrawVerifier.getAddress(),
          5,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith("MerkleTree: hasher is zero address");
    });

    it('reverts with "MerkleTree: left overflow" when left >= FIELD_SIZE', async function () {
      const { pool } = await loadFixture(deployPoolFixture);

      await expect(
        pool.hashLeftRight(FIELD_SIZE, 1n)
      ).to.be.revertedWith("MerkleTree: left overflow");
    });

    it('reverts with "MerkleTree: right overflow" when right >= FIELD_SIZE', async function () {
      const { pool } = await loadFixture(deployPoolFixture);

      await expect(
        pool.hashLeftRight(1n, FIELD_SIZE)
      ).to.be.revertedWith("MerkleTree: right overflow");
    });
  });

  // -------------------------------------------------------------------------
  // emergencyDrain()
  // -------------------------------------------------------------------------

  describe("emergencyDrain()", function () {
    it('reverts with "ConfidentialPool: zero drain address" when recipient is address(0)', async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).pause();

      await expect(
        pool.connect(owner).emergencyDrain(ZERO_ADDRESS as `0x${string}`)
      ).to.be.revertedWith("ConfidentialPool: zero drain address");
    });

    it('reverts with "ConfidentialPool: no balance to drain" when pool balance is zero', async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).pause();

      await expect(
        pool.connect(owner).emergencyDrain(alice.address as `0x${string}`)
      ).to.be.revertedWith("ConfidentialPool: no balance to drain");
    });
  });

  // -------------------------------------------------------------------------
  // cancelAction() / timelockReady
  // -------------------------------------------------------------------------

  describe("timelock", function () {
    it('reverts with "ConfidentialPool: no pending action" when cancelAction called with nothing queued', async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      await expect(
        pool.connect(owner).cancelAction()
      ).to.be.revertedWith("ConfidentialPool: no pending action");
    });

    it('reverts with "ConfidentialPool: action not queued" when executing with a different hash than queued', async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

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

    it('reverts with "ConfidentialPool: timelock not expired" when delay has not passed', async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setMaxDepositsPerAddress", 3n]
        )
      );
      await pool.connect(owner).queueAction(actionHash);

      await expect(
        pool.connect(owner).setMaxDepositsPerAddress(3n)
      ).to.be.revertedWith("ConfidentialPool: timelock not expired");
    });
  });

  // -------------------------------------------------------------------------
  // addDenomination() / removeDenomination()
  // -------------------------------------------------------------------------

  describe("denomination management", function () {
    it('reverts with "ConfidentialPool: zero denomination" when adding denomination 0', async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["addDenomination", 0n]
        )
      );
      await pool.connect(owner).queueAction(actionHash);
      await time.increase(24 * 60 * 60 + 1);

      await expect(
        pool.connect(owner).addDenomination(0n)
      ).to.be.revertedWith("ConfidentialPool: zero denomination");
    });

    it('reverts with "ConfidentialPool: denomination exists" when adding the same denomination twice', async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      const denom = ONE_ETH;

      // Add once
      const addHash1 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["addDenomination", denom]
        )
      );
      await pool.connect(owner).queueAction(addHash1);
      await time.increase(24 * 60 * 60 + 1);
      await pool.connect(owner).addDenomination(denom);

      // Try to add again
      const addHash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["addDenomination", denom]
        )
      );
      await pool.connect(owner).queueAction(addHash2);
      await time.increase(24 * 60 * 60 + 1);

      await expect(
        pool.connect(owner).addDenomination(denom)
      ).to.be.revertedWith("ConfidentialPool: denomination exists");
    });

    it('reverts with "ConfidentialPool: denomination not found" when removing a non-existent denomination', async function () {
      const { pool, owner } = await loadFixture(deployPoolFixture);

      const denom = ONE_ETH;
      const removeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["removeDenomination", denom]
        )
      );
      await pool.connect(owner).queueAction(removeHash);
      await time.increase(24 * 60 * 60 + 1);

      await expect(
        pool.connect(owner).removeDenomination(denom)
      ).to.be.revertedWith("ConfidentialPool: denomination not found");
    });
  });

  // -------------------------------------------------------------------------
  // getWithdrawalRecord()
  // -------------------------------------------------------------------------

  describe("getWithdrawalRecord()", function () {
    it('reverts with "ConfidentialPool: invalid record index" when index is out of bounds', async function () {
      const { pool } = await loadFixture(deployPoolFixture);

      await expect(
        pool.getWithdrawalRecord(0n)
      ).to.be.revertedWith("ConfidentialPool: invalid record index");
    });
  });
});
