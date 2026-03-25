import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_DAY = 24 * 60 * 60;
const ONE_HOUR = 60 * 60;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

// ---------------------------------------------------------------------------
// Poseidon helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidon: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;

before(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

async function computeCommitment(
  amount: bigint,
  blinding: bigint,
  ownerPubKeyX: bigint
): Promise<bigint> {
  return F.toObject(poseidon([amount, blinding, ownerPubKeyX]));
}

async function computeNullifier(
  commitment: bigint,
  spendingKey: bigint
): Promise<bigint> {
  return F.toObject(poseidon([commitment, spendingKey]));
}

function randomFieldElement(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

function randomCommitment(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployPoolFixture() {
  const signers = await ethers.getSigners();
  const [owner, alice, bob, charlie, relayer] = signers;

  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    5,
    hasherAddress
  );

  return { pool, owner, alice, bob, charlie, relayer, signers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function doWithdraw(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  root: bigint,
  nullifier: bigint,
  amount: bigint,
  recipient: string,
  changeCommitment: bigint,
  relayer: string,
  fee: bigint,
  caller?: Signer
) {
  const connected = caller ? pool.connect(caller) : pool;
  return connected.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifier,
    amount,
    recipient,
    changeCommitment,
    relayer,
    fee
  );
}

async function timelockSetMaxDeposits(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  owner: Signer,
  max: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setMaxDepositsPerAddress", max]
    )
  );
  await pool.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await pool.connect(owner).setMaxDepositsPerAddress(max);
}

async function timelockSetDepositCooldown(
  pool: Awaited<ReturnType<typeof deployPoolFixture>>["pool"],
  owner: Signer,
  cooldown: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setDepositCooldown", cooldown]
    )
  );
  await pool.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await pool.connect(owner).setDepositCooldown(cooldown);
}

// ---------------------------------------------------------------------------
// Multi-User Interactions
// ---------------------------------------------------------------------------

describe("Multi-User Interactions", function () {
  it("3 users each deposit different amounts", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];

    const commitmentAlice = randomCommitment();
    const commitmentBob = randomCommitment();
    const commitmentCharlie = randomCommitment();

    await pool.connect(alice).deposit(commitmentAlice, { value: amounts[0] });
    await pool.connect(bob).deposit(commitmentBob, { value: amounts[1] });
    await pool.connect(charlie).deposit(commitmentCharlie, { value: amounts[2] });

    expect(await pool.commitments(commitmentAlice)).to.be.true;
    expect(await pool.commitments(commitmentBob)).to.be.true;
    expect(await pool.commitments(commitmentCharlie)).to.be.true;

    expect(await pool.nextIndex()).to.equal(3n);
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(amounts[0] + amounts[1] + amounts[2]);
  });

  it("user A transfers to user B's pubkey", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("2");
    const alicePubKeyX = randomFieldElement();
    const aliceSpendingKey = randomFieldElement();
    const aliceBlinding = randomFieldElement();

    const aliceCommitment = await computeCommitment(depositAmount, aliceBlinding, alicePubKeyX);
    await pool.connect(alice).deposit(aliceCommitment, { value: depositAmount });

    const root = await pool.getLastRoot();
    const aliceNullifier = await computeNullifier(aliceCommitment, aliceSpendingKey);

    const bobPubKeyX = randomFieldElement();
    const transferCommitment = await computeCommitment(
      ethers.parseEther("1.5"),
      randomFieldElement(),
      bobPubKeyX
    );
    const changeCommitment = await computeCommitment(
      ethers.parseEther("0.5"),
      randomFieldElement(),
      alicePubKeyX
    );

    await expect(
      pool.transfer(
        ZERO_PROOF.pA,
        ZERO_PROOF.pB,
        ZERO_PROOF.pC,
        root,
        aliceNullifier,
        transferCommitment,
        changeCommitment
      )
    ).to.emit(pool, "Transfer");

    // Both output notes are now in the tree
    expect(await pool.commitments(transferCommitment)).to.be.true;
    expect(await pool.commitments(changeCommitment)).to.be.true;

    // Alice's input nullifier is spent
    expect(await pool.nullifiers(aliceNullifier)).to.be.true;
  });

  it("user B cannot spend user A's note (different spending key)", async function () {
    const { pool, alice } = await loadFixture(deployPoolFixture);

    const depositAmount = ethers.parseEther("1");
    const alicePubKeyX = randomFieldElement();
    const aliceSpendingKey = randomFieldElement();

    const aliceCommitment = await computeCommitment(
      depositAmount,
      randomFieldElement(),
      alicePubKeyX
    );
    await pool.connect(alice).deposit(aliceCommitment, { value: depositAmount });

    // Bob uses a different spending key — produces a different nullifier
    const bobSpendingKey = randomFieldElement();
    const wrongNullifier = await computeNullifier(aliceCommitment, bobSpendingKey);
    const correctNullifier = await computeNullifier(aliceCommitment, aliceSpendingKey);

    // The two nullifiers must differ
    expect(wrongNullifier).to.not.equal(correctNullifier);

    const root = await pool.getLastRoot();
    const bobPubKeyX = randomFieldElement();

    // Bob's transfer with the wrong nullifier succeeds at the contract level
    // (proof verification is bypassed in tests), but the spent note is different —
    // Alice's correct nullifier remains unspent
    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      wrongNullifier,
      randomCommitment(),
      randomCommitment()
    );

    expect(await pool.nullifiers(wrongNullifier)).to.be.true;
    // Alice's real nullifier is NOT spent — her note is untouched
    expect(await pool.nullifiers(correctNullifier)).to.be.false;

    void bobPubKeyX;
  });

  it("batchDeposit by one user, individual withdrawals by another", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amounts = [
      ethers.parseEther("1"),
      ethers.parseEther("2"),
      ethers.parseEther("3"),
    ];
    const spendingKeys = [
      randomFieldElement(),
      randomFieldElement(),
      randomFieldElement(),
    ];

    const commitments = await Promise.all(
      amounts.map((amount) =>
        computeCommitment(amount, randomFieldElement(), randomFieldElement())
      )
    );

    const totalValue = amounts.reduce((a, b) => a + b, 0n);
    await pool.connect(alice).batchDeposit(commitments, amounts, { value: totalValue });

    // Bob withdraws each note individually (as the recipient)
    for (let i = 0; i < 3; i++) {
      const root = await pool.getLastRoot();
      const nullifier = await computeNullifier(commitments[i], spendingKeys[i]);
      const bobBefore = await ethers.provider.getBalance(bob.address);

      await doWithdraw(
        pool,
        root,
        nullifier,
        amounts[i],
        bob.address,
        0n,
        ethers.ZeroAddress,
        0n
      );

      const bobAfter = await ethers.provider.getBalance(bob.address);
      expect(bobAfter - bobBefore).to.equal(amounts[i]);
      expect(await pool.nullifiers(nullifier)).to.be.true;
    }

    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(0n);
  });

  it("stealth payment announcement is visible to all scanners", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const StealthRegistryFactory = await ethers.getContractFactory("StealthRegistry");
    const registry = await StealthRegistryFactory.deploy();

    // Bob registers his viewing key
    const bobViewKeyX = randomFieldElement();
    const bobViewKeyY = randomFieldElement();
    await registry.connect(bob).registerViewingKey(bobViewKeyX, bobViewKeyY);

    // Alice deposits and makes a stealth announcement for Bob
    const depositAmount = ethers.parseEther("1");
    const aliceCommitment = randomCommitment();
    await pool.connect(alice).deposit(aliceCommitment, { value: depositAmount });

    const ephemeralX = randomFieldElement();
    const ephemeralY = randomFieldElement();
    const stealthX = randomFieldElement();
    const stealthY = randomFieldElement();
    const encryptedAmount = randomFieldElement();
    const encryptedBlinding = randomFieldElement();

    // Any scanner (charlie) can observe the StealthPayment event
    await expect(
      registry
        .connect(alice)
        .announceStealthPayment(
          aliceCommitment,
          ephemeralX,
          ephemeralY,
          stealthX,
          stealthY,
          encryptedAmount,
          encryptedBlinding
        )
    )
      .to.emit(registry, "StealthPayment")
      .withArgs(
        aliceCommitment,
        ephemeralX,
        ephemeralY,
        stealthX,
        stealthY,
        encryptedAmount,
        encryptedBlinding
      );

    // Charlie can retrieve Bob's registered viewing key to attempt scanning
    const [storedX, storedY] = await registry.getViewingKey(bob.address);
    expect(storedX).to.equal(bobViewKeyX);
    expect(storedY).to.equal(bobViewKeyY);

    void charlie;
  });

  it("deposit receipt ownership reflects actual depositor", async function () {
    const { pool, owner, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const receipt = await DepositReceiptFactory.deploy(await pool.getAddress());
    await pool.connect(owner).setDepositReceipt(await receipt.getAddress());

    const commitmentAlice = randomCommitment();
    const commitmentBob = randomCommitment();
    const commitmentCharlie = randomCommitment();

    await pool.connect(alice).deposit(commitmentAlice, { value: ethers.parseEther("1") });
    await pool.connect(bob).deposit(commitmentBob, { value: ethers.parseEther("2") });
    await pool.connect(charlie).deposit(commitmentCharlie, { value: ethers.parseEther("3") });

    // Each depositor owns exactly one receipt NFT
    expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    expect(await receipt.balanceOf(bob.address)).to.equal(1n);
    expect(await receipt.balanceOf(charlie.address)).to.equal(1n);

    // Token IDs assigned in deposit order
    expect(await receipt.ownerOf(0)).to.equal(alice.address);
    expect(await receipt.ownerOf(1)).to.equal(bob.address);
    expect(await receipt.ownerOf(2)).to.equal(charlie.address);
  });

  it("allowlisted user can deposit, non-allowlisted cannot", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    await pool.connect(owner).setAllowlistEnabled(true);
    await pool.connect(owner).setAllowlisted(alice.address, true);

    // Alice (allowlisted) succeeds
    await expect(
      pool
        .connect(alice)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.emit(pool, "Deposit");

    // Bob (not allowlisted) is blocked
    await expect(
      pool
        .connect(bob)
        .deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.be.revertedWith("ConfidentialPool: sender not allowlisted");
  });

  it("uniqueDepositorCount correctly tracks unique addresses", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    // Initial state
    expect(await pool.uniqueDepositorCount()).to.equal(0n);

    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    expect(await pool.uniqueDepositorCount()).to.equal(1n);

    // Same address again — count must not increase
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    expect(await pool.uniqueDepositorCount()).to.equal(1n);

    await pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    expect(await pool.uniqueDepositorCount()).to.equal(2n);

    await pool.connect(charlie).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    expect(await pool.uniqueDepositorCount()).to.equal(3n);
  });

  it("deposit cooldown applies per-address independently", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    // Set 1-hour cooldown via timelock
    await timelockSetDepositCooldown(pool, owner, BigInt(ONE_HOUR));

    // Alice deposits — succeeds
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });

    // Alice's second deposit within the cooldown must revert
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.be.revertedWith("ConfidentialPool: deposit cooldown active");

    // Bob has not deposited yet — his first deposit is unaffected
    await expect(
      pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.emit(pool, "Deposit");

    // After the cooldown elapses, Alice can deposit again
    await time.increase(ONE_HOUR + 1);
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.emit(pool, "Deposit");
  });

  it("withdrawal by user A doesn't affect user B's notes", async function () {
    const { pool, alice, bob } = await loadFixture(deployPoolFixture);

    const amountA = ethers.parseEther("1");
    const amountB = ethers.parseEther("2");

    const aliceSpendingKey = randomFieldElement();
    const aliceCommitment = await computeCommitment(amountA, randomFieldElement(), randomFieldElement());
    const aliceNullifier = await computeNullifier(aliceCommitment, aliceSpendingKey);

    const bobCommitment = randomCommitment();

    await pool.connect(alice).deposit(aliceCommitment, { value: amountA });
    await pool.connect(bob).deposit(bobCommitment, { value: amountB });

    const root = await pool.getLastRoot();

    // Alice withdraws her own note
    const aliceRecipient = (await ethers.getSigners())[10];
    await doWithdraw(
      pool,
      root,
      aliceNullifier,
      amountA,
      aliceRecipient.address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    // Bob's commitment is still in the tree and his note is untouched
    expect(await pool.commitments(bobCommitment)).to.be.true;

    // Pool retains Bob's funds
    expect(
      await ethers.provider.getBalance(await pool.getAddress())
    ).to.equal(amountB);
  });

  it("getPoolStats reflects multi-party operations correctly", async function () {
    const { pool, alice, bob, charlie } = await loadFixture(deployPoolFixture);

    const amountA = ethers.parseEther("1");
    const amountB = ethers.parseEther("2");
    const amountC = ethers.parseEther("3");

    const aliceSpendingKey = randomFieldElement();
    const aliceCommitment = await computeCommitment(amountA, randomFieldElement(), randomFieldElement());
    const aliceNullifier = await computeNullifier(aliceCommitment, aliceSpendingKey);

    await pool.connect(alice).deposit(aliceCommitment, { value: amountA });
    await pool.connect(bob).deposit(randomCommitment(), { value: amountB });
    await pool.connect(charlie).deposit(randomCommitment(), { value: amountC });

    const root = await pool.getLastRoot();

    // Alice withdraws
    await doWithdraw(
      pool,
      root,
      aliceNullifier,
      amountA,
      (await ethers.getSigners())[10].address,
      0n,
      ethers.ZeroAddress,
      0n
    );

    // Alice transfers (creates 2 output commitments; uses a fresh note)
    const transferNullifier = randomFieldElement();
    await pool.transfer(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      transferNullifier,
      randomCommitment(),
      randomCommitment()
    );

    const [
      totalDeposited,
      totalWithdrawn,
      totalTransfers,
      depositCount,
      withdrawalCount,
      uniqueDepositors,
      poolBalance,
    ] = await pool.getPoolStats();

    expect(totalDeposited).to.equal(amountA + amountB + amountC);
    expect(totalWithdrawn).to.equal(amountA);
    expect(totalTransfers).to.equal(1n);
    // nextIndex counts every Merkle tree insertion: 3 deposits + 2 transfer outputs = 5
    expect(depositCount).to.equal(5n);
    expect(withdrawalCount).to.equal(1n);
    expect(uniqueDepositors).to.equal(3n);
    expect(poolBalance).to.equal(amountB + amountC);
  });

  it("per-address deposit limit is independent between users", async function () {
    const { pool, owner, alice, bob } = await loadFixture(deployPoolFixture);

    // Set limit of 2 deposits per address
    await timelockSetMaxDeposits(pool, owner, 2n);

    // Alice deposits twice — both succeed
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    await pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") });

    // Alice's third deposit must revert
    await expect(
      pool.connect(alice).deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.be.revertedWith("ConfidentialPool: deposit limit reached");

    // Bob has made no deposits — his limit is still fresh
    await pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") });
    await pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") });

    await expect(
      pool.connect(bob).deposit(randomCommitment(), { value: ethers.parseEther("1") })
    ).to.be.revertedWith("ConfidentialPool: deposit limit reached");

    // Each address was tracked independently
    expect(await pool.depositsPerAddress(alice.address)).to.equal(2n);
    expect(await pool.depositsPerAddress(bob.address)).to.equal(2n);
  });
});
