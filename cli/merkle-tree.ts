import { buildPoseidon } from "circomlibjs";
import type { PoseidonFn } from "circomlibjs";

// Incremental Merkle tree matching the on-chain MerkleTree.sol (Poseidon-based)
export const ZERO_VALUE = BigInt(
  "21663839004416932945382355908790599225266501822907911457504978515578255421292"
);

export class MerkleTree {
  private readonly levels: number;
  private readonly poseidon: PoseidonFn;
  private readonly F: PoseidonFn["F"];
  private layers: Map<number, bigint>;
  private zeros: bigint[];
  private _nextIndex: number;

  private constructor(levels: number, poseidon: PoseidonFn) {
    this.levels = levels;
    this.poseidon = poseidon;
    this.F = poseidon.F;
    this.layers = new Map();
    this._nextIndex = 0;

    // Precompute zero hashes for each level
    this.zeros = new Array(levels + 1);
    this.zeros[0] = ZERO_VALUE;
    for (let i = 1; i <= levels; i++) {
      this.zeros[i] = this.hashPair(this.zeros[i - 1], this.zeros[i - 1]);
    }
  }

  static async create(levels: number): Promise<MerkleTree> {
    const poseidon = await buildPoseidon();
    return new MerkleTree(levels, poseidon);
  }

  get nextIndex(): number {
    return this._nextIndex;
  }

  get root(): bigint {
    return this.getNode(this.levels, 0);
  }

  private hashPair(left: bigint, right: bigint): bigint {
    return this.F.toObject(this.poseidon([left, right]));
  }

  private layerKey(level: number, index: number): number {
    return level * (1 << 20) + index;
  }

  private getNode(level: number, index: number): bigint {
    return this.layers.get(this.layerKey(level, index)) ?? this.zeros[level];
  }

  insert(leaf: bigint): number {
    const leafIndex = this._nextIndex;
    let currentIndex = leafIndex;
    let currentHash = leaf;

    for (let level = 0; level < this.levels; level++) {
      let left: bigint;
      let right: bigint;
      if (currentIndex % 2 === 0) {
        left = currentHash;
        right = this.zeros[level];
        // Store this left node for later sibling use
        this.layers.set(this.layerKey(level, currentIndex), currentHash);
      } else {
        left = this.getNode(level, currentIndex - 1);
        right = currentHash;
        this.layers.set(this.layerKey(level, currentIndex), currentHash);
      }
      currentHash = this.hashPair(left, right);
      currentIndex = Math.floor(currentIndex / 2);
    }

    this.layers.set(this.layerKey(this.levels, 0), currentHash);
    this._nextIndex += 1;
    return leafIndex;
  }

  // Build and insert all leaves at once (from events)
  insertAll(leaves: bigint[]): void {
    for (const leaf of leaves) {
      this.insert(leaf);
    }
  }

  // Get the Merkle proof path for a leaf at a given index
  getProof(leafIndex: number): { pathElements: bigint[]; pathIndices: number[] } {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentIndex = leafIndex;
    for (let level = 0; level < this.levels; level++) {
      const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
      pathElements.push(this.getNode(level, siblingIndex));
      pathIndices.push(currentIndex % 2);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
  }
}
