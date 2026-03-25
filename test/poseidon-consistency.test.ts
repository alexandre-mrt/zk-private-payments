import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";

// BN254 field size — the prime, not prime - 1.
// hashLeftRight requires inputs strictly less than this value.
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Maximum valid field element (FIELD_SIZE - 1)
const FIELD_MAX = FIELD_SIZE - 1n;

const MERKLE_TREE_HEIGHT = 5;

async function deployFixture() {
  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_TREE_HEIGHT,
    hasherAddress
  );

  return { pool };
}

describe("Poseidon Consistency — zk-private-payments", function () {
  // circomlibjs Poseidon instance, built once for the whole suite
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // Finite-field helper exposed by circomlibjs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  // -------------------------------------------------------------------------
  // Fuzz-style: 20 random input pairs
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    it(`random pair #${i + 1}: on-chain hashLeftRight matches off-chain Poseidon`, async function () {
      const { pool } = await loadFixture(deployFixture);

      // 31 random bytes keep the value well below FIELD_SIZE
      const left = ethers.toBigInt(ethers.randomBytes(31));
      const right = ethers.toBigInt(ethers.randomBytes(31));

      const onChain = await pool.hashLeftRight(left, right);
      const offChain = F.toObject(poseidon([left, right]));

      expect(onChain).to.equal(offChain);
    });
  }

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("hash(0, 0) is consistent", async function () {
    const { pool } = await loadFixture(deployFixture);

    const onChain = await pool.hashLeftRight(0n, 0n);
    const offChain = F.toObject(poseidon([0n, 0n]));

    expect(onChain).to.equal(offChain);
  });

  it("hash(1, 1) is consistent", async function () {
    const { pool } = await loadFixture(deployFixture);

    const onChain = await pool.hashLeftRight(1n, 1n);
    const offChain = F.toObject(poseidon([1n, 1n]));

    expect(onChain).to.equal(offChain);
  });

  it("hash(FIELD_SIZE - 1, 0) is consistent", async function () {
    const { pool } = await loadFixture(deployFixture);

    const onChain = await pool.hashLeftRight(FIELD_MAX, 0n);
    const offChain = F.toObject(poseidon([FIELD_MAX, 0n]));

    expect(onChain).to.equal(offChain);
  });

  it("hash(0, FIELD_SIZE - 1) is consistent", async function () {
    const { pool } = await loadFixture(deployFixture);

    const onChain = await pool.hashLeftRight(0n, FIELD_MAX);
    const offChain = F.toObject(poseidon([0n, FIELD_MAX]));

    expect(onChain).to.equal(offChain);
  });

  it("hash(FIELD_SIZE - 1, FIELD_SIZE - 1) is consistent", async function () {
    const { pool } = await loadFixture(deployFixture);

    const onChain = await pool.hashLeftRight(FIELD_MAX, FIELD_MAX);
    const offChain = F.toObject(poseidon([FIELD_MAX, FIELD_MAX]));

    expect(onChain).to.equal(offChain);
  });

  it("hash is not commutative: hash(a, b) != hash(b, a) for distinct a, b", async function () {
    const { pool } = await loadFixture(deployFixture);

    const a = ethers.toBigInt(ethers.randomBytes(31)) + 1n;
    const b = a + 1n;

    const ab = await pool.hashLeftRight(a, b);
    const ba = await pool.hashLeftRight(b, a);

    expect(ab).to.not.equal(ba);
  });
});
