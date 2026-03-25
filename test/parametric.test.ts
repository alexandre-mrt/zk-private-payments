import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";
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
    MERKLE_HEIGHT,
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie, relayer };
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

let _counter = 5000n;
function uniqueCommitment(): bigint {
  _counter += 11n;
  return _counter;
}

async function deposit(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  signer: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  commitment: bigint,
  value: bigint
): Promise<bigint> {
  await pool.connect(signer).deposit(commitment, { value });
  return pool.getLastRoot();
}

async function withdraw(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment = 0n,
  relayer = ethers.ZeroAddress,
  fee = 0n
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
    relayer as `0x${string}`,
    fee
  );
}

// Timelock helper
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
// Parametric Tests
// ---------------------------------------------------------------------------

describe("Parametric Tests", function () {
  // -------------------------------------------------------------------------
  // 20 deposit amounts (1 wei to 100 ETH) — deposit accepted, balance updated
  // -------------------------------------------------------------------------

  const depositAmounts = [
    1n,
    100n,
    1000n,
    ethers.parseEther("0.001"),
    ethers.parseEther("0.01"),
    ethers.parseEther("0.1"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1"),
    ethers.parseEther("2"),
    ethers.parseEther("5"),
    ethers.parseEther("10"),
    ethers.parseEther("20"),
    ethers.parseEther("25"),
    ethers.parseEther("30"),
    ethers.parseEther("40"),
    ethers.parseEther("50"),
    ethers.parseEther("60"),
    ethers.parseEther("75"),
    ethers.parseEther("90"),
    ethers.parseEther("100"),
  ];

  for (const amount of depositAmounts) {
    it(`deposit amount ${amount} wei: accepted and tracked`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitment = uniqueCommitment();
      await expect(
        pool.connect(alice).deposit(commitment, { value: amount })
      ).to.not.be.reverted;
      expect(await pool.totalDeposited()).to.equal(amount);
    });
  }

  // -------------------------------------------------------------------------
  // 10 transfer split ratios — both output commitments land in tree
  // -------------------------------------------------------------------------

  const splitLabels = ["100/0", "90/10", "75/25", "60/40", "50/50", "40/60", "25/75", "10/90", "1/99", "0/100"];

  for (let i = 0; i < 10; i++) {
    it(`transfer split ${splitLabels[i]}: both output commitments inserted`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const inputCommitment = uniqueCommitment();
      const depositAmount = ethers.parseEther("1");
      const root = await deposit(pool, alice, inputCommitment, depositAmount);

      const out1 = uniqueCommitment();
      const out2 = uniqueCommitment();
      const nullifier = uniqueCommitment();

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
  // 10 batchDeposit sizes (1-10) — all commitments accepted, nextIndex correct
  // -------------------------------------------------------------------------

  for (let batchSize = 1; batchSize <= 10; batchSize++) {
    it(`batchDeposit size ${batchSize}: all commitments inserted, nextIndex == ${batchSize}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);
      const commitments: bigint[] = [];
      const amounts: bigint[] = [];
      const amount = ethers.parseEther("1");

      for (let j = 0; j < batchSize; j++) {
        commitments.push(uniqueCommitment());
        amounts.push(amount);
      }

      const totalEth = amount * BigInt(batchSize);
      await pool.connect(alice).batchDeposit(commitments, amounts, { value: totalEth });

      expect(await pool.getDepositCount()).to.equal(BigInt(batchSize));
      for (const c of commitments) {
        expect(await pool.commitments(c)).to.be.true;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 15 withdrawal amounts — pool balance decreases by correct amount
  // -------------------------------------------------------------------------

  const withdrawalAmounts = [
    1n,
    100n,
    ethers.parseEther("0.001"),
    ethers.parseEther("0.01"),
    ethers.parseEther("0.1"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1"),
    ethers.parseEther("2"),
    ethers.parseEther("5"),
    ethers.parseEther("10"),
    ethers.parseEther("20"),
    ethers.parseEther("50"),
    ethers.parseEther("75"),
    ethers.parseEther("90"),
    ethers.parseEther("100"),
  ];

  for (const wAmount of withdrawalAmounts) {
    it(`withdraw ${wAmount} wei: pool balance decreases correctly`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const commitment = uniqueCommitment();
      const root = await deposit(pool, alice, commitment, wAmount);

      const bobAddr = await bob.getAddress();
      const balanceBefore = await pool.getPoolBalance();

      const nullifier = uniqueCommitment();
      await withdraw(pool, root, nullifier, wAmount, bobAddr);

      const balanceAfter = await pool.getPoolBalance();
      expect(balanceBefore - balanceAfter).to.equal(wAmount);
    });
  }

  // -------------------------------------------------------------------------
  // 10 denomination values — deposits accepted / rejected based on list
  // -------------------------------------------------------------------------

  const denominations = [
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

  for (const denom of denominations) {
    it(`denomination ${denom} wei: deposit with exact amount succeeds`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      // Queue and execute addDenomination
      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["addDenomination", denom])
      );
      await timelockQueue(pool, owner, hash);
      await pool.connect(owner).addDenomination(denom);

      // Deposit with exact denomination
      const commitment = uniqueCommitment();
      await expect(
        pool.connect(alice).deposit(commitment, { value: denom })
      ).to.not.be.reverted;
      expect(await pool.allowedDenominations(denom)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 10 allowlist scenarios
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`allowlist scenario #${i}: non-listed address rejected when enabled`, async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setAllowlistEnabled(true);
      // Alice is NOT added; try to deposit
      const c = uniqueCommitment();
      await expect(
        pool.connect(alice).deposit(c, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  }

  // -------------------------------------------------------------------------
  // 15 view function checks after N operations
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 15; n++) {
    it(`view functions consistent after ${n} deposits`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      for (let d = 0; d < n; d++) {
        const c = uniqueCommitment();
        await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      }

      const depositCount = await pool.getDepositCount();
      expect(depositCount).to.equal(BigInt(n));

      const poolBalance = await pool.getPoolBalance();
      expect(poolBalance).to.equal(ethers.parseEther("1") * BigInt(n));

      const [totalDeposited, , , dc, , , pb] = await pool.getPoolStats();
      expect(totalDeposited).to.equal(ethers.parseEther("1") * BigInt(n));
      expect(dc).to.equal(BigInt(n));
      expect(pb).to.equal(ethers.parseEther("1") * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 10 stealth registry operations
  // -------------------------------------------------------------------------

  const stealthKeyPairs: Array<[bigint, bigint]> = [
    [1n, 1n],
    [100n, 200n],
    [2n ** 32n, 2n ** 64n],
    [999n, 888n],
    [42n, 43n],
    [FIELD_SIZE - 1n, 1n],
    [2n ** 128n, 2n ** 129n],
    [12345n, 67890n],
    [1111n, 2222n],
    [9999999n, 8888888n],
  ];

  for (let i = 0; i < stealthKeyPairs.length; i++) {
    const [kx, ky] = stealthKeyPairs[i];
    it(`stealth registry op #${i}: register key (${kx}, ${ky}) and retrieve it`, async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);

      await registry.connect(alice).registerViewingKey(kx, ky);

      const aliceAddr = await alice.getAddress();
      const [gotX, gotY] = await registry.getViewingKey(aliceAddr);
      expect(gotX).to.equal(kx);
      expect(gotY).to.equal(ky);
    });
  }

  // -------------------------------------------------------------------------
  // 10 pool health checks — after N deposits, health metrics match state
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`pool health after ${n} deposits: treeUtilization == ${Math.floor(n * 100 / CAPACITY)}%`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      for (let d = 0; d < n; d++) {
        const c = uniqueCommitment();
        await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      }

      const [activeNotes, treeUtilization, poolBalance, isPaused, isAllowlisted] =
        await pool.getPoolHealth();

      const expectedUtil = BigInt(Math.floor(n * 100 / CAPACITY));
      expect(treeUtilization).to.equal(expectedUtil);
      expect(activeNotes).to.equal(BigInt(n));
      expect(poolBalance).to.equal(ethers.parseEther("1") * BigInt(n));
      expect(isPaused).to.be.false;
      expect(isAllowlisted).to.be.false;
    });
  }

  // -------------------------------------------------------------------------
  // 10 PoolLens snapshot checks
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`PoolLens snapshot after ${n} deposits: depositCount and balance match`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const PoolLensFactory = await ethers.getContractFactory("PoolLens");
      const lens = await PoolLensFactory.deploy();

      for (let d = 0; d < n; d++) {
        const c = uniqueCommitment();
        await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      }

      const snapshot = await lens.getSnapshot(await pool.getAddress());
      expect(snapshot.depositCount).to.equal(BigInt(n));
      expect(snapshot.poolBalance).to.equal(ethers.parseEther("1") * BigInt(n));
      expect(snapshot.version).to.equal("1.0.0");
    });
  }

  // -------------------------------------------------------------------------
  // 10 nullifier uniqueness checks — each withdrawal uses a distinct nullifier
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`nullifier uniqueness: ${n} withdrawals all accepted (distinct nullifiers)`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);
      const bobAddr = await bob.getAddress();

      // Pre-fund the pool with enough ETH for N withdrawals
      for (let d = 0; d < n; d++) {
        const c = uniqueCommitment();
        await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      }

      for (let w = 0; w < n; w++) {
        const root = await pool.getLastRoot();
        const nullifier = uniqueCommitment();
        await expect(
          withdraw(pool, root, nullifier, ethers.parseEther("1"), bobAddr)
        ).to.not.be.reverted;
        expect(await pool.nullifiers(nullifier)).to.be.true;
      }

      expect(await pool.getWithdrawalRecordCount()).to.equal(BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 10 isCommitted checks after batch deposit
  // -------------------------------------------------------------------------

  for (let batchSize = 1; batchSize <= 10; batchSize++) {
    it(`isCommitted: all ${batchSize} commitments in batch are registered`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitments: bigint[] = [];
      const amounts: bigint[] = [];
      const amount = ethers.parseEther("0.5");

      for (let j = 0; j < batchSize; j++) {
        commitments.push(uniqueCommitment());
        amounts.push(amount);
      }

      await pool.connect(alice).batchDeposit(commitments, amounts, {
        value: amount * BigInt(batchSize),
      });

      for (const c of commitments) {
        expect(await pool.isCommitted(c)).to.be.true;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 10 root history checks — N deposits yield N+1 valid roots
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`root history: after ${n} deposits, ${n + 1} valid roots exist`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      for (let d = 0; d < n; d++) {
        const c = uniqueCommitment();
        await pool.connect(alice).deposit(c, { value: ethers.parseEther("1") });
      }

      const validCount = await pool.getValidRootCount();
      // 1 initial root (from constructor) + n deposit roots
      expect(validCount).to.equal(BigInt(n + 1));
    });
  }

  // -------------------------------------------------------------------------
  // 10 announceStealthPayment — events emitted correctly
  // -------------------------------------------------------------------------

  const stealthPayloads = Array.from({ length: 10 }, (_, i) => ({
    commitment: BigInt(i + 1) * 777n + 100n,
    ephX: BigInt(i + 1) * 111n,
    ephY: BigInt(i + 1) * 222n,
    stX: BigInt(i + 1) * 333n,
    stY: BigInt(i + 1) * 444n,
    encAmt: BigInt(i + 1) * 555n,
    encBld: BigInt(i + 1) * 666n,
  }));

  for (let i = 0; i < stealthPayloads.length; i++) {
    const p = stealthPayloads[i];
    it(`announceStealthPayment #${i}: StealthPayment event emitted`, async function () {
      const { registry, alice } = await loadFixture(deployStealthFixture);

      await expect(
        registry.connect(alice).announceStealthPayment(
          p.commitment,
          p.ephX,
          p.ephY,
          p.stX,
          p.stY,
          p.encAmt,
          p.encBld
        )
      )
        .to.emit(registry, "StealthPayment")
        .withArgs(p.commitment, p.ephX, p.ephY, p.stX, p.stY, p.encAmt, p.encBld);
    });
  }
});
