import { loadFixture, mine, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool, PoolLens, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const TREE_HEIGHT = 5; // capacity = 32
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
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
}

function indexedCommitment(i: number): bigint {
  return BigInt(i + 1) * 999999999n;
}

function indexedNullifier(i: number): bigint {
  return BigInt(i + 1) * 777777777n;
}

function timelockHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(
  pool: ConfidentialPool,
  signer: Signer,
  commitment: bigint,
  value: bigint = ethers.parseEther("1")
): Promise<void> {
  await pool.connect(signer).deposit(commitment, { value });
}

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
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  return { pool, owner, alice, bob, charlie, relayer };
}

async function deployPoolWithLensFixture() {
  const base = await deployPoolFixture();
  const LensFactory = await ethers.getContractFactory("PoolLens");
  const lens = (await LensFactory.deploy()) as unknown as PoolLens;
  return { ...base, lens };
}

async function deployPoolWithReceiptFixture() {
  const base = await deployPoolFixture();
  const { pool, owner } = base;

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await pool.getAddress()
  )) as unknown as DepositReceipt;

  await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Systematic Tests
// ---------------------------------------------------------------------------

describe("Systematic Tests - ConfidentialPool", function () {
  // -------------------------------------------------------------------------
  // deposit with 20 different amounts (20 tests)
  // -------------------------------------------------------------------------

  const depositAmounts = [
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
    ethers.parseEther("100"),
    1n,
    100n,
    1000n,
    10000n,
    100000n,
    1000000n,
    10000000n,
    100000000n,
    1000000000n,
  ];

  for (let i = 0; i < depositAmounts.length; i++) {
    const amount = depositAmounts[i];
    it(`deposit #${i + 1}: amount ${ethers.formatEther(amount)} ETH tracked correctly`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitment = indexedCommitment(i + 1);
      await pool.connect(alice).deposit(commitment, { value: amount });

      expect(await pool.commitments(commitment)).to.equal(true);
      expect(await pool.isCommitted(commitment)).to.equal(true);
      expect(await pool.getDepositCount()).to.equal(1);
      expect(await pool.totalDeposited()).to.equal(amount);
      expect(await pool.getPoolBalance()).to.equal(amount);
    });
  }

  // -------------------------------------------------------------------------
  // batchDeposit with sizes 1-10 (10 tests)
  // -------------------------------------------------------------------------

  for (let batchSize = 1; batchSize <= 10; batchSize++) {
    it(`batchDeposit with ${batchSize} notes: all commitments tracked`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitmentList: bigint[] = [];
      const amounts: bigint[] = [];
      let totalAmount = 0n;

      for (let j = 0; j < batchSize; j++) {
        const c = indexedCommitment(j + batchSize * 100);
        commitmentList.push(c);
        const amount = ethers.parseEther("1");
        amounts.push(amount);
        totalAmount += amount;
      }

      await pool.connect(alice).batchDeposit(commitmentList, amounts, { value: totalAmount });

      expect(await pool.getDepositCount()).to.equal(batchSize);
      expect(await pool.totalDeposited()).to.equal(totalAmount);

      for (const c of commitmentList) {
        expect(await pool.commitments(c)).to.equal(true);
      }
    });
  }

  // -------------------------------------------------------------------------
  // transfer with 10 different output commitment pairs (10 tests)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`transfer #${i + 1}: input nullifier spent, two output commitments inserted`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const inputCommitment = indexedCommitment(i + 200);
      await doDeposit(pool, alice, inputCommitment);
      const root = await pool.getLastRoot();

      const nullifier = indexedNullifier(i + 200);
      const out1 = indexedCommitment(i + 300);
      const out2 = indexedCommitment(i + 400);

      await pool.connect(alice).transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        out1,
        out2
      );

      expect(await pool.nullifiers(nullifier)).to.equal(true);
      expect(await pool.isSpent(nullifier)).to.equal(true);
      expect(await pool.commitments(out1)).to.equal(true);
      expect(await pool.commitments(out2)).to.equal(true);
      expect(await pool.totalTransfers()).to.equal(1n);
    });
  }

  // -------------------------------------------------------------------------
  // withdraw with 10 different amounts (10 tests)
  // -------------------------------------------------------------------------

  const withdrawAmounts = [
    ethers.parseEther("0.1"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1"),
    ethers.parseEther("1.5"),
    ethers.parseEther("2"),
    ethers.parseEther("3"),
    ethers.parseEther("5"),
    ethers.parseEther("7"),
    ethers.parseEther("9"),
    ethers.parseEther("10"),
  ];

  for (let i = 0; i < withdrawAmounts.length; i++) {
    const amount = withdrawAmounts[i];
    it(`withdraw #${i + 1}: amount ${ethers.formatEther(amount)} ETH, nullifier spent, stats updated`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const inputCommitment = indexedCommitment(i + 500);
      // Deposit enough to cover the withdraw amount
      await doDeposit(pool, alice, inputCommitment, amount + ethers.parseEther("1"));
      const root = await pool.getLastRoot();

      const nullifier = indexedNullifier(i + 500);
      const bobAddr = await bob.getAddress();

      await pool.connect(alice).withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        amount,
        bobAddr as `0x${string}`,
        0n,
        ethers.ZeroAddress as `0x${string}`,
        0n
      );

      expect(await pool.nullifiers(nullifier)).to.equal(true);
      expect(await pool.totalWithdrawn()).to.equal(amount);
      expect(await pool.withdrawalCount()).to.equal(1n);
    });
  }

  // -------------------------------------------------------------------------
  // denomination allow-list: add 10 different denominations (10 tests)
  // -------------------------------------------------------------------------

  const denominations = [
    ethers.parseEther("0.01"),
    ethers.parseEther("0.05"),
    ethers.parseEther("0.1"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1"),
    ethers.parseEther("2"),
    ethers.parseEther("5"),
    ethers.parseEther("10"),
    ethers.parseEther("50"),
    ethers.parseEther("100"),
  ];

  for (let i = 0; i < denominations.length; i++) {
    const denom = denominations[i];
    it(`denomination #${i + 1}: add ${ethers.formatEther(denom)} ETH, deposit with exact amount succeeds`, async function () {
      const { pool, owner, alice } = await loadFixture(deployPoolFixture);

      // Add the denomination via timelock
      const ah = timelockHash("addDenomination", denom);
      await pool.connect(owner).queueAction(ah);
      await time.increase(ONE_DAY + 1);
      await pool.connect(owner).addDenomination(denom);

      expect(await pool.allowedDenominations(denom)).to.equal(true);

      // Deposit with the exact denomination
      const commitment = indexedCommitment(i + 600);
      await pool.connect(alice).deposit(commitment, { value: denom });

      expect(await pool.commitments(commitment)).to.equal(true);
    });
  }

  // -------------------------------------------------------------------------
  // allowlist: 10 different users allowed to deposit (10 tests)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`allowlist user #${i + 1}: only allowlisted address can deposit when enabled`, async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

      await pool.connect(owner).setAllowlistEnabled(true);
      await pool.connect(owner).setAllowlisted(await alice.getAddress(), true);

      const commitment = indexedCommitment(i + 700);

      // Alice is allowlisted — deposit succeeds
      await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
      expect(await pool.commitments(commitment)).to.equal(true);

      // Bob is not allowlisted — deposit reverts
      const bobCommitment = indexedCommitment(i + 800);
      await expect(
        pool.connect(bob).deposit(bobCommitment, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
    });
  }

  // -------------------------------------------------------------------------
  // getPoolStats after N deposits (10 tests)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`getPoolStats correct after ${n} deposits`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const depositAmount = ethers.parseEther("1");

      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 900 + n * 11);
        await doDeposit(pool, alice, c, depositAmount);
      }

      const [td, tw, tt, dc, wc, ud, pb] = await pool.getPoolStats();

      expect(dc).to.equal(n);
      expect(wc).to.equal(0n);
      expect(tt).to.equal(0n);
      expect(td).to.equal(BigInt(n) * depositAmount);
      expect(tw).to.equal(0n);
      expect(ud).to.equal(1n); // all from alice
      expect(pb).to.equal(BigInt(n) * depositAmount);
    });
  }

  // -------------------------------------------------------------------------
  // getActiveNoteCount: N deposits, K transfers (10 tests)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 5; n++) {
    it(`${n} deposits, 0 transfers: activeNoteCount == ${n}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 1000 + n * 7);
        await doDeposit(pool, alice, c, ethers.parseEther("1"));
      }

      // activeNotes = nextIndex - (withdrawalCount + totalTransfers) = n - 0 = n
      expect(await pool.getActiveNoteCount()).to.equal(n);
    });

    it(`${n} deposits, ${n} transfers: activeNoteCount == ${n * 2}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 1100 + n * 8);
        await doDeposit(pool, alice, c, ethers.parseEther("1"));
      }

      // Each transfer consumes 1 nullifier and inserts 2 commitments
      // After n transfers: nextIndex = n (deposits) + 2*n (outputs) = 3n
      // spent = n (transfers), so active = 3n - n = 2n
      const root = await pool.getLastRoot();
      for (let j = 0; j < n; j++) {
        const nullifier = indexedNullifier(j + 1100 + n * 8);
        const out1 = indexedCommitment(j + 1200 + n * 8);
        const out2 = indexedCommitment(j + 1300 + n * 8);
        await pool.connect(alice).transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          nullifier,
          out1,
          out2
        );
      }

      expect(await pool.getActiveNoteCount()).to.equal(n * 2);
    });
  }

  // -------------------------------------------------------------------------
  // PoolLens snapshot at various states (10 tests)
  // -------------------------------------------------------------------------

  for (let state = 0; state < 10; state++) {
    it(`PoolLens snapshot correct at state ${state} (${state} deposits)`, async function () {
      const { pool, lens, alice } = await loadFixture(deployPoolWithLensFixture);

      const depositAmount = ethers.parseEther("1");
      for (let j = 0; j < state; j++) {
        const c = indexedCommitment(j + 1400 + state * 4);
        await doDeposit(pool, alice, c, depositAmount);
      }

      const snapshot = await lens.getSnapshot(await pool.getAddress());

      expect(snapshot.depositCount).to.equal(state);
      expect(snapshot.totalDeposited).to.equal(BigInt(state) * depositAmount);
      expect(snapshot.withdrawalCount).to.equal(0n);
      expect(snapshot.totalTransfers).to.equal(0n);
      expect(snapshot.isPaused).to.equal(false);
      expect(snapshot.poolBalance).to.equal(BigInt(state) * depositAmount);
      expect(snapshot.activeNotes).to.equal(state);
    });
  }

  // -------------------------------------------------------------------------
  // Receipt minting: sequential tokenIds (10 tests)
  // -------------------------------------------------------------------------

  for (let tokenId = 0; tokenId < 10; tokenId++) {
    it(`receipt tokenId ${tokenId}: ownerOf and tokenCommitment correct`, async function () {
      const { pool, receipt, alice } = await loadFixture(deployPoolWithReceiptFixture);

      const commitmentList: bigint[] = [];
      const depositAmount = ethers.parseEther("1");

      for (let j = 0; j <= tokenId; j++) {
        const c = indexedCommitment(j + 1500 + tokenId * 3);
        await doDeposit(pool, alice, c, depositAmount);
        commitmentList.push(c);
      }

      expect(await receipt.ownerOf(tokenId)).to.equal(await alice.getAddress());
      expect(await receipt.tokenCommitment(tokenId)).to.equal(commitmentList[tokenId]);
      expect(await receipt.tokenAmount(tokenId)).to.equal(depositAmount);
    });
  }

  // -------------------------------------------------------------------------
  // getCommitments pagination (10 tests)
  // -------------------------------------------------------------------------

  for (let from = 0; from < 10; from++) {
    it(`getCommitments(${from}, 3) returns correct slice from ${from}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitmentList: bigint[] = [];
      for (let j = 0; j < 12; j++) {
        const c = indexedCommitment(j + 1600 + from * 13);
        await doDeposit(pool, alice, c, ethers.parseEther("1"));
        commitmentList.push(c);
      }

      const slice = await pool.getCommitments(from, 3);
      expect(slice.length).to.equal(3);
      for (let k = 0; k < 3; k++) {
        expect(slice[k]).to.equal(commitmentList[from + k]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // isKnownRoot for N sequential roots (15 tests)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 15; i++) {
    it(`isKnownRoot true for root after deposit #${i + 1}`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      for (let j = 0; j <= i; j++) {
        const c = indexedCommitment(j + 1700 + i * 20);
        await doDeposit(pool, alice, c, ethers.parseEther("1"));
      }

      const lastRoot = await pool.getLastRoot();
      expect(await pool.isKnownRoot(lastRoot)).to.equal(true);
    });
  }

  // -------------------------------------------------------------------------
  // maxWithdrawAmount enforcement (10 tests)
  // -------------------------------------------------------------------------

  const maxWithdrawValues = [
    ethers.parseEther("0.5"),
    ethers.parseEther("1"),
    ethers.parseEther("2"),
    ethers.parseEther("5"),
    ethers.parseEther("10"),
    ethers.parseEther("20"),
    ethers.parseEther("50"),
    ethers.parseEther("100"),
    ethers.parseEther("500"),
    ethers.parseEther("1000"),
  ];

  for (let i = 0; i < maxWithdrawValues.length; i++) {
    const maxAmt = maxWithdrawValues[i];
    it(`maxWithdrawAmount ${ethers.formatEther(maxAmt)} ETH: withdraw at cap succeeds, above cap reverts`, async function () {
      const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

      // Set max withdraw amount via timelock
      const ah = timelockHash("setMaxWithdrawAmount", maxAmt);
      await pool.connect(owner).queueAction(ah);
      await time.increase(ONE_DAY + 1);
      await pool.connect(owner).setMaxWithdrawAmount(maxAmt);

      expect(await pool.maxWithdrawAmount()).to.equal(maxAmt);

      // Deposit more than the cap
      const inputCommitment = indexedCommitment(i + 1800);
      await doDeposit(pool, alice, inputCommitment, maxAmt + ethers.parseEther("10"));
      const root = await pool.getLastRoot();

      // Withdraw exactly at cap — should succeed
      const nullifier = indexedNullifier(i + 1800);
      const bobAddr = await bob.getAddress();

      await pool.connect(alice).withdraw(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        nullifier,
        maxAmt,
        bobAddr as `0x${string}`,
        0n,
        ethers.ZeroAddress as `0x${string}`,
        0n
      );

      expect(await pool.nullifiers(nullifier)).to.equal(true);

      // Withdraw above cap — should revert
      const nullifier2 = indexedNullifier(i + 1900);
      await expect(
        pool.connect(alice).withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          nullifier2,
          maxAmt + 1n,
          bobAddr as `0x${string}`,
          0n,
          ethers.ZeroAddress as `0x${string}`,
          0n
        )
      ).to.be.revertedWith("ConfidentialPool: amount exceeds withdrawal limit");
    });
  }

  // -------------------------------------------------------------------------
  // depositsPerAddress tracking (5 tests)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 5; n++) {
    it(`depositsPerAddress tracks ${n} deposits from same address`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 2000 + n * 6);
        await doDeposit(pool, alice, c, ethers.parseEther("1"));
      }

      expect(await pool.depositsPerAddress(await alice.getAddress())).to.equal(n);
    });
  }

  // -------------------------------------------------------------------------
  // uniqueDepositorCount across different depositors (5 tests)
  // -------------------------------------------------------------------------

  for (let depositors = 1; depositors <= 5; depositors++) {
    it(`uniqueDepositorCount == ${depositors} after ${depositors} distinct depositors`, async function () {
      const { pool, alice, bob, charlie, owner, relayer } = await loadFixture(deployPoolFixture);
      const signers = [alice, bob, charlie, owner, relayer];

      for (let j = 0; j < depositors; j++) {
        const c = indexedCommitment(j + 2100 + depositors * 5);
        await doDeposit(pool, signers[j], c, ethers.parseEther("1"));
      }

      expect(await pool.uniqueDepositorCount()).to.equal(depositors);
    });
  }

  // -------------------------------------------------------------------------
  // commitmentIndex / indexToCommitment round-trip (10 tests)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`commitmentIndex round-trip for ${n} commitments`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const commitmentList: bigint[] = [];
      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 2200 + n * 13);
        await doDeposit(pool, alice, c, ethers.parseEther("1"));
        commitmentList.push(c);
      }

      for (let j = 0; j < n; j++) {
        const idx = await pool.commitmentIndex(commitmentList[j]);
        expect(idx).to.equal(j);
        expect(await pool.indexToCommitment(j)).to.equal(commitmentList[j]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // getPoolHealth consistency checks (10 tests)
  // -------------------------------------------------------------------------

  for (let n = 0; n < 10; n++) {
    it(`getPoolHealth matches getPoolStats after ${n} deposits`, async function () {
      const { pool, alice } = await loadFixture(deployPoolFixture);

      const depositAmount = ethers.parseEther("1");
      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 2300 + n * 7);
        await doDeposit(pool, alice, c, depositAmount);
      }

      const [activeNotes, , poolBalance, isPaused, isAllowlisted] = await pool.getPoolHealth();
      const [, , , , , , statsBalance] = await pool.getPoolStats();

      expect(activeNotes).to.equal(n);
      expect(poolBalance).to.equal(statsBalance);
      expect(isPaused).to.equal(false);
      expect(isAllowlisted).to.equal(false);
    });
  }

  // -------------------------------------------------------------------------
  // batchSetAllowlisted: bulk allow/revoke (5 tests)
  // -------------------------------------------------------------------------

  for (let count = 1; count <= 5; count++) {
    it(`batchSetAllowlisted allows ${count} addresses in one call`, async function () {
      const { pool, owner, alice, bob, charlie, relayer } = await loadFixture(deployPoolFixture);
      const signers = [alice, bob, charlie, relayer, owner];
      const addresses = (await Promise.all(signers.slice(0, count).map((s) => s.getAddress())));

      await pool.connect(owner).batchSetAllowlisted(addresses, true);

      for (const addr of addresses) {
        expect(await pool.allowlisted(addr)).to.equal(true);
      }
    });
  }

  // -------------------------------------------------------------------------
  // withdrawalRecords append-only tracking (5 tests)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 5; n++) {
    it(`withdrawalRecords has ${n} entries after ${n} withdrawals`, async function () {
      const { pool, alice, bob } = await loadFixture(deployPoolFixture);

      const depositAmount = ethers.parseEther("10");
      const withdrawAmount = ethers.parseEther("1");

      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 2400 + n * 10);
        await doDeposit(pool, alice, c, depositAmount);
      }

      const root = await pool.getLastRoot();
      const bobAddr = await bob.getAddress();

      for (let j = 0; j < n; j++) {
        const nullifier = indexedNullifier(j + 2400 + n * 10);
        await pool.connect(alice).withdraw(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          nullifier,
          withdrawAmount,
          bobAddr as `0x${string}`,
          0n,
          ethers.ZeroAddress as `0x${string}`,
          0n
        );
      }

      expect(await pool.withdrawalCount()).to.equal(n);

      // Verify each record is accessible
      for (let j = 0; j < n; j++) {
        const record = await pool.withdrawalRecords(j);
        expect(record.amount).to.equal(withdrawAmount);
        expect(record.recipient).to.equal(bobAddr);
      }
    });
  }
});
