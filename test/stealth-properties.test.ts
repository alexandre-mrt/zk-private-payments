import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPECTED_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployStealthRegistryFixture() {
  const signers = await ethers.getSigners();
  const [owner, alice, bob, charlie, dave, eve] = signers;
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();
  return { registry, owner, alice, bob, charlie, dave, eve };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomKey(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// StealthRegistry Properties
// ---------------------------------------------------------------------------

describe("StealthRegistry Properties", function () {
  // -------------------------------------------------------------------------
  // Viewing key storage
  // -------------------------------------------------------------------------

  it("viewing key is stored per address", async function () {
    const { registry, alice } = await loadFixture(deployStealthRegistryFixture);
    const x = randomKey();
    const y = randomKey();

    await registry.connect(alice).registerViewingKey(x, y);

    const [storedX, storedY] = await registry.getViewingKey(alice.address);
    expect(storedX).to.equal(x);
    expect(storedY).to.equal(y);
  });

  it("unregistered address returns (0, 0)", async function () {
    const { registry, charlie } = await loadFixture(deployStealthRegistryFixture);

    const [x, y] = await registry.getViewingKey(charlie.address);
    expect(x).to.equal(0n);
    expect(y).to.equal(0n);
  });

  it("registering overwrites previous key", async function () {
    const { registry, alice } = await loadFixture(deployStealthRegistryFixture);

    const x1 = randomKey();
    const y1 = randomKey();
    await registry.connect(alice).registerViewingKey(x1, y1);

    const x2 = randomKey();
    const y2 = randomKey();
    await registry.connect(alice).registerViewingKey(x2, y2);

    const [storedX, storedY] = await registry.getViewingKey(alice.address);
    expect(storedX).to.equal(x2);
    expect(storedY).to.equal(y2);
  });

  it("one user's key doesn't affect another user's key", async function () {
    const { registry, alice, bob } = await loadFixture(deployStealthRegistryFixture);

    const aliceX = randomKey();
    const aliceY = randomKey();
    const bobX = randomKey();
    const bobY = randomKey();

    await registry.connect(alice).registerViewingKey(aliceX, aliceY);
    await registry.connect(bob).registerViewingKey(bobX, bobY);

    // Update alice's key
    await registry.connect(alice).registerViewingKey(randomKey(), randomKey());

    // Bob's key must be unchanged
    const [storedBX, storedBY] = await registry.getViewingKey(bob.address);
    expect(storedBX).to.equal(bobX);
    expect(storedBY).to.equal(bobY);
  });

  it("zero key (0, 0) reverts on register", async function () {
    const { registry, alice } = await loadFixture(deployStealthRegistryFixture);

    await expect(
      registry.connect(alice).registerViewingKey(0n, 0n)
    ).to.be.revertedWith("StealthRegistry: zero key");
  });

  it("partial zero key (x=0, y!=0) is allowed", async function () {
    const { registry, alice } = await loadFixture(deployStealthRegistryFixture);

    const y = randomKey();
    await registry.connect(alice).registerViewingKey(0n, y);

    const [storedX, storedY] = await registry.getViewingKey(alice.address);
    expect(storedX).to.equal(0n);
    expect(storedY).to.equal(y);
  });

  it("key persists across multiple blocks", async function () {
    const { registry, alice } = await loadFixture(deployStealthRegistryFixture);

    const x = randomKey();
    const y = randomKey();
    await registry.connect(alice).registerViewingKey(x, y);

    // Mine several blocks to simulate time passing
    await mine(10);

    const [storedX, storedY] = await registry.getViewingKey(alice.address);
    expect(storedX).to.equal(x);
    expect(storedY).to.equal(y);
  });

  // -------------------------------------------------------------------------
  // Stealth payment announcements
  // -------------------------------------------------------------------------

  it("anyone can announce a stealth payment", async function () {
    const { registry, bob } = await loadFixture(deployStealthRegistryFixture);

    // Bob has no registered viewing key — announce must still succeed
    await expect(
      registry
        .connect(bob)
        .announceStealthPayment(
          randomKey(),
          randomKey(),
          randomKey(),
          randomKey(),
          randomKey(),
          randomKey(),
          randomKey()
        )
    ).to.not.be.reverted;
  });

  it("announcement preserves all 7 fields (with encrypted data)", async function () {
    const { registry, alice } = await loadFixture(deployStealthRegistryFixture);

    const commitment = randomKey();
    const ephX = randomKey();
    const ephY = randomKey();
    const stealthX = randomKey();
    const stealthY = randomKey();
    const encAmt = randomKey();
    const encBlind = randomKey();

    await expect(
      registry
        .connect(alice)
        .announceStealthPayment(commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlind)
    )
      .to.emit(registry, "StealthPayment")
      .withArgs(commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlind);
  });

  it("commitment field is indexed for efficient filtering", async function () {
    const { registry, alice } = await loadFixture(deployStealthRegistryFixture);

    const commitment = randomKey();

    const tx = await registry
      .connect(alice)
      .announceStealthPayment(
        commitment,
        randomKey(),
        randomKey(),
        randomKey(),
        randomKey(),
        randomKey(),
        randomKey()
      );
    const receipt = await tx.wait();
    expect(receipt).to.not.be.null;

    // The StealthPayment event must be present and the first topic must be the
    // event selector (not the commitment), with the commitment as the second topic
    // because it is declared as `indexed`.
    const iface = registry.interface;
    const eventFragment = iface.getEvent("StealthPayment");
    // ethers v6: topic hash lives on the EventFragment itself
    const eventTopic = eventFragment.topicHash;

    const stealthLog = receipt!.logs.find(
      (log) => log.topics[0] === eventTopic
    );
    expect(stealthLog, "StealthPayment log not found").to.not.be.undefined;

    // topics[1] is the first indexed parameter — commitment — encoded as a bytes32
    const encodedCommitment = ethers.zeroPadValue(ethers.toBeHex(commitment), 32);
    expect(stealthLog!.topics[1]).to.equal(encodedCommitment);
  });

  it("multiple announcements are independent", async function () {
    const { registry, alice, bob } = await loadFixture(deployStealthRegistryFixture);

    const c1 = randomKey();
    const ephX1 = randomKey();
    const c2 = randomKey();
    const ephX2 = randomKey();

    await expect(
      registry.connect(alice).announceStealthPayment(
        c1, ephX1, randomKey(), randomKey(), randomKey(), randomKey(), randomKey()
      )
    )
      .to.emit(registry, "StealthPayment")
      .withArgs(c1, ephX1, (v: bigint) => typeof v === "bigint", (v: bigint) => typeof v === "bigint", (v: bigint) => typeof v === "bigint", (v: bigint) => typeof v === "bigint", (v: bigint) => typeof v === "bigint");

    await expect(
      registry.connect(bob).announceStealthPayment(
        c2, ephX2, randomKey(), randomKey(), randomKey(), randomKey(), randomKey()
      )
    )
      .to.emit(registry, "StealthPayment")
      .withArgs(c2, ephX2, (v: bigint) => typeof v === "bigint", (v: bigint) => typeof v === "bigint", (v: bigint) => typeof v === "bigint", (v: bigint) => typeof v === "bigint", (v: bigint) => typeof v === "bigint");
  });

  it("announcement doesn't require caller to have a viewing key", async function () {
    const { registry, charlie } = await loadFixture(deployStealthRegistryFixture);

    // charlie never calls registerViewingKey — getViewingKey still returns (0, 0)
    const [cx, cy] = await registry.getViewingKey(charlie.address);
    expect(cx).to.equal(0n);
    expect(cy).to.equal(0n);

    // Announcement must succeed regardless
    await expect(
      registry.connect(charlie).announceStealthPayment(
        randomKey(),
        randomKey(),
        randomKey(),
        randomKey(),
        randomKey(),
        randomKey(),
        randomKey()
      )
    ).to.not.be.reverted;
  });

  // -------------------------------------------------------------------------
  // Multi-user workflows
  // -------------------------------------------------------------------------

  it("5 users register keys, all retrievable", async function () {
    const { registry, alice, bob, charlie, dave, eve } = await loadFixture(
      deployStealthRegistryFixture
    );

    const users = [alice, bob, charlie, dave, eve];
    const keys = users.map(() => ({ x: randomKey(), y: randomKey() }));

    for (let i = 0; i < users.length; i++) {
      await registry.connect(users[i]).registerViewingKey(keys[i].x, keys[i].y);
    }

    for (let i = 0; i < users.length; i++) {
      const [storedX, storedY] = await registry.getViewingKey(users[i].address);
      expect(storedX).to.equal(keys[i].x);
      expect(storedY).to.equal(keys[i].y);
    }
  });

  it("stealth announcement for user who later updates key", async function () {
    const { registry, alice, bob } = await loadFixture(deployStealthRegistryFixture);

    // Alice registers a viewing key
    const x1 = randomKey();
    const y1 = randomKey();
    await registry.connect(alice).registerViewingKey(x1, y1);

    // Bob announces a stealth payment intended for alice's original key
    const commitment = randomKey();
    const ephX = randomKey();
    const ephY = randomKey();
    const stealthX = randomKey();
    const stealthY = randomKey();
    const encAmt = randomKey();
    const encBlind = randomKey();

    await expect(
      registry.connect(bob).announceStealthPayment(
        commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlind
      )
    )
      .to.emit(registry, "StealthPayment")
      .withArgs(commitment, ephX, ephY, stealthX, stealthY, encAmt, encBlind);

    // Alice updates her key — the historical announcement is unaffected
    const x2 = randomKey();
    const y2 = randomKey();
    await registry.connect(alice).registerViewingKey(x2, y2);

    // Alice's key now reflects the new registration
    const [storedX, storedY] = await registry.getViewingKey(alice.address);
    expect(storedX).to.equal(x2);
    expect(storedY).to.equal(y2);
  });

  it("VERSION constant is accessible and correct", async function () {
    const { registry } = await loadFixture(deployStealthRegistryFixture);

    const version = await registry.VERSION();
    expect(version).to.equal(EXPECTED_VERSION);
  });
});
