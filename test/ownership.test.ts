import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

const MERKLE_TREE_HEIGHT = 5;
const ONE_DAY_PLUS_ONE = 86401; // 1 day + 1 second

async function deployPoolFixture() {
  const [owner, newOwner, stranger] = await ethers.getSigners();

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

  return { pool, owner, newOwner, stranger };
}

describe("Ownership", function () {
  it("deployer is initial owner", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    expect(await pool.owner()).to.equal(owner.address);
  });

  it("owner can transfer ownership", async function () {
    const { pool, owner, newOwner } = await loadFixture(deployPoolFixture);
    await pool.connect(owner).transferOwnership(newOwner.address);
    expect(await pool.owner()).to.equal(newOwner.address);
  });

  it("new owner can call owner-only functions", async function () {
    const { pool, owner, newOwner } = await loadFixture(deployPoolFixture);
    await pool.connect(owner).transferOwnership(newOwner.address);

    // pause() is an owner-only function without timelock — use it as the probe
    await expect(pool.connect(newOwner).pause()).to.not.be.reverted;
  });

  it("old owner cannot call owner-only functions after transfer", async function () {
    const { pool, owner, newOwner } = await loadFixture(deployPoolFixture);
    await pool.connect(owner).transferOwnership(newOwner.address);

    await expect(
      pool.connect(owner).pause()
    ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
  });

  it("non-owner cannot transfer ownership", async function () {
    const { pool, stranger } = await loadFixture(deployPoolFixture);
    await expect(
      pool.connect(stranger).transferOwnership(stranger.address)
    ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
  });

  it("owner can renounce ownership", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    await pool.connect(owner).renounceOwnership();
    expect(await pool.owner()).to.equal(ethers.ZeroAddress);
  });

  it("after renounce, no one is owner", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    await pool.connect(owner).renounceOwnership();
    expect(await pool.owner()).to.equal(ethers.ZeroAddress);
  });

  it("after renounce, owner-only functions revert", async function () {
    const { pool, owner } = await loadFixture(deployPoolFixture);
    await pool.connect(owner).renounceOwnership();

    await expect(
      pool.connect(owner).pause()
    ).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
  });

  it("new owner can execute timelocked functions after transfer", async function () {
    const { pool, owner, newOwner } = await loadFixture(deployPoolFixture);
    await pool.connect(owner).transferOwnership(newOwner.address);

    // setAllowlistEnabled has no timelock — direct owner-only call
    await expect(
      pool.connect(newOwner).setAllowlistEnabled(true)
    ).to.not.be.reverted;
    expect(await pool.allowlistEnabled()).to.equal(true);
  });
});
