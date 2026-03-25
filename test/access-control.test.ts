import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

const MERKLE_TREE_HEIGHT = 5;
const ONE_DAY = 24 * 60 * 60;

async function deployFixture() {
  const [owner, alice] = await ethers.getSigners();
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

  return { pool, owner, alice };
}

/** Compute a timelocked action hash: keccak256(abi.encode(name, uint256)). */
function makeActionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

/** Queue an action as owner, then advance time past the timelock. */
async function queueAndWait(
  pool: Awaited<ReturnType<typeof deployFixture>>["pool"],
  hash: string
): Promise<void> {
  await pool.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Access Control Matrix
// ---------------------------------------------------------------------------

describe("Access Control Matrix — ConfidentialPool", function () {
  type Pool = Awaited<ReturnType<typeof deployFixture>>["pool"];
  type Signer = Awaited<ReturnType<typeof ethers.getSigner>>;

  // Each entry names an owner-only function and provides a call that a
  // non-owner (alice) should not be able to make.
  const ownerOnlyFunctions: Array<{
    name: string;
    call: (pool: Pool, stranger: Signer) => Promise<unknown>;
  }> = [
    {
      name: "pause",
      call: (pool, stranger) => pool.connect(stranger).pause(),
    },
    {
      name: "unpause",
      call: async (pool, stranger) => {
        await pool.pause(); // owner pauses first
        return pool.connect(stranger).unpause();
      },
    },
    {
      name: "queueAction",
      call: (pool, stranger) =>
        pool.connect(stranger).queueAction(ethers.ZeroHash),
    },
    {
      name: "cancelAction",
      call: async (pool, stranger) => {
        // queue a non-zero hash so cancelAction sees a valid pending action
        const nonZeroHash = ethers.keccak256(ethers.toUtf8Bytes("test-action"));
        await pool.queueAction(nonZeroHash);
        return pool.connect(stranger).cancelAction();
      },
    },
    {
      name: "setAllowlistEnabled",
      call: (pool, stranger) =>
        pool.connect(stranger).setAllowlistEnabled(true),
    },
    {
      name: "setAllowlisted",
      call: (pool, stranger) =>
        pool.connect(stranger).setAllowlisted(stranger.address, true),
    },
    {
      name: "batchSetAllowlisted",
      call: (pool, stranger) =>
        pool.connect(stranger).batchSetAllowlisted([stranger.address], true),
    },
    {
      name: "emergencyDrain",
      call: async (pool, stranger) => {
        await pool.pause(); // emergencyDrain requires whenPaused — owner pauses
        return pool
          .connect(stranger)
          .emergencyDrain(await stranger.getAddress() as unknown as string);
      },
    },
    {
      name: "setMaxDepositsPerAddress (timelocked)",
      call: (pool, stranger) =>
        pool.connect(stranger).setMaxDepositsPerAddress(5n),
    },
    {
      name: "setMaxWithdrawAmount (timelocked)",
      call: (pool, stranger) =>
        pool.connect(stranger).setMaxWithdrawAmount(ethers.parseEther("1")),
    },
    {
      name: "setMinDepositAge (timelocked)",
      call: (pool, stranger) =>
        pool.connect(stranger).setMinDepositAge(10n),
    },
    {
      name: "addDenomination (timelocked)",
      call: (pool, stranger) =>
        pool
          .connect(stranger)
          .addDenomination(ethers.parseEther("0.1")),
    },
    {
      name: "removeDenomination (timelocked)",
      call: (pool, stranger) =>
        pool
          .connect(stranger)
          .removeDenomination(ethers.parseEther("0.1")),
    },
  ];

  for (const fn of ownerOnlyFunctions) {
    it(`${fn.name} reverts with OwnableUnauthorizedAccount for non-owner`, async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      await expect(fn.call(pool, alice)).to.be.revertedWithCustomError(
        pool,
        "OwnableUnauthorizedAccount"
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Positive: owner can call every admin function without revert
  // ---------------------------------------------------------------------------

  it("owner can call pause and unpause", async function () {
    const { pool } = await loadFixture(deployFixture);
    await expect(pool.pause()).to.not.be.reverted;
    await expect(pool.unpause()).to.not.be.reverted;
  });

  it("owner can queueAction and cancelAction", async function () {
    const { pool } = await loadFixture(deployFixture);
    const nonZeroHash = makeActionHash("setMaxDepositsPerAddress", 1n);
    await expect(pool.queueAction(nonZeroHash)).to.not.be.reverted;
    await expect(pool.cancelAction()).to.not.be.reverted;
  });

  it("owner can enable and disable the allowlist", async function () {
    const { pool } = await loadFixture(deployFixture);
    await expect(pool.setAllowlistEnabled(true)).to.not.be.reverted;
    await expect(pool.setAllowlistEnabled(false)).to.not.be.reverted;
  });

  it("owner can set and revoke individual allowlist entry", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await expect(pool.setAllowlisted(alice.address, true)).to.not.be.reverted;
    await expect(pool.setAllowlisted(alice.address, false)).to.not.be.reverted;
  });

  it("owner can batch set allowlist entries", async function () {
    const { pool, alice } = await loadFixture(deployFixture);
    await expect(
      pool.batchSetAllowlisted([alice.address], true)
    ).to.not.be.reverted;
  });

  it("owner can execute setMaxDepositsPerAddress after timelock", async function () {
    const { pool } = await loadFixture(deployFixture);
    const hash = makeActionHash("setMaxDepositsPerAddress", 10n);
    await queueAndWait(pool, hash);
    await expect(pool.setMaxDepositsPerAddress(10n)).to.not.be.reverted;
  });

  it("owner can execute setMaxWithdrawAmount after timelock", async function () {
    const { pool } = await loadFixture(deployFixture);
    const cap = ethers.parseEther("1");
    const hash = makeActionHash("setMaxWithdrawAmount", cap);
    await queueAndWait(pool, hash);
    await expect(pool.setMaxWithdrawAmount(cap)).to.not.be.reverted;
  });

  it("owner can execute setMinDepositAge after timelock", async function () {
    const { pool } = await loadFixture(deployFixture);
    const hash = makeActionHash("setMinDepositAge", 100n);
    await queueAndWait(pool, hash);
    await expect(pool.setMinDepositAge(100n)).to.not.be.reverted;
  });

  it("owner can execute addDenomination after timelock", async function () {
    const { pool } = await loadFixture(deployFixture);
    const denom = ethers.parseEther("0.1");
    const hash = makeActionHash("addDenomination", denom);
    await queueAndWait(pool, hash);
    await expect(pool.addDenomination(denom)).to.not.be.reverted;
  });

  it("owner can execute removeDenomination after timelock (requires prior add)", async function () {
    const { pool } = await loadFixture(deployFixture);
    const denom = ethers.parseEther("0.1");

    // add first
    const addHash = makeActionHash("addDenomination", denom);
    await queueAndWait(pool, addHash);
    await pool.addDenomination(denom);

    // then remove
    const removeHash = makeActionHash("removeDenomination", denom);
    await queueAndWait(pool, removeHash);
    await expect(pool.removeDenomination(denom)).to.not.be.reverted;
  });

  it("owner can emergencyDrain when paused", async function () {
    const { pool, owner } = await loadFixture(deployFixture);
    await pool.pause();
    // Pool has no ETH balance — emergencyDrain will revert on "no balance to drain",
    // not on access control. That is the correct outcome: access was granted.
    await expect(
      pool.emergencyDrain(owner.address)
    ).to.be.revertedWith("ConfidentialPool: no balance to drain");
  });
});
