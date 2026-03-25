import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// Mirror the library values here so the test can assert on-chain vs off-chain agreement
const POOL_FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const POOL_ROOT_HISTORY_SIZE = 30n;

async function deployPoolFixture() {
  const hasherAddress = await deployHasher();

  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();

  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();

  const Pool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await Pool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    20,
    hasherAddress
  );

  return { pool };
}

describe("PoolConstants", function () {
  it("FIELD_SIZE constant matches MerkleTree", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    expect(await pool.FIELD_SIZE()).to.equal(POOL_FIELD_SIZE);
  });

  it("ROOT_HISTORY_SIZE constant matches MerkleTree", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    expect(await pool.ROOT_HISTORY_SIZE()).to.equal(POOL_ROOT_HISTORY_SIZE);
  });

  it("VERSION constant returns '1.0.0'", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    expect(await pool.VERSION()).to.equal("1.0.0");
  });

  it("getVersion() returns '1.0.0'", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    expect(await pool.getVersion()).to.equal("1.0.0");
  });

  it("VERSION is constant — same value on repeated calls", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    const first = await pool.VERSION();
    const second = await pool.VERSION();
    expect(first).to.equal(second);
  });
});
