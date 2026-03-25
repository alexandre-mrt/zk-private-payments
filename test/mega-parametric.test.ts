import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT = 5;
const CAPACITY = 2 ** MERKLE_HEIGHT; // 32

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
    MERKLE_HEIGHT,
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
// Mega Parametric
// ---------------------------------------------------------------------------

describe("Mega Parametric", function () {
  // -------------------------------------------------------------------------
  // 50 deposit amounts from 1 wei to 100 ETH
  // -------------------------------------------------------------------------

  const depositAmounts: bigint[] = [];
  for (let i = 0; i < 50; i++) {
    // Steps: 1 wei, ~2 ETH, ~4 ETH … 100 ETH
    const step = (ethers.parseEther("100") * BigInt(i + 1)) / 50n;
    depositAmounts.push(step > 0n ? step : 1n);
  }

  for (let i = 0; i < 50; i++) {
    const amount = depositAmounts[i];
    it(`deposit amount #${i} (${amount} wei): commitment stored, totalDeposited updated`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = BigInt(i + 1) * 101n + BigInt(i) * 3000n + 20_000_000n;
      await depositOne(pool, alice, commitment, amount);
      expect(await pool.isCommitted(commitment)).to.be.true;
      expect(await pool.totalDeposited()).to.equal(amount);
    });
  }

  // -------------------------------------------------------------------------
  // 30 transfer split ratios — both output commitments land in tree
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    it(`transfer split ratio #${i}: both output commitments inserted`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const inputCommitment = BigInt(i + 1) * 103n + 21_000_000n;
      const root = await depositOne(pool, alice, inputCommitment, depositAmount);

      const out1 = BigInt(i + 1) * 107n + 21_100_000n;
      const out2 = BigInt(i + 1) * 109n + 21_200_000n;
      const nullifier = BigInt(i + 1) * 113n + 21_300_000n;

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
  // 20 batchDeposit sizes 1-10 (x2: different amounts)
  // -------------------------------------------------------------------------

  for (let batchSize = 1; batchSize <= 10; batchSize++) {
    it(`batchDeposit size ${batchSize} (0.5 ETH each): all commitments inserted`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments: bigint[] = [];
      const amounts: bigint[] = [];
      const amount = ethers.parseEther("0.5");

      for (let j = 0; j < batchSize; j++) {
        commitments.push(BigInt(j + 1) * 127n + BigInt(batchSize) * 2000n + 22_000_000n);
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

  for (let batchSize = 1; batchSize <= 10; batchSize++) {
    it(`batchDeposit size ${batchSize} (1 ETH each): depositCount correct`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments: bigint[] = [];
      const amounts: bigint[] = [];
      const amount = ethers.parseEther("1");

      for (let j = 0; j < batchSize; j++) {
        commitments.push(BigInt(j + 1) * 131n + BigInt(batchSize) * 3000n + 23_000_000n);
        amounts.push(amount);
      }

      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: amount * BigInt(batchSize),
      });

      expect(await pool.getDepositCount()).to.equal(BigInt(batchSize));
    });
  }

  // -------------------------------------------------------------------------
  // 30 hash pairs
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    const left = BigInt(i + 1) * 137n + 24_000_000n;
    const right = BigInt(i + 1) * 139n + 24_100_000n;
    it(`hash pair #${i}: on-chain result is deterministic and within field`, async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 30 getPoolStats after N deposits
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 30; n++) {
    it(`getPoolStats after ${n} deposits: depositCount and totalDeposited match`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 149n + BigInt(n) * 1000n + 25_000_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      const [totalDeposited, , , depositCount] = await pool.getPoolStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(depositAmount * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 30 getActiveNoteCount tracking
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 30; n++) {
    it(`getActiveNoteCount after ${n} deposits: activeNotes == ${n}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("0.5");

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 151n + BigInt(n) * 800n + 26_000_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      expect(await pool.getActiveNoteCount()).to.equal(BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 20 denomination enforcement
  // -------------------------------------------------------------------------

  const denomValues = [
    ethers.parseEther("0.01"),
    ethers.parseEther("0.05"),
    ethers.parseEther("0.1"),
    ethers.parseEther("0.25"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1"),
    ethers.parseEther("5"),
    ethers.parseEther("10"),
    ethers.parseEther("50"),
    ethers.parseEther("100"),
  ];

  for (let i = 0; i < 10; i++) {
    const denom = denomValues[i];
    it(`denomination ${denom} wei: exact deposit accepted`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["addDenomination", denom]
        )
      );
      await timelockQueue(pool, owner, hash);
      await pool.connect(owner).addDenomination(denom);

      const c = BigInt(i + 1) * 157n + 27_000_000n;
      await expect(
        pool.connect(alice).deposit(c, { value: denom })
      ).to.not.be.reverted;
    });
  }

  for (let i = 0; i < 10; i++) {
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

      const c = BigInt(i + 1) * 163n + 28_000_000n;
      await expect(
        pool.connect(alice).deposit(c, { value: denom + 1n })
      ).to.be.revertedWith(
        "ConfidentialPool: amount not an allowed denomination"
      );
    });
  }

  // -------------------------------------------------------------------------
  // 20 allowlist scenarios
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`allowlist scenario #${i}: non-listed address rejected when enabled`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);

      const c = BigInt(i + 1) * 167n + 29_000_000n;
      await expect(
        pool.connect(alice).deposit(c, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`allowlist scenario #${i}: listed address accepted when enabled`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(await alice.getAddress(), true);

      const c = BigInt(i + 1) * 173n + 30_000_000n;
      await expect(
        pool.connect(alice).deposit(c, { value: ethers.parseEther("1") })
      ).to.not.be.reverted;
    });
  }

  // -------------------------------------------------------------------------
  // 20 commitment bounds
  // -------------------------------------------------------------------------

  for (let bits = 8; bits <= 248; bits += 12) {
    const candidate = 2n ** BigInt(bits) - 1n;
    const isValid = candidate > 0n && candidate < FIELD_SIZE;
    it(`commitment 2^${bits}-1: valid field element == ${isValid}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      if (isValid) {
        await expect(
          pool.connect(alice).deposit(candidate, { value: ethers.parseEther("1") })
        ).to.not.be.reverted;
        expect(await pool.isCommitted(candidate)).to.be.true;
      } else {
        await expect(
          pool.connect(alice).deposit(candidate, { value: ethers.parseEther("1") })
        ).to.be.reverted;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 20 withdrawal amount variations
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    const depositAmount = ethers.parseEther("10");
    const withdrawAmount =
      (depositAmount * BigInt(i + 1)) / 20n;
    it(`withdrawal amount variation #${i}: recipient balance increases by ${withdrawAmount} wei`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const bobAddr = await bob.getAddress();

      const c = BigInt(i + 1) * 179n + 31_000_000n;
      const root = await depositOne(pool, alice, c, depositAmount);
      const nullifier = BigInt(i + 1) * 181n + 31_100_000n;

      const balBefore = await ethers.provider.getBalance(bobAddr);
      await withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr);
      const balAfter = await ethers.provider.getBalance(bobAddr);

      expect(balAfter - balBefore).to.equal(withdrawAmount);
    });
  }

  // -------------------------------------------------------------------------
  // 30 stealth registry announcements
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    const kx = BigInt(i + 1) * 191n + 32_000_000n;
    const ky = BigInt(i + 1) * 193n + 32_100_000n;
    it(`stealth registry announcement #${i}: viewing key (${kx}, ${ky}) stored and retrievable`, async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      await registry.connect(alice).registerViewingKey(kx, ky);
      const aliceAddr = await alice.getAddress();
      const [gotX, gotY] = await registry.getViewingKey(aliceAddr);
      expect(gotX).to.equal(kx);
      expect(gotY).to.equal(ky);
    });
  }

  // -------------------------------------------------------------------------
  // 20 PoolLens snapshot verification
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 20; n++) {
    it(`PoolLens snapshot after ${n} deposits: depositCount, balance, version match`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const PoolLensFactory = await ethers.getContractFactory("PoolLens");
      const lens = await PoolLensFactory.deploy();

      const depositAmount = ethers.parseEther("1");
      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 197n + BigInt(n) * 1200n + 33_000_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.depositCount).to.equal(BigInt(n));
      expect(snapshot.poolBalance).to.equal(depositAmount * BigInt(n));
      expect(snapshot.version).to.equal("1.0.0");
    });
  }

  // -------------------------------------------------------------------------
  // 20 isKnownRoot checks
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    it(`isKnownRoot for root at deposit #${i}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      let capturedRoot = 0n;
      for (let d = 0; d <= i; d++) {
        const c = BigInt(d + 1) * 199n + BigInt(i) * 700n + 34_000_000n;
        capturedRoot = await depositOne(pool, alice, c, ethers.parseEther("1"));
      }

      expect(await pool.isKnownRoot(capturedRoot)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 20 totalTransfers counter after successive transfers
  // Each iteration of the inner loop does 1 deposit (1 slot) + 1 transfer
  // (2 slots) = 3 slots. Tree capacity is 32. Cap at 10 so 10*3=30 <= 32.
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`totalTransfers after ${n} transfers: counter == ${n}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");

      for (let k = 0; k < n; k++) {
        const inC = BigInt(k + 1) * 211n + BigInt(n) * 900n + 35_000_000n;
        const root = await depositOne(pool, alice, inC, depositAmount);
        const out1 = BigInt(k + 1) * 223n + BigInt(n) * 800n + 35_100_000n;
        const out2 = BigInt(k + 1) * 227n + BigInt(n) * 700n + 35_200_000n;
        const nullifier = BigInt(k + 1) * 229n + BigInt(n) * 600n + 35_300_000n;

        await pool.transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          nullifier,
          out1,
          out2
        );
      }

      const [, , totalTransfers] = await pool.getPoolStats();
      expect(totalTransfers).to.equal(BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 20 uniqueDepositorCount increments
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    it(`uniqueDepositorCount #${i}: two unique depositors counted`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const amount = ethers.parseEther("1");

      const cA = BigInt(i + 1) * 233n + 36_000_000n;
      await depositOne(pool, alice, cA, amount);

      const cB = BigInt(i + 1) * 239n + 36_100_000n;
      await depositOne(pool, bob, cB, amount);

      expect(await pool.uniqueDepositorCount()).to.equal(2n);
    });
  }

  // -------------------------------------------------------------------------
  // 20 double-spend prevention
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    it(`double-spend #${i}: second withdrawal with same nullifier reverts`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const bobAddr = await bob.getAddress();
      const amount = ethers.parseEther("2");

      const c1 = BigInt(i + 1) * 241n + 37_000_000n;
      const root = await depositOne(pool, alice, c1, amount);
      const nullifier = BigInt(i + 1) * 251n + 37_100_000n;
      const withdrawAmount = ethers.parseEther("1");

      await withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr);

      await expect(
        withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr)
      ).to.be.revertedWith("ConfidentialPool: nullifier already spent");
    });
  }

  // -------------------------------------------------------------------------
  // 10 getWithdrawalRecordCount tracking
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`getWithdrawalRecordCount after ${n} withdrawals: count == ${n}`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("2");
      const withdrawAmount = ethers.parseEther("1");
      const bobAddr = await bob.getAddress();

      for (let w = 0; w < n; w++) {
        const c = BigInt(w + 1) * 257n + BigInt(n) * 500n + 38_000_000n;
        const root = await depositOne(pool, alice, c, depositAmount);
        const nullifier = BigInt(w + 1) * 263n + BigInt(n) * 400n + 38_100_000n;
        await withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr);
      }

      expect(await pool.getWithdrawalRecordCount()).to.equal(BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 10 tree utilization percentages
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`tree utilization after ${n} deposits: treeUtilization == ${Math.floor((n * 100) / CAPACITY)}%`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 269n + BigInt(n) * 600n + 39_000_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      const util = await pool.getTreeUtilization();
      const expected = BigInt(Math.floor((n * 100) / CAPACITY));
      expect(util).to.equal(expected);
    });
  }

  // -------------------------------------------------------------------------
  // 10 stealth payment announcements emit events
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`announceStealthPayment #${i}: StealthPayment event emitted`, async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);

      const commitment = BigInt(i + 1) * 271n + 40_000_000n;
      const ephX = BigInt(i + 1) * 277n + 40_100_000n;
      const ephY = BigInt(i + 1) * 281n + 40_200_000n;
      const stX = BigInt(i + 1) * 283n + 40_300_000n;
      const stY = BigInt(i + 1) * 293n + 40_400_000n;
      const encAmt = BigInt(i + 1) * 307n + 40_500_000n;
      const encBld = BigInt(i + 1) * 311n + 40_600_000n;

      await expect(
        registry
          .connect(alice)
          .announceStealthPayment(commitment, ephX, ephY, stX, stY, encAmt, encBld)
      )
        .to.emit(registry, "StealthPayment")
        .withArgs(commitment, ephX, ephY, stX, stY, encAmt, encBld);
    });
  }
});
