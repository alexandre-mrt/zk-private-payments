import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { ConfidentialPool } from "../typechain-types/contracts/ConfidentialPool.sol";

// BN254 field size prime. All valid inputs must be strictly less than this value.
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const MERKLE_TREE_HEIGHT = 5;

async function deployFixture(): Promise<{ pool: ConfidentialPool }> {
  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = (await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as ConfidentialPool;

  return { pool };
}

describe("ConfidentialPool.verifyHash", function () {
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  // ---------------------------------------------------------------------------
  // Returns correct hash
  // ---------------------------------------------------------------------------

  it("returns the Poseidon hash of two field elements", async function () {
    const { pool } = await loadFixture(deployFixture);

    const a = ethers.toBigInt(ethers.randomBytes(31));
    const b = ethers.toBigInt(ethers.randomBytes(31));

    const result = await pool.verifyHash(a, b);

    expect(typeof result).to.equal("bigint");
    expect(result).to.be.greaterThan(0n);
    expect(result).to.be.lessThan(FIELD_SIZE);
  });

  // ---------------------------------------------------------------------------
  // Matches off-chain Poseidon
  // ---------------------------------------------------------------------------

  it("matches the off-chain circomlibjs Poseidon(a, b)", async function () {
    const { pool } = await loadFixture(deployFixture);

    const a = ethers.toBigInt(ethers.randomBytes(31));
    const b = ethers.toBigInt(ethers.randomBytes(31));

    const onChain = await pool.verifyHash(a, b);
    const offChain = F.toObject(poseidon([a, b]));

    expect(onChain).to.equal(offChain);
  });

  // ---------------------------------------------------------------------------
  // Deterministic
  // ---------------------------------------------------------------------------

  it("is deterministic — same inputs always return the same hash", async function () {
    const { pool } = await loadFixture(deployFixture);

    const a = 12345678901234567890n;
    const b = 98765432109876543210n;

    const first = await pool.verifyHash(a, b);
    const second = await pool.verifyHash(a, b);

    expect(first).to.equal(second);
  });

  // ---------------------------------------------------------------------------
  // Additional consistency checks
  // ---------------------------------------------------------------------------

  it("is consistent with hashLeftRight(a, b)", async function () {
    const { pool } = await loadFixture(deployFixture);

    const a = ethers.toBigInt(ethers.randomBytes(31));
    const b = ethers.toBigInt(ethers.randomBytes(31));

    const fromVerify = await pool.verifyHash(a, b);
    const fromHash = await pool.hashLeftRight(a, b);

    expect(fromVerify).to.equal(fromHash);
  });

  it("is not commutative — verifyHash(a, b) != verifyHash(b, a) for distinct inputs", async function () {
    const { pool } = await loadFixture(deployFixture);

    const a = ethers.toBigInt(ethers.randomBytes(31)) + 1n;
    const b = a + 1n;

    const ab = await pool.verifyHash(a, b);
    const ba = await pool.verifyHash(b, a);

    expect(ab).to.not.equal(ba);
  });

  it("reverts when first input >= FIELD_SIZE", async function () {
    const { pool } = await loadFixture(deployFixture);

    await expect(pool.verifyHash(FIELD_SIZE, 1n)).to.be.revertedWith(
      "MerkleTree: left overflow"
    );
  });

  it("reverts when second input >= FIELD_SIZE", async function () {
    const { pool } = await loadFixture(deployFixture);

    await expect(pool.verifyHash(1n, FIELD_SIZE)).to.be.revertedWith(
      "MerkleTree: right overflow"
    );
  });
});
