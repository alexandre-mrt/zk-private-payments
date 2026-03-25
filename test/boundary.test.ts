import {
  loadFixture,
  mine,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
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

function randomCommitment(): bigint {
  // 31 bytes guarantees the result is < FIELD_SIZE
  const raw = ethers.toBigInt(ethers.randomBytes(31));
  return raw === 0n ? 1n : raw;
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
    5, // small tree — 32 leaves
    hasherAddress
  );

  return { pool, owner, alice, bob, relayer };
}

const ONE_DAY = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Timelock helpers
// ---------------------------------------------------------------------------

type Pool = Awaited<ReturnType<typeof deployPoolFixture>>["pool"];
type Signer = Awaited<ReturnType<typeof deployPoolFixture>>["owner"];

async function timelockAddDenomination(
  pool: Pool,
  owner: Signer,
  denomination: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["addDenomination", denomination]
    )
  );
  await pool.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await pool.connect(owner).addDenomination(denomination);
}

async function timelockRemoveDenomination(
  pool: Pool,
  owner: Signer,
  denomination: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["removeDenomination", denomination]
    )
  );
  await pool.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await pool.connect(owner).removeDenomination(denomination);
}

// ---------------------------------------------------------------------------
// Shared withdraw helper — uses ZERO_PROOF (verifier always returns true in tests)
// ---------------------------------------------------------------------------

async function doWithdraw(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  caller: Awaited<ReturnType<typeof deployPoolFixture>>["alice"],
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment: bigint = 0n
) {
  return pool
    .connect(caller)
    .withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifier,
      amount,
      recipient,
      changeCommitment,
      ethers.ZeroAddress,
      0n
    );
}

// ---------------------------------------------------------------------------
// Boundary Tests
// ---------------------------------------------------------------------------

describe("Boundary Tests", function () {
  // -------------------------------------------------------------------------
  // Deposit amount boundaries
  // -------------------------------------------------------------------------

  it("accepts 1 wei deposit", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();
    await expect(
      pool.connect(alice).deposit(commitment, { value: 1n })
    ).to.not.be.reverted;
    expect(await pool.getPoolBalance()).to.equal(1n);
  });

  it("accepts 100 ETH deposit", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);
    const commitment = randomCommitment();
    const largeAmount = ethers.parseEther("100");
    await expect(
      pool.connect(alice).deposit(commitment, { value: largeAmount })
    ).to.not.be.reverted;
    expect(await pool.getPoolBalance()).to.equal(largeAmount);
  });

  // -------------------------------------------------------------------------
  // Transfer with zero-amount second output
  // -------------------------------------------------------------------------

  it("transfer with zero-amount output commitment reverts (zero commitment not allowed)", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: ethers.parseEther("1") });
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const outputCommitment1 = randomCommitment();
    // outputCommitment2 = 0 is not a valid field element (commitment is zero)
    await expect(
      pool
        .connect(alice)
        .transfer(
          ZERO_PROOF.pA,
          ZERO_PROOF.pB,
          ZERO_PROOF.pC,
          root,
          nullifier,
          outputCommitment1,
          0n // zero commitment rejected
        )
    ).to.be.revertedWith("ConfidentialPool: zero output commitment");
  });

  // -------------------------------------------------------------------------
  // Full withdrawal with zero change commitment
  // -------------------------------------------------------------------------

  it("full withdrawal with zero change commitment succeeds", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: depositAmount });
    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();

    const balanceBefore = await ethers.provider.getBalance(bob.address);

    await doWithdraw(
      pool,
      alice,
      root,
      nullifier,
      depositAmount,
      bob.address,
      0n // no change note
    );

    const balanceAfter = await ethers.provider.getBalance(bob.address);
    expect(balanceAfter - balanceBefore).to.equal(depositAmount);
    expect(await pool.getPoolBalance()).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // batchDeposit with exactly 10 items (maximum allowed)
  // -------------------------------------------------------------------------

  it("batchDeposit with 10 items (max) succeeds", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const commitments: bigint[] = [];
    const amounts: bigint[] = [];
    const perDeposit = ethers.parseEther("0.1");
    let total = 0n;

    for (let i = 0; i < 10; i++) {
      commitments.push(randomCommitment());
      amounts.push(perDeposit);
      total += perDeposit;
    }

    await expect(
      pool
        .connect(alice)
        .batchDeposit(commitments, amounts, { value: total })
    ).to.not.be.reverted;

    expect(await pool.nextIndex()).to.equal(10n);
    expect(await pool.getPoolBalance()).to.equal(total);
  });

  // -------------------------------------------------------------------------
  // 3 consecutive transfers all succeed
  // -------------------------------------------------------------------------

  it("3 consecutive transfers all succeed", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    // Seed the pool with an initial deposit so the tree has a known root
    const seed = randomCommitment();
    await pool.connect(alice).deposit(seed, { value: ethers.parseEther("1") });

    for (let i = 0; i < 3; i++) {
      const root = await pool.getLastRoot();
      const nullifier = randomCommitment();
      const out1 = randomCommitment();
      const out2 = randomCommitment();

      await expect(
        pool
          .connect(alice)
          .transfer(
            ZERO_PROOF.pA,
            ZERO_PROOF.pB,
            ZERO_PROOF.pC,
            root,
            nullifier,
            out1,
            out2
          )
      ).to.not.be.reverted;
    }

    expect(await pool.totalTransfers()).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // getPoolStats reflects all operation types
  // -------------------------------------------------------------------------

  it("getPoolStats reflects deposit, transfer, and withdrawal operations", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    // Deposit
    const depositAmount = ethers.parseEther("2");
    const c1 = randomCommitment();
    await pool.connect(alice).deposit(c1, { value: depositAmount });

    // Transfer
    const rootAfterDeposit = await pool.getLastRoot();
    const nullifier1 = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();
    await pool
      .connect(alice)
      .transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        rootAfterDeposit,
        nullifier1,
        out1,
        out2
      );

    // Withdraw
    const rootAfterTransfer = await pool.getLastRoot();
    const nullifier2 = randomCommitment();
    const withdrawAmount = ethers.parseEther("1");
    await doWithdraw(
      pool,
      alice,
      rootAfterTransfer,
      nullifier2,
      withdrawAmount,
      bob.address
    );

    const stats = await pool.getPoolStats();
    const [
      _totalDeposited,
      _totalWithdrawn,
      _totalTransfers,
      _depositCount,
      _withdrawalCount,
      _uniqueDepositors,
      _poolBalance,
    ] = stats;

    expect(_totalDeposited).to.equal(depositAmount);
    expect(_totalWithdrawn).to.equal(withdrawAmount);
    expect(_totalTransfers).to.equal(1n);
    expect(_depositCount).to.equal(3n); // 1 deposit + 2 transfer outputs
    expect(_withdrawalCount).to.equal(1n);
    expect(_uniqueDepositors).to.equal(1n);
    expect(_poolBalance).to.equal(depositAmount - withdrawAmount);
  });

  // -------------------------------------------------------------------------
  // getActiveNoteCount after transfer increases by 1 (spends 1, inserts 2)
  // -------------------------------------------------------------------------

  it("transfer increases active note count by 1 (spends 1, inserts 2 outputs)", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const c1 = randomCommitment();
    await pool.connect(alice).deposit(c1, { value: ethers.parseEther("1") });
    const countBefore = await pool.getActiveNoteCount();

    const root = await pool.getLastRoot();
    const nullifier = randomCommitment();
    const out1 = randomCommitment();
    const out2 = randomCommitment();

    await pool
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

    const countAfter = await pool.getActiveNoteCount();
    // Net change: +2 outputs - 1 nullifier = +1
    expect(countAfter).to.equal(countBefore + 1n);
  });

  // -------------------------------------------------------------------------
  // Denomination list — add then remove
  // -------------------------------------------------------------------------

  it("getDenominations reflects additions and removals", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);

    const denom1 = ethers.parseEther("0.1");
    const denom2 = ethers.parseEther("1");

    await timelockAddDenomination(pool, owner, denom1);
    await timelockAddDenomination(pool, owner, denom2);

    let list = await pool.getDenominations();
    expect(list.length).to.equal(2);
    expect(list[0]).to.equal(denom1);
    expect(list[1]).to.equal(denom2);

    // Remove denom1 — it stays in the array but allowedDenominations[denom1] becomes false
    await timelockRemoveDenomination(pool, owner, denom1);

    list = await pool.getDenominations();
    // Array length stays 2 (removal does not splice the array)
    expect(list.length).to.equal(2);
    expect(await pool.allowedDenominations(denom1)).to.be.false;
    expect(await pool.allowedDenominations(denom2)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // emergencyDrain empties the pool completely
  // -------------------------------------------------------------------------

  it("emergencyDrain leaves zero balance in the pool", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    // Fund the pool
    const depositAmount = ethers.parseEther("3");
    const commitment = randomCommitment();
    await pool.connect(alice).deposit(commitment, { value: depositAmount });
    expect(await pool.getPoolBalance()).to.equal(depositAmount);

    // Pause is required before emergencyDrain
    await pool.connect(owner).pause();

    const ownerBefore = await ethers.provider.getBalance(owner.address);

    const tx = await pool.connect(owner).emergencyDrain(owner.address);
    await expect(tx)
      .to.emit(pool, "EmergencyDrain")
      .withArgs(owner.address, depositAmount);

    expect(await pool.getPoolBalance()).to.equal(0n);
  });
});
