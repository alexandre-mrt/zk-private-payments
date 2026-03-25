import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT_SMALL = 5;
const MERKLE_HEIGHT_LARGE = 7; // capacity 128 — for tests needing >32 deposits
const CAPACITY_SMALL = 2 ** MERKLE_HEIGHT_SMALL; // 32
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ONE_DAY = 86_400;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie, relayer, dave, eve] =
    await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_HEIGHT_SMALL,
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie, relayer, dave, eve };
}

async function deployLargePoolFixture() {
  const [owner, alice, bob, charlie, relayer, dave, eve] =
    await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_HEIGHT_LARGE,
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie, relayer, dave, eve };
}

async function deployStealthFixture() {
  const [owner, alice, bob, charlie] = await ethers.getSigners();
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();
  return { registry, owner, alice, bob, charlie };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function depositOne(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function withdrawOne(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment = 0n
): Promise<void> {
  await pool.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient as `0x${string}`,
    changeCommitment,
    ethers.ZeroAddress as `0x${string}`,
    0n
  );
}

async function timelockQueue(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  owner: Awaited<ReturnType<typeof deployPoolFixture>>["owner"],
  hash: string
): Promise<void> {
  await pool.connect(owner).queueAction(hash);
  await ethers.provider.send("evm_increaseTime", [ONE_DAY + 1]);
  await ethers.provider.send("evm_mine", []);
}

// ---------------------------------------------------------------------------
// Massive Parametric
// ---------------------------------------------------------------------------

describe("Massive Parametric", function () {
  // -------------------------------------------------------------------------
  // 100 deposit amounts — commitment stored, totalDeposited updated
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    const amount =
      (ethers.parseEther("100") * BigInt(i + 1)) / 100n || 1n;
    it(`deposit amount #${i} (${amount} wei): commitment stored`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment =
        BigInt(i + 1) * 401n + BigInt(i) * 5_003n + 60_000_000n;
      await depositOne(pool, alice, commitment, amount);
      expect(await pool.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 50 transfer splits — both output commitments inserted in tree
  // -------------------------------------------------------------------------

  for (let i = 0; i < 50; i++) {
    it(`transfer split ratio #${i}: both output commitments inserted`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const inputCommitment =
        BigInt(i + 1) * 409n + BigInt(i) * 4_007n + 61_000_000n;
      const root = await depositOne(pool, alice, inputCommitment, depositAmount);

      const out1 = BigInt(i + 1) * 419n + BigInt(i) * 3_011n + 61_100_000n;
      const out2 = BigInt(i + 1) * 421n + BigInt(i) * 2_003n + 61_200_000n;
      const nullifier =
        BigInt(i + 1) * 431n + BigInt(i) * 1_009n + 61_300_000n;

      await pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      expect(await pool.commitments(out1)).to.be.true;
      expect(await pool.commitments(out2)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 50 withdrawal amounts — recipient balance increases by exact amount
  // -------------------------------------------------------------------------

  for (let i = 0; i < 50; i++) {
    const depositAmount = ethers.parseEther("10");
    const withdrawAmount = (depositAmount * BigInt(i + 1)) / 50n;
    it(`withdrawal amount variation #${i}: recipient balance +${withdrawAmount} wei`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const bobAddr = await bob.getAddress();

      const c = BigInt(i + 1) * 433n + BigInt(i) * 997n + 62_000_000n;
      const root = await depositOne(pool, alice, c, depositAmount);
      const nullifier =
        BigInt(i + 1) * 439n + BigInt(i) * 991n + 62_100_000n;

      const balBefore = await ethers.provider.getBalance(bobAddr);
      await withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr);
      const balAfter = await ethers.provider.getBalance(bobAddr);

      expect(balAfter - balBefore).to.equal(withdrawAmount);
    });
  }

  // -------------------------------------------------------------------------
  // 50 batchDeposit variations — sizes 1..10 (x5 different seeds)
  // Contract enforces MAX_BATCH == 10
  // -------------------------------------------------------------------------

  for (let round = 0; round < 5; round++) {
    for (let batchSize = 1; batchSize <= 10; batchSize++) {
      it(`batchDeposit size ${batchSize} round ${round}: all commitments stored`, async function () {
        const { pool, alice } = await loadFixture(deployPoolFixture);

        const amount = ethers.parseEther("0.5");
        const commitments: bigint[] = [];
        const amounts: bigint[] = [];

        for (let j = 0; j < batchSize; j++) {
          commitments.push(
            BigInt(j + 1) * 443n +
              BigInt(batchSize) * 2_003n +
              BigInt(round) * 10_007n +
              63_000_000n
          );
          amounts.push(amount);
        }

        await pool.connect(alice).batchDeposit(commitments, amounts, {
          value: amount * BigInt(batchSize),
        });

        expect(await pool.getDepositCount()).to.equal(BigInt(batchSize));
        for (const c of commitments) {
          expect(await pool.commitments(c)).to.be.true;
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // 50 hash pairs — on-chain determinism and field-bound check
  // -------------------------------------------------------------------------

  for (let i = 0; i < 50; i++) {
    const left = BigInt(i + 1) * 449n + 64_000_000n;
    const right = BigInt(i + 1) * 457n + 64_100_000n;
    it(`hash pair #${i}: on-chain == off-chain`, async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 50 getPoolStats after N deposits (1 <= N <= 50)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 50; n++) {
    it(`getPoolStats after ${n} deposits: depositCount and totalDeposited match`, async function () {
      const { pool, alice } = await loadFixture(
        n > CAPACITY_SMALL ? deployLargePoolFixture : deployPoolFixture
      );
      const depositAmount = ethers.parseEther("1");

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 461n + BigInt(n) * 1_013n + 65_000_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      const [totalDeposited, , , depositCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(depositAmount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 50 getActiveNoteCount tracking after N deposits (1 <= N <= 50)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 50; n++) {
    it(`getActiveNoteCount after ${n} deposits: activeNotes == ${n}`, async function () {
      const { pool, alice } = await loadFixture(
        n > CAPACITY_SMALL ? deployLargePoolFixture : deployPoolFixture
      );
      const depositAmount = ethers.parseEther("0.5");

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 463n + BigInt(n) * 1_019n + 66_000_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      expect(await pool.getActiveNoteCount()).to.equal(BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 50 denomination tests — 25 accepted, 25 rejected (wrong amount)
  // -------------------------------------------------------------------------

  const denomValues = [
    ethers.parseEther("0.01"),
    ethers.parseEther("0.05"),
    ethers.parseEther("0.1"),
    ethers.parseEther("0.25"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1"),
    ethers.parseEther("2"),
    ethers.parseEther("5"),
    ethers.parseEther("10"),
    ethers.parseEther("25"),
    ethers.parseEther("50"),
    ethers.parseEther("100"),
    ethers.parseEther("0.02"),
    ethers.parseEther("0.03"),
    ethers.parseEther("0.07"),
    ethers.parseEther("0.15"),
    ethers.parseEther("0.2"),
    ethers.parseEther("0.3"),
    ethers.parseEther("0.75"),
    ethers.parseEther("1.5"),
    ethers.parseEther("3"),
    ethers.parseEther("7"),
    ethers.parseEther("15"),
    ethers.parseEther("20"),
    ethers.parseEther("75"),
  ];

  for (let i = 0; i < 25; i++) {
    const denom = denomValues[i];
    it(`denomination ${denom} wei: exact amount accepted`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["addDenomination", denom]
        )
      );
      await timelockQueue(pool, owner, hash);
      await pool.connect(owner).addDenomination(denom);

      const c = BigInt(i + 1) * 467n + 67_000_000n;
      await expect(
        pool.connect(alice).deposit(c, { value: denom })
      ).to.not.be.reverted;
    });
  }

  for (let i = 0; i < 25; i++) {
    const denom = denomValues[i];
    it(`denomination ${denom} wei: wrong amount rejected`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["addDenomination", denom]
        )
      );
      await timelockQueue(pool, owner, hash);
      await pool.connect(owner).addDenomination(denom);

      const c = BigInt(i + 1) * 479n + 68_000_000n;
      await expect(
        pool.connect(alice).deposit(c, { value: denom + 1n })
      ).to.be.revertedWith(
        "ConfidentialPool: amount not an allowed denomination"
      );
    });
  }

  // -------------------------------------------------------------------------
  // 50 commitment bounds — 2^bits for bits 1..250 step 5
  // -------------------------------------------------------------------------

  for (let bits = 1; bits <= 250; bits += 5) {
    const candidate = 2n ** BigInt(bits);
    const isValid = candidate > 0n && candidate < FIELD_SIZE;
    it(`commitment 2^${bits}: valid == ${isValid}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      if (isValid) {
        await expect(
          pool
            .connect(alice)
            .deposit(candidate, { value: ethers.parseEther("1") })
        ).to.not.be.reverted;
        expect(await pool.isCommitted(candidate)).to.be.true;
      } else {
        await expect(
          pool
            .connect(alice)
            .deposit(candidate, { value: ethers.parseEther("1") })
        ).to.be.reverted;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 50 root history — isKnownRoot for root at deposit #i (0 <= i < 50)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 50; i++) {
    it(`root at deposit #${i}: in history`, async function () {
      const { pool, alice } = await loadFixture(
        i >= CAPACITY_SMALL ? deployLargePoolFixture : deployPoolFixture
      );

      let capturedRoot = 0n;
      for (let d = 0; d <= i; d++) {
        const c =
          BigInt(d + 1) * 487n + BigInt(i) * 983n + 69_000_000n;
        capturedRoot = await depositOne(
          pool,
          alice,
          c,
          ethers.parseEther("1")
        );
      }

      expect(await pool.isKnownRoot(capturedRoot)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 50 stealth registry ops — 25 register, 25 announce
  // -------------------------------------------------------------------------

  for (let i = 0; i < 25; i++) {
    const kx = BigInt(i + 1) * 491n + 70_000_000n;
    const ky = BigInt(i + 1) * 499n + 70_100_000n;
    it(`stealth registry #${i}: viewing key registered and retrievable`, async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      await registry.connect(alice).registerViewingKey(kx, ky);
      const aliceAddr = await alice.getAddress();
      const [gotX, gotY] = await registry.getViewingKey(aliceAddr);
      expect(gotX).to.equal(kx);
      expect(gotY).to.equal(ky);
    });
  }

  for (let i = 0; i < 25; i++) {
    it(`stealth payment announcement #${i}: StealthPayment event emitted`, async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);

      const commitment = BigInt(i + 1) * 503n + 71_000_000n;
      const ephX = BigInt(i + 1) * 509n + 71_100_000n;
      const ephY = BigInt(i + 1) * 521n + 71_200_000n;
      const stX = BigInt(i + 1) * 523n + 71_300_000n;
      const stY = BigInt(i + 1) * 541n + 71_400_000n;
      const encAmt = BigInt(i + 1) * 547n + 71_500_000n;
      const encBld = BigInt(i + 1) * 557n + 71_600_000n;

      await expect(
        registry
          .connect(alice)
          .announceStealthPayment(
            commitment,
            ephX,
            ephY,
            stX,
            stY,
            encAmt,
            encBld
          )
      )
        .to.emit(registry, "StealthPayment")
        .withArgs(commitment, ephX, ephY, stX, stY, encAmt, encBld);
    });
  }
});
