import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import {
  DEFAULT_RPC_URL,
  CONFIDENTIAL_POOL_ABI,
  STEALTH_REGISTRY_ABI,
  CLI_DIRS,
  loadDeployment,
} from "./config.js";
import type { Note, FullKeypair } from "./crypto.js";

// ── Console output helpers ────────────────────────────────────────────────────

export const log = {
  success: (msg: string): void => console.log(`\u2713 ${msg}`),
  error: (msg: string): void => console.error(`\u2717 ${msg}`),
  info: (msg: string): void => console.log(`> ${msg}`),
  step: (msg: string): void => console.log(`  ${msg}`),
};

// ── Directories ──────────────────────────────────────────────────────────────

export function ensureDirs(): void {
  for (const dir of Object.values(CLI_DIRS)) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ── Provider / wallet ─────────────────────────────────────────────────────────

export function getProvider(rpc?: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpc ?? process.env["RPC_URL"] ?? DEFAULT_RPC_URL);
}

export function getWallet(provider: ethers.JsonRpcProvider): ethers.Wallet {
  const pk = process.env["PRIVATE_KEY"];
  if (!pk) {
    throw new Error("PRIVATE_KEY not set in environment. Add it to .env");
  }
  return new ethers.Wallet(pk, provider);
}

// ── Contracts ─────────────────────────────────────────────────────────────────

export function getConfidentialPool(
  signerOrProvider: ethers.Signer | ethers.Provider
): ethers.Contract {
  const deployment = loadDeployment();
  return new ethers.Contract(deployment.confidentialPool, CONFIDENTIAL_POOL_ABI, signerOrProvider);
}

export function getStealthRegistry(
  signerOrProvider: ethers.Signer | ethers.Provider
): ethers.Contract {
  const deployment = loadDeployment();
  return new ethers.Contract(deployment.stealthRegistry, STEALTH_REGISTRY_ABI, signerOrProvider);
}

// ── Note persistence ──────────────────────────────────────────────────────────

export interface StoredNote extends Note {
  leafIndex?: number;
  txHash?: string;
  spent?: boolean;
  createdAt?: string;
}

export function saveNote(note: StoredNote): void {
  ensureDirs();
  const file = path.join(CLI_DIRS.notes, `${note.commitment.toString()}.json`);
  const serialized = {
    amount: note.amount.toString(),
    blinding: note.blinding.toString(),
    ownerPubKeyX: note.ownerPubKeyX.toString(),
    commitment: note.commitment.toString(),
    leafIndex: note.leafIndex,
    txHash: note.txHash,
    spent: note.spent ?? false,
    createdAt: note.createdAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(serialized, null, 2));
}

export function loadNote(commitment: string): StoredNote {
  const file = path.join(CLI_DIRS.notes, `${commitment}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Note not found: ${commitment}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  return deserializeNote(raw);
}

export function loadAllNotes(): StoredNote[] {
  ensureDirs();
  if (!fs.existsSync(CLI_DIRS.notes)) return [];
  return fs
    .readdirSync(CLI_DIRS.notes)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(CLI_DIRS.notes, f), "utf-8")
      ) as Record<string, unknown>;
      return deserializeNote(raw);
    });
}

function deserializeNote(raw: Record<string, unknown>): StoredNote {
  return {
    amount: BigInt(raw["amount"] as string),
    blinding: BigInt(raw["blinding"] as string),
    ownerPubKeyX: BigInt(raw["ownerPubKeyX"] as string),
    commitment: BigInt(raw["commitment"] as string),
    leafIndex: raw["leafIndex"] as number | undefined,
    txHash: raw["txHash"] as string | undefined,
    spent: (raw["spent"] as boolean | undefined) ?? false,
    createdAt: raw["createdAt"] as string | undefined,
  };
}

export function markNoteSpent(commitment: string): void {
  const note = loadNote(commitment);
  saveNote({ ...note, spent: true });
}

// ── Key persistence ───────────────────────────────────────────────────────────

export interface StoredKeypair extends FullKeypair {
  address: string;
}

export function saveKeys(keys: StoredKeypair): void {
  ensureDirs();
  const file = path.join(CLI_DIRS.keys, `${keys.address}.json`);
  const serialized = {
    address: keys.address,
    spendingKey: keys.spendingKey.toString(),
    spendingPubKey: {
      x: keys.spendingPubKey.x.toString(),
      y: keys.spendingPubKey.y.toString(),
    },
    viewingKey: keys.viewingKey.toString(),
    viewingPubKey: {
      x: keys.viewingPubKey.x.toString(),
      y: keys.viewingPubKey.y.toString(),
    },
  };
  fs.writeFileSync(file, JSON.stringify(serialized, null, 2));
}

export function loadKeys(address: string): StoredKeypair {
  const file = path.join(CLI_DIRS.keys, `${address}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Keys not found for address ${address}. Run 'zk-pay keygen' first.`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  return deserializeKeys(raw);
}

export function loadFirstKeys(): StoredKeypair {
  ensureDirs();
  const files = fs.readdirSync(CLI_DIRS.keys).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error("No key files found in keys/. Run 'zk-pay keygen' first.");
  }
  const raw = JSON.parse(
    fs.readFileSync(path.join(CLI_DIRS.keys, files[0]), "utf-8")
  ) as Record<string, unknown>;
  return deserializeKeys(raw);
}

function deserializeKeys(raw: Record<string, unknown>): StoredKeypair {
  const spendingPubKey = raw["spendingPubKey"] as Record<string, string>;
  const viewingPubKey = raw["viewingPubKey"] as Record<string, string>;
  return {
    address: raw["address"] as string,
    spendingKey: BigInt(raw["spendingKey"] as string),
    spendingPubKey: {
      x: BigInt(spendingPubKey["x"]),
      y: BigInt(spendingPubKey["y"]),
    },
    viewingKey: BigInt(raw["viewingKey"] as string),
    viewingPubKey: {
      x: BigInt(viewingPubKey["x"]),
      y: BigInt(viewingPubKey["y"]),
    },
  };
}

// ── Proof formatting ──────────────────────────────────────────────────────────

export interface ProofCalldata {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
}

export function formatProofForSolidity(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): ProofCalldata {
  return {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  };
}

// ── Hex helpers ────────────────────────────────────────────────────────────────

export function bigintToHex(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

export function hexToBigint(hex: string): bigint {
  return BigInt(hex.startsWith("0x") ? hex : `0x${hex}`);
}
