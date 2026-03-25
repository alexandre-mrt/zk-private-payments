import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_HEIGHT = 5;
const CAPACITY = 2 ** MERKLE_HEIGHT; // 32

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

const ONE_DAY = 86_400;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const [owner, alice, bob, charlie, relayer, dave, eve] = await ethers.getSigners();

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

let _bulkCounter = 200_000n;
function nextC(): bigint {
  _bulkCounter += 17n;
  return _bulkCounter;
}

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
// Bulk Parametric
// ---------------------------------------------------------------------------

describe("Bulk Parametric", function () {
  // -------------------------------------------------------------------------
  // 30 deposit cycles with varying amounts
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    const amount = ethers.parseEther("0.01") * BigInt(i + 1);
    it(`deposit cycle #${i}: commitment stored, totalDeposited updated (${amount} wei)`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = BigInt(i + 1) * 97n + 300_000n;
      await depositOne(pool, alice, commitment, amount);
      expect(await pool.isCommitted(commitment)).to.be.true;
      expect(await pool.totalDeposited()).to.equal(amount);
    });
  }

  // -------------------------------------------------------------------------
  // 20 transfer split ratios — both output commitments land in tree
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    it(`transfer split ratio #${i}: both output commitments inserted`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const inputCommitment = BigInt(i + 1) * 101n + 400_000n;
      const root = await depositOne(pool, alice, inputCommitment, depositAmount);

      const out1 = BigInt(i + 1) * 103n + 500_000n;
      const out2 = BigInt(i + 1) * 107n + 600_000n;
      const nullifier = BigInt(i + 1) * 109n + 700_000n;

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
  // 15 batchDeposit sizes (1-10 capped, 5 extra at size 10)
  // -------------------------------------------------------------------------

  for (let batchSize = 1; batchSize <= 10; batchSize++) {
    it(`batchDeposit size ${batchSize}: all commitments inserted, depositCount == ${batchSize}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments: bigint[] = [];
      const amounts: bigint[] = [];
      const amount = ethers.parseEther("0.5");

      for (let j = 0; j < batchSize; j++) {
        commitments.push(BigInt(j + 1) * 113n + BigInt(batchSize) * 1000n + 800_000n);
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

  for (let extra = 0; extra < 5; extra++) {
    it(`batchDeposit size 10 run #${extra}: nextIndex correct`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments: bigint[] = [];
      const amounts: bigint[] = [];
      const amount = ethers.parseEther("0.1");

      for (let j = 0; j < 10; j++) {
        commitments.push(BigInt(j + 1) * 127n + BigInt(extra) * 2000n + 900_000n);
        amounts.push(amount);
      }

      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: amount * 10n,
      });

      expect(await pool.getDepositCount()).to.equal(10n);
    });
  }

  // -------------------------------------------------------------------------
  // 25 hash pairs — deterministic hashLeftRight
  // -------------------------------------------------------------------------

  for (let i = 0; i < 25; i++) {
    const left = BigInt(i + 1) * 131n + 1_000_000n;
    const right = BigInt(i + 1) * 137n + 1_100_000n;
    it(`hashLeftRight pair #${i}: result is deterministic and within field`, async function () {
      const { pool } = await loadFixture(deployPoolFixture);
      const h1 = await pool.hashLeftRight(left, right);
      const h2 = await pool.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.greaterThan(0n);
      expect(h1).to.be.lessThan(FIELD_SIZE);
    });
  }

  // -------------------------------------------------------------------------
  // 20 PoolLens snapshots after N deposits
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 20; n++) {
    it(`PoolLens snapshot after ${n} deposits: depositCount and balance match`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const PoolLensFactory = await ethers.getContractFactory("PoolLens");
      const lens = await PoolLensFactory.deploy();

      const depositAmount = ethers.parseEther("1");
      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 139n + BigInt(n) * 500n + 1_200_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.depositCount).to.equal(BigInt(n));
      expect(snapshot.poolBalance).to.equal(depositAmount * BigInt(n));
      expect(snapshot.version).to.equal("1.0.0");
    });
  }

  // -------------------------------------------------------------------------
  // 15 receipt metadata verifications
  // -------------------------------------------------------------------------

  for (let i = 0; i < 15; i++) {
    it(`receipt #${i}: owner correct, commitment stored`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receiptContract = await DepositReceiptFactory.deploy(await pool.getAddress());
      await pool.connect(owner).setDepositReceipt(await receiptContract.getAddress());

      const depositAmount = ethers.parseEther("1");
      const commitment = BigInt(i + 1) * 149n + BigInt(i) * 600n + 1_300_000n;
      await depositOne(pool, alice, commitment, depositAmount);

      // Each test makes exactly one deposit — token 0 is always the first minted
      expect(await receiptContract.ownerOf(0n)).to.equal(await alice.getAddress());
      expect(await receiptContract.tokenCommitment(0n)).to.equal(commitment);
    });
  }

  // -------------------------------------------------------------------------
  // 15 pagination slices — getCommitments correct
  // -------------------------------------------------------------------------

  for (let from = 0; from < 15; from++) {
    it(`getCommitments(${from}, 5): correct slice returned`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const stored: bigint[] = [];
      for (let d = 0; d < 20; d++) {
        const c = BigInt(d + 1) * 151n + BigInt(from) * 400n + 1_400_000n;
        stored.push(c);
        await depositOne(pool, alice, c, ethers.parseEther("0.1"));
      }

      const result = await pool.getCommitments(from, 5);
      const expected = stored.slice(from, from + 5);
      expect(result.length).to.equal(expected.length);
      for (let k = 0; k < expected.length; k++) {
        expect(result[k]).to.equal(expected[k]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // 15 getActiveNoteCount tracking
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 15; n++) {
    it(`getActiveNoteCount after ${n} deposits: activeNotes == ${n}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("0.5");

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 157n + BigInt(n) * 300n + 1_500_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      expect(await pool.getActiveNoteCount()).to.equal(BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 20 denomination enforcement tests
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
    it(`denomination ${denom} wei: exact deposit succeeds, flag set`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["addDenomination", denom])
      );
      await timelockQueue(pool, owner, hash);
      await pool.connect(owner).addDenomination(denom);

      const c = BigInt(i + 1) * 163n + 1_600_000n;
      await expect(pool.connect(alice).deposit(c, { value: denom })).to.not.be.reverted;
      expect(await pool.allowedDenominations(denom)).to.be.true;
    });
  }

  for (let i = 0; i < 10; i++) {
    const denom = denomValues[i];
    it(`denomination ${denom} wei: wrong amount rejected`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["addDenomination", denom])
      );
      await timelockQueue(pool, owner, hash);
      await pool.connect(owner).addDenomination(denom);

      const c = BigInt(i + 1) * 167n + 1_700_000n;
      const wrongAmount = denom + 1n;
      await expect(
        pool.connect(alice).deposit(c, { value: wrongAmount })
      ).to.be.revertedWith("ConfidentialPool: amount not an allowed denomination");
    });
  }

  // -------------------------------------------------------------------------
  // 10 allowlist toggling tests
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    it(`allowlist toggle #${i}: non-listed address rejected when enabled`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);

      const c = BigInt(i + 1) * 173n + 1_800_000n;
      await expect(
        pool.connect(alice).deposit(c, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  }

  for (let i = 0; i < 5; i++) {
    it(`allowlist toggle #${i}: listed address accepted when enabled`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);
      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(await alice.getAddress(), true);

      const c = BigInt(i + 1) * 179n + 1_900_000n;
      await expect(
        pool.connect(alice).deposit(c, { value: ethers.parseEther("1") })
      ).to.not.be.reverted;
    });
  }

  // -------------------------------------------------------------------------
  // 15 withdrawal record tracking
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 15; n++) {
    it(`withdrawal record count after ${n} withdrawals: count == ${n}`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");
      const withdrawAmount = ethers.parseEther("0.5");
      const bobAddr = await bob.getAddress();

      for (let w = 0; w < n; w++) {
        const c = BigInt(w + 1) * 181n + BigInt(n) * 200n + 2_000_000n;
        const root = await depositOne(pool, alice, c, depositAmount);
        const nullifier = BigInt(w + 1) * 191n + BigInt(n) * 300n + 2_100_000n;
        await withdrawOne(pool, root, nullifier, withdrawAmount, bobAddr);
      }

      expect(await pool.getWithdrawalRecordCount()).to.equal(BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 20 multi-signer deposit cycles
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    it(`multi-signer deposit #${i}: uniqueDepositorCount increments`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");

      const cA = BigInt(i + 1) * 193n + 2_200_000n;
      await depositOne(pool, alice, cA, depositAmount);

      const cB = BigInt(i + 1) * 197n + 2_300_000n;
      await depositOne(pool, bob, cB, depositAmount);

      expect(await pool.uniqueDepositorCount()).to.equal(2n);
    });
  }

  // -------------------------------------------------------------------------
  // 10 stealth registry operations
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    const kx = BigInt(i + 1) * 211n + 2_400_000n;
    const ky = BigInt(i + 1) * 223n + 2_500_000n;
    it(`stealth registry op #${i}: register key (${kx}, ${ky}) and retrieve`, async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);
      await registry.connect(alice).registerViewingKey(kx, ky);
      const aliceAddr = await alice.getAddress();
      const [gotX, gotY] = await registry.getViewingKey(aliceAddr);
      expect(gotX).to.equal(kx);
      expect(gotY).to.equal(ky);
    });
  }

  // -------------------------------------------------------------------------
  // 10 tree utilization tracking
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`tree utilization after ${n} deposits: treeUtilization == ${Math.floor(n * 100 / CAPACITY)}%`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const depositAmount = ethers.parseEther("1");

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 227n + BigInt(n) * 400n + 2_600_000n;
        await depositOne(pool, alice, c, depositAmount);
      }

      const util = await pool.getTreeUtilization();
      const expected = BigInt(Math.floor(n * 100 / CAPACITY));
      expect(util).to.equal(expected);
    });
  }
});
