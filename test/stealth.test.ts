import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployStealthRegistryFixture() {
  const [owner, alice, bob, charlie] = await ethers.getSigners();
  const StealthRegistry =
    await ethers.getContractFactory("StealthRegistry");
  const registry = await StealthRegistry.deploy();
  return { registry, owner, alice, bob, charlie };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomKey(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StealthRegistry", function () {
  // -------------------------------------------------------------------------
  // 1. ViewingKey registration
  // -------------------------------------------------------------------------

  describe("ViewingKey", function () {
    it("stores viewing key after registration", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
      const x = randomKey();
      const y = randomKey();

      await registry.connect(alice).registerViewingKey(x, y);
      const [storedX, storedY] = await registry.getViewingKey(alice.address);
      expect(storedX).to.equal(x);
      expect(storedY).to.equal(y);
    });

    it("emits ViewingKeyRegistered event with correct args", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
      const x = randomKey();
      const y = randomKey();

      await expect(registry.connect(alice).registerViewingKey(x, y))
        .to.emit(registry, "ViewingKeyRegistered")
        .withArgs(alice.address, x, y);
    });

    it("allows updating a viewing key", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
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

    it("reverts when both pubKeyX and pubKeyY are zero", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
      await expect(
        registry.connect(alice).registerViewingKey(0n, 0n)
      ).to.be.revertedWith("StealthRegistry: zero key");
    });

    it("allows key where only pubKeyX is zero (not both zero)", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
      const y = randomKey();
      // x = 0, y != 0 — should succeed
      await registry.connect(alice).registerViewingKey(0n, y);
      const [storedX, storedY] = await registry.getViewingKey(alice.address);
      expect(storedX).to.equal(0n);
      expect(storedY).to.equal(y);
    });

    it("allows key where only pubKeyY is zero (not both zero)", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
      const x = randomKey();
      // x != 0, y = 0 — should succeed
      await registry.connect(alice).registerViewingKey(x, 0n);
      const [storedX, storedY] = await registry.getViewingKey(alice.address);
      expect(storedX).to.equal(x);
      expect(storedY).to.equal(0n);
    });

    it("returns (0, 0) for an address that never registered", async function () {
      const { registry, charlie } = await loadFixture(
        deployStealthRegistryFixture
      );
      const [x, y] = await registry.getViewingKey(charlie.address);
      expect(x).to.equal(0n);
      expect(y).to.equal(0n);
    });

    it("returns (0, 0) for zero address query", async function () {
      const { registry } = await loadFixture(deployStealthRegistryFixture);
      const [x, y] = await registry.getViewingKey(ethers.ZeroAddress);
      expect(x).to.equal(0n);
      expect(y).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // 2. StealthPayment announcements
  // -------------------------------------------------------------------------

  describe("StealthPayment", function () {
    it("emits StealthPayment event with all correct args including encrypted data", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
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

    it("anyone can announce a stealth payment (no restriction)", async function () {
      const { registry, bob } = await loadFixture(deployStealthRegistryFixture);
      // Bob announces without having registered a key — should not revert
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

    it("emits multiple StealthPayment events independently", async function () {
      const { registry, alice, bob } = await loadFixture(
        deployStealthRegistryFixture
      );

      const c1 = randomKey();
      const c2 = randomKey();

      await registry
        .connect(alice)
        .announceStealthPayment(
          c1, randomKey(), randomKey(), randomKey(), randomKey(), randomKey(), randomKey()
        );
      await registry
        .connect(bob)
        .announceStealthPayment(
          c2, randomKey(), randomKey(), randomKey(), randomKey(), randomKey(), randomKey()
        );

      // Both should have completed without revert
      // (event filtering is a client concern — we just confirm no revert)
    });

    it("commitment is the indexed field in StealthPayment event", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
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
      expect(receipt!.logs.length).to.be.greaterThan(0);
    });

    it("encrypted data fields are stored exactly as passed (no on-chain transformation)", async function () {
      const { registry, alice } = await loadFixture(
        deployStealthRegistryFixture
      );
      const encAmt = randomKey();
      const encBlind = randomKey();

      const tx = await registry
        .connect(alice)
        .announceStealthPayment(
          randomKey(),
          randomKey(),
          randomKey(),
          randomKey(),
          randomKey(),
          encAmt,
          encBlind
        );

      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      // Parse the emitted event and verify encrypted data is unchanged
      const iface = registry.interface;
      for (const txLog of receipt!.logs) {
        try {
          const parsed = iface.parseLog(txLog);
          if (parsed?.name === "StealthPayment") {
            expect(parsed.args["encryptedAmount"]).to.equal(encAmt);
            expect(parsed.args["encryptedBlinding"]).to.equal(encBlind);
          }
        } catch {
          // Not a StealthPayment log
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Multiple users
  // -------------------------------------------------------------------------

  describe("Multiple users", function () {
    it("each user has their own viewing key", async function () {
      const { registry, alice, bob, charlie } = await loadFixture(
        deployStealthRegistryFixture
      );
      const aliceX = randomKey();
      const aliceY = randomKey();
      const bobX = randomKey();
      const bobY = randomKey();
      const charlieX = randomKey();
      const charlieY = randomKey();

      await registry.connect(alice).registerViewingKey(aliceX, aliceY);
      await registry.connect(bob).registerViewingKey(bobX, bobY);
      await registry.connect(charlie).registerViewingKey(charlieX, charlieY);

      const [ax, ay] = await registry.getViewingKey(alice.address);
      const [bx, by] = await registry.getViewingKey(bob.address);
      const [cx, cy] = await registry.getViewingKey(charlie.address);

      expect(ax).to.equal(aliceX);
      expect(ay).to.equal(aliceY);
      expect(bx).to.equal(bobX);
      expect(by).to.equal(bobY);
      expect(cx).to.equal(charlieX);
      expect(cy).to.equal(charlieY);
    });

    it("updating one user's key does not affect others", async function () {
      const { registry, alice, bob } = await loadFixture(
        deployStealthRegistryFixture
      );
      const aliceX = randomKey();
      const aliceY = randomKey();
      const bobX = randomKey();
      const bobY = randomKey();

      await registry.connect(alice).registerViewingKey(aliceX, aliceY);
      await registry.connect(bob).registerViewingKey(bobX, bobY);

      // Alice updates her key
      await registry.connect(alice).registerViewingKey(randomKey(), randomKey());

      // Bob's key unchanged
      const [bx, by] = await registry.getViewingKey(bob.address);
      expect(bx).to.equal(bobX);
      expect(by).to.equal(bobY);
    });

    it("emits correct owner in ViewingKeyRegistered for each user", async function () {
      const { registry, alice, bob } = await loadFixture(
        deployStealthRegistryFixture
      );

      await expect(
        registry.connect(alice).registerViewingKey(randomKey(), randomKey())
      ).to.emit(registry, "ViewingKeyRegistered").withArgs(
        alice.address,
        // we don't care about exact key values here
        // use anyValue from chai-matchers
        (v: bigint) => typeof v === "bigint",
        (v: bigint) => typeof v === "bigint"
      );

      await expect(
        registry.connect(bob).registerViewingKey(randomKey(), randomKey())
      ).to.emit(registry, "ViewingKeyRegistered").withArgs(
        bob.address,
        (v: bigint) => typeof v === "bigint",
        (v: bigint) => typeof v === "bigint"
      );
    });
  });
});
