import { expect } from "chai";
import { buildPoseidon, buildBabyjub } from "circomlibjs";

// Matches ZERO_VALUE in cli/merkle-tree.ts
const ZERO_VALUE = BigInt(
  "21663839004416932945382355908790599225266501822907911457504978515578255421292"
);

// BN254 / alt_bn128 scalar field size (used by Poseidon)
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("CLI Crypto Utils", function () {
  // circomlibjs builds WASM, increase timeout
  this.timeout(30_000);

  let poseidon: any;
  let babyjub: any;
  let F: any;

  before(async () => {
    poseidon = await buildPoseidon();
    babyjub = await buildBabyjub();
    F = poseidon.F;
  });

  // ---------------------------------------------------------------------------
  // Note Commitment: Poseidon(amount, blinding, ownerPubKeyX)
  // ---------------------------------------------------------------------------
  describe("Note Commitment", () => {
    it("is deterministic for the same inputs", () => {
      const amount = 1_000_000n;
      const blinding = 12345n;
      const pubKeyX = 67890n;

      const c1 = F.toObject(poseidon([amount, blinding, pubKeyX]));
      const c2 = F.toObject(poseidon([amount, blinding, pubKeyX]));

      expect(c1).to.equal(c2);
    });

    it("different inputs produce different commitments", () => {
      const c1 = F.toObject(poseidon([100n, 200n, 300n]));
      const c2 = F.toObject(poseidon([100n, 200n, 301n]));

      expect(c1).to.not.equal(c2);
    });

    it("commitment is a valid field element (in range)", () => {
      const c = F.toObject(poseidon([1n, 2n, 3n]));

      expect(c).to.be.lessThan(FIELD_SIZE);
      expect(c).to.be.greaterThan(0n);
    });

    it("changing amount changes the commitment", () => {
      const blinding = 99n;
      const pubKeyX = 88n;
      const c1 = F.toObject(poseidon([500n, blinding, pubKeyX]));
      const c2 = F.toObject(poseidon([501n, blinding, pubKeyX]));

      expect(c1).to.not.equal(c2);
    });

    it("changing blinding changes the commitment", () => {
      const amount = 1000n;
      const pubKeyX = 77n;
      const c1 = F.toObject(poseidon([amount, 1n, pubKeyX]));
      const c2 = F.toObject(poseidon([amount, 2n, pubKeyX]));

      expect(c1).to.not.equal(c2);
    });

    it("zero-amount commitment is a valid field element", () => {
      const c = F.toObject(poseidon([0n, 1n, 1n]));

      expect(c).to.be.lessThan(FIELD_SIZE);
      expect(c).to.be.greaterThan(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // Nullifier: Poseidon(commitment, spendingKey)
  // ---------------------------------------------------------------------------
  describe("Nullifier", () => {
    it("is deterministic for the same commitment and spending key", () => {
      const commitment = F.toObject(poseidon([100n, 200n, 300n]));
      const spendingKey = 42n;

      const n1 = F.toObject(poseidon([commitment, spendingKey]));
      const n2 = F.toObject(poseidon([commitment, spendingKey]));

      expect(n1).to.equal(n2);
    });

    it("different spending keys produce different nullifiers", () => {
      const commitment = F.toObject(poseidon([100n, 200n, 300n]));

      const n1 = F.toObject(poseidon([commitment, 1n]));
      const n2 = F.toObject(poseidon([commitment, 2n]));

      expect(n1).to.not.equal(n2);
    });

    it("different commitments produce different nullifiers", () => {
      const c1 = F.toObject(poseidon([100n, 200n, 300n]));
      const c2 = F.toObject(poseidon([100n, 200n, 301n]));
      const spendingKey = 99n;

      const n1 = F.toObject(poseidon([c1, spendingKey]));
      const n2 = F.toObject(poseidon([c2, spendingKey]));

      expect(n1).to.not.equal(n2);
    });

    it("nullifier is a valid field element", () => {
      const commitment = F.toObject(poseidon([1n, 2n, 3n]));
      const n = F.toObject(poseidon([commitment, 42n]));

      expect(n).to.be.lessThan(FIELD_SIZE);
      expect(n).to.be.greaterThan(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // BabyJubjub Keypair
  // ---------------------------------------------------------------------------
  describe("BabyJubjub Keypair", () => {
    it("scalar multiplication on Base8 produces a non-zero point", () => {
      const privKey = 12345n;
      const pubPoint = babyjub.mulPointEscalar(babyjub.Base8, privKey);
      const x = babyjub.F.toObject(pubPoint[0]);
      const y = babyjub.F.toObject(pubPoint[1]);

      expect(x).to.be.greaterThan(0n);
      expect(y).to.be.greaterThan(0n);
    });

    it("different private keys produce different public keys", () => {
      const pub1 = babyjub.mulPointEscalar(babyjub.Base8, 111n);
      const pub2 = babyjub.mulPointEscalar(babyjub.Base8, 222n);

      expect(babyjub.F.toObject(pub1[0])).to.not.equal(babyjub.F.toObject(pub2[0]));
    });

    it("same private key always produces the same public key", () => {
      const privKey = 99999n;
      const pub1 = babyjub.mulPointEscalar(babyjub.Base8, privKey);
      const pub2 = babyjub.mulPointEscalar(babyjub.Base8, privKey);

      expect(babyjub.F.toObject(pub1[0])).to.equal(babyjub.F.toObject(pub2[0]));
      expect(babyjub.F.toObject(pub1[1])).to.equal(babyjub.F.toObject(pub2[1]));
    });

    it("ECDH shared secret is symmetric: a*B == b*A", () => {
      const a = 100n;
      const b = 200n;
      const A = babyjub.mulPointEscalar(babyjub.Base8, a);
      const B = babyjub.mulPointEscalar(babyjub.Base8, b);

      const shared1 = babyjub.mulPointEscalar(B, a);
      const shared2 = babyjub.mulPointEscalar(A, b);

      expect(babyjub.F.toObject(shared1[0])).to.equal(babyjub.F.toObject(shared2[0]));
      expect(babyjub.F.toObject(shared1[1])).to.equal(babyjub.F.toObject(shared2[1]));
    });
  });

  // ---------------------------------------------------------------------------
  // Merkle Tree (inline, matching cli/merkle-tree.ts)
  // ---------------------------------------------------------------------------
  describe("Merkle Tree", () => {
    // Matches the hashPair private method in MerkleTree
    function hashPair(left: bigint, right: bigint): bigint {
      return F.toObject(poseidon([left, right]));
    }

    // Build zero hashes the same way MerkleTree constructor does
    function buildZeros(levels: number): bigint[] {
      const zeros = new Array<bigint>(levels + 1);
      zeros[0] = ZERO_VALUE;
      for (let i = 1; i <= levels; i++) {
        zeros[i] = hashPair(zeros[i - 1], zeros[i - 1]);
      }
      return zeros;
    }

    it("zero hashes are precomputed non-trivially (ZERO_VALUE propagates)", () => {
      const zeros = buildZeros(3);

      expect(zeros[0]).to.equal(ZERO_VALUE);
      // Each level hashes its children — all distinct
      expect(zeros[1]).to.not.equal(zeros[0]);
      expect(zeros[2]).to.not.equal(zeros[1]);
      expect(zeros[3]).to.not.equal(zeros[2]);
    });

    it("empty tree root is deterministic", () => {
      const zeros = buildZeros(2);
      const root1 = zeros[2];
      const zeros2 = buildZeros(2);
      const root2 = zeros2[2];

      expect(root1).to.equal(root2);
    });

    it("inserting a leaf changes the root", () => {
      const zeros = buildZeros(2);
      const emptyRoot = zeros[2];

      // Insert leaf at index 0 in a depth-2 tree
      const leaf = F.toObject(poseidon([1n, 2n, 3n]));
      const level1 = hashPair(leaf, zeros[0]);
      const newRoot = hashPair(level1, zeros[1]);

      expect(newRoot).to.not.equal(emptyRoot);
    });

    it("proof verification: leaf at index 0 with correct path reconstructs root", () => {
      const zeros = buildZeros(2);
      const leaf = 42n;

      // Insert at index 0
      const level1 = hashPair(leaf, zeros[0]);
      const root = hashPair(level1, zeros[1]);

      // Proof: pathElements=[zeros[0], zeros[1]], pathIndices=[0, 0]
      let current = leaf;
      const pathElements = [zeros[0], zeros[1]];
      const pathIndices = [0, 0];

      for (let i = 0; i < 2; i++) {
        if (pathIndices[i] === 0) {
          current = hashPair(current, pathElements[i]);
        } else {
          current = hashPair(pathElements[i], current);
        }
      }

      expect(current).to.equal(root);
    });

    it("proof verification: leaf at index 1 with correct path reconstructs root", () => {
      const zeros = buildZeros(2);
      const leaf0 = 100n;
      const leaf1 = 200n;

      // Insert leaf0 at index 0, leaf1 at index 1
      const level1Left = hashPair(leaf0, leaf1);
      const root = hashPair(level1Left, zeros[1]);

      // Proof for index 1: sibling at level 0 is leaf0 (index 0), pathIndex=1
      // Sibling at level 1 is zeros[1] (index 1 at level 1), pathIndex=0
      let current = leaf1;
      const pathElements = [leaf0, zeros[1]];
      const pathIndices = [1, 0];

      for (let i = 0; i < 2; i++) {
        if (pathIndices[i] === 0) {
          current = hashPair(current, pathElements[i]);
        } else {
          current = hashPair(pathElements[i], current);
        }
      }

      expect(current).to.equal(root);
    });

    it("a tampered leaf does not reconstruct the root", () => {
      const zeros = buildZeros(2);
      const realLeaf = 42n;
      const fakeLeaf = 43n;

      const level1 = hashPair(realLeaf, zeros[0]);
      const root = hashPair(level1, zeros[1]);

      // Try to reconstruct with wrong leaf
      const fakeLevel1 = hashPair(fakeLeaf, zeros[0]);
      const fakeRoot = hashPair(fakeLevel1, zeros[1]);

      expect(fakeRoot).to.not.equal(root);
    });

    it("different leaves at the same position yield different roots", () => {
      const zeros = buildZeros(2);

      const leaf1 = F.toObject(poseidon([10n, 20n, 30n]));
      const leaf2 = F.toObject(poseidon([10n, 20n, 31n]));

      const root1 = hashPair(hashPair(leaf1, zeros[0]), zeros[1]);
      const root2 = hashPair(hashPair(leaf2, zeros[0]), zeros[1]);

      expect(root1).to.not.equal(root2);
    });
  });

  // ---------------------------------------------------------------------------
  // Stealth Address Derivation (matching cli/crypto.ts deriveStealthKeypair)
  // Uses recipient's viewing pub key (not spending key) per the source
  // ---------------------------------------------------------------------------
  describe("Stealth Address Derivation", () => {
    it("sender and receiver derive the same stealth address", () => {
      const viewingKey = 111n;
      const spendingKey = 222n;
      const ephemeralKey = 333n;

      const viewPub = babyjub.mulPointEscalar(babyjub.Base8, viewingKey);
      const spendPub = babyjub.mulPointEscalar(babyjub.Base8, spendingKey);
      const ephPub = babyjub.mulPointEscalar(babyjub.Base8, ephemeralKey);

      // Sender: sharedX = Poseidon(ephemeralKey * viewPub)[0]
      const senderShared = babyjub.mulPointEscalar(viewPub, ephemeralKey);
      const senderSharedX = F.toObject(poseidon([babyjub.F.toObject(senderShared[0])]));
      const senderBase = babyjub.mulPointEscalar(babyjub.Base8, senderSharedX);
      // Stealth = sharedBase + viewPub (matches deriveStealthKeypair which uses viewPub)
      const senderStealth = babyjub.addPoint(senderBase, viewPub);

      // Receiver: sharedX = Poseidon(viewingKey * ephPub)[0]
      const receiverShared = babyjub.mulPointEscalar(ephPub, viewingKey);
      const receiverSharedX = F.toObject(poseidon([babyjub.F.toObject(receiverShared[0])]));
      const receiverBase = babyjub.mulPointEscalar(babyjub.Base8, receiverSharedX);
      const receiverStealth = babyjub.addPoint(receiverBase, viewPub);

      expect(babyjub.F.toObject(senderStealth[0])).to.equal(
        babyjub.F.toObject(receiverStealth[0])
      );
      expect(babyjub.F.toObject(senderStealth[1])).to.equal(
        babyjub.F.toObject(receiverStealth[1])
      );
    });

    it("different ephemeral keys produce different stealth addresses", () => {
      const viewingKey = 111n;
      const eph1 = 333n;
      const eph2 = 444n;

      const viewPub = babyjub.mulPointEscalar(babyjub.Base8, viewingKey);

      function stealthFor(ephKey: bigint) {
        const shared = babyjub.mulPointEscalar(viewPub, ephKey);
        const sharedX = F.toObject(poseidon([babyjub.F.toObject(shared[0])]));
        const base = babyjub.mulPointEscalar(babyjub.Base8, sharedX);
        return babyjub.addPoint(base, viewPub);
      }

      const s1 = stealthFor(eph1);
      const s2 = stealthFor(eph2);

      expect(babyjub.F.toObject(s1[0])).to.not.equal(babyjub.F.toObject(s2[0]));
    });

    it("different recipient viewing keys produce different stealth addresses", () => {
      const eph = 333n;
      const viewingKey1 = 111n;
      const viewingKey2 = 999n;

      function stealthFor(viewKey: bigint) {
        const viewPub = babyjub.mulPointEscalar(babyjub.Base8, viewKey);
        const shared = babyjub.mulPointEscalar(viewPub, eph);
        const sharedX = F.toObject(poseidon([babyjub.F.toObject(shared[0])]));
        const base = babyjub.mulPointEscalar(babyjub.Base8, sharedX);
        return babyjub.addPoint(base, viewPub);
      }

      const s1 = stealthFor(viewingKey1);
      const s2 = stealthFor(viewingKey2);

      expect(babyjub.F.toObject(s1[0])).to.not.equal(babyjub.F.toObject(s2[0]));
    });

    it("Poseidon(sharedX) scalar is a valid field element", () => {
      const viewingKey = 555n;
      const eph = 666n;

      const viewPub = babyjub.mulPointEscalar(babyjub.Base8, viewingKey);
      const shared = babyjub.mulPointEscalar(viewPub, eph);
      const sharedX = F.toObject(poseidon([babyjub.F.toObject(shared[0])]));

      expect(sharedX).to.be.lessThan(FIELD_SIZE);
      expect(sharedX).to.be.greaterThan(0n);
    });
  });
});
