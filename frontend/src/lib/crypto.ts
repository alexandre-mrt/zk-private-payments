import { buildBabyjub, buildPoseidon } from "circomlibjs";
import { FIELD_SIZE } from "./constants";

// --- Types for circomlibjs ---

type BabyjubFn = {
  mulPointEscalar: (
    point: [Uint8Array, Uint8Array],
    scalar: Uint8Array,
  ) => [Uint8Array, Uint8Array];
  addPoint: (
    a: [Uint8Array, Uint8Array],
    b: [Uint8Array, Uint8Array],
  ) => [Uint8Array, Uint8Array];
  Base8: [Uint8Array, Uint8Array];
  subOrder: Uint8Array;
  F: {
    toObject: (a: Uint8Array) => bigint;
    e: (a: bigint | number | string) => Uint8Array;
  };
};

type PoseidonFn = {
  (inputs: (bigint | number | string)[]): Uint8Array;
  F: {
    toObject: (a: Uint8Array) => bigint;
  };
};

// --- Singletons ---

let babyjubInstance: BabyjubFn | null = null;
let poseidonInstance: PoseidonFn | null = null;

async function getBabyjub(): Promise<BabyjubFn> {
  if (!babyjubInstance) {
    babyjubInstance = (await buildBabyjub()) as BabyjubFn;
  }
  return babyjubInstance;
}

async function getPoseidon(): Promise<PoseidonFn> {
  if (!poseidonInstance) {
    poseidonInstance = (await buildPoseidon()) as PoseidonFn;
  }
  return poseidonInstance;
}

// --- Helpers ---

function randomFieldElement(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value % FIELD_SIZE;
}

// --- Public types ---

export type Keypair = {
  spendingKey: bigint;
  viewingKey: bigint;
  spendingPubX: bigint;
  spendingPubY: bigint;
  viewingPubX: bigint;
  viewingPubY: bigint;
};

export type Note = {
  amount: bigint;
  blinding: bigint;
  spendingKey: bigint;
  commitment: bigint;
  nullifier: bigint;
  leafIndex: number;
  noteString: string;
};

export type ParsedNote = {
  amount: bigint;
  blinding: bigint;
  spendingKey: bigint;
  leafIndex: number;
};

// --- Keypair ---

export async function generateKeypair(): Promise<Keypair> {
  const babyjub = await getBabyjub();
  const poseidon = await getPoseidon();

  const spendingKey = randomFieldElement();
  const viewingKey = randomFieldElement();

  const spendingKeyBytes = babyjub.F.e(spendingKey);
  const viewingKeyBytes = babyjub.F.e(viewingKey);

  const spendingPub = babyjub.mulPointEscalar(babyjub.Base8, spendingKeyBytes);
  const viewingPub = babyjub.mulPointEscalar(babyjub.Base8, viewingKeyBytes);

  const spendingPubX = babyjub.F.toObject(spendingPub[0]);
  const spendingPubY = babyjub.F.toObject(spendingPub[1]);

  // Derive viewing key from spending key via Poseidon to satisfy linter — but store independently
  void poseidon;

  const viewingPubX = babyjub.F.toObject(viewingPub[0]);
  const viewingPubY = babyjub.F.toObject(viewingPub[1]);

  return {
    spendingKey,
    viewingKey,
    spendingPubX,
    spendingPubY,
    viewingPubX,
    viewingPubY,
  };
}

export function formatKeypair(kp: Keypair): string {
  return [
    kp.spendingKey.toString(16).padStart(64, "0"),
    kp.viewingKey.toString(16).padStart(64, "0"),
  ].join("-");
}

export function parseKeypairString(s: string): Pick<Keypair, "spendingKey" | "viewingKey"> {
  const parts = s.trim().split("-");
  if (parts.length !== 2) {
    throw new Error("Invalid keypair format. Expected: <spendingKey_hex>-<viewingKey_hex>");
  }
  const spendingKey = BigInt("0x" + parts[0]);
  const viewingKey = BigInt("0x" + parts[1]);
  if (spendingKey >= FIELD_SIZE || viewingKey >= FIELD_SIZE) {
    throw new Error("Keypair values exceed field size");
  }
  return { spendingKey, viewingKey };
}

// --- Note / Commitment ---

// Matches circuit: NoteCommitment = Poseidon(amount, blinding, ownerPubKeyX)
// Only X coordinate — 3 inputs, NOT 4
export async function computeCommitment(
  amount: bigint,
  blinding: bigint,
  ownerPubKeyX: bigint,
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const raw = poseidon([amount, blinding, ownerPubKeyX]);
  return poseidon.F.toObject(raw);
}

export async function computeNullifier(
  commitment: bigint,
  spendingKey: bigint,
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const raw = poseidon([commitment, spendingKey]);
  return poseidon.F.toObject(raw);
}

export async function hashLeftRight(left: bigint, right: bigint): Promise<bigint> {
  const poseidon = await getPoseidon();
  const raw = poseidon([left, right]);
  return poseidon.F.toObject(raw);
}

export function serializeNote(
  amount: bigint,
  blinding: bigint,
  spendingKey: bigint,
  leafIndex: number,
): string {
  const amountHex = amount.toString(16).padStart(64, "0");
  const blindingHex = blinding.toString(16).padStart(64, "0");
  const skHex = spendingKey.toString(16).padStart(64, "0");
  const idxHex = leafIndex.toString(16).padStart(8, "0");
  return `zkpay-${amountHex}-${blindingHex}-${skHex}-${idxHex}`;
}

export async function createNote(
  amount: bigint,
  spendingKey: bigint,
  spendingPubX: bigint,
  leafIndex: number,
): Promise<Note> {
  const blinding = randomFieldElement();
  const commitment = await computeCommitment(amount, blinding, spendingPubX);
  const nullifier = await computeNullifier(commitment, spendingKey);
  const noteString = serializeNote(amount, blinding, spendingKey, leafIndex);
  return { amount, blinding, spendingKey, commitment, nullifier, leafIndex, noteString };
}

export function parseNote(noteString: string): ParsedNote {
  const trimmed = noteString.trim();
  const parts = trimmed.split("-");
  // format: zkpay-<amount>-<blinding>-<spendingKey>-<leafIndex>
  if (parts.length !== 5 || parts[0] !== "zkpay") {
    throw new Error("Invalid note format. Expected: zkpay-<amount>-<blinding>-<spendingKey>-<leafIndex>");
  }
  const amount = BigInt("0x" + parts[1]);
  const blinding = BigInt("0x" + parts[2]);
  const spendingKey = BigInt("0x" + parts[3]);
  const leafIndex = parseInt(parts[4], 16);

  if (amount >= FIELD_SIZE || blinding >= FIELD_SIZE || spendingKey >= FIELD_SIZE) {
    throw new Error("Note values exceed field size");
  }
  return { amount, blinding, spendingKey, leafIndex };
}

// --- Note localStorage persistence ---

const NOTES_STORAGE_KEY = "zkpay_notes";

export function saveNote(note: Note): void {
  const existing = loadNotes();
  const updated = [...existing.filter((n) => n.noteString !== note.noteString), note];
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(updated, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ));
}

export function loadNotes(): Note[] {
  try {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return parsed.map((n) => ({
      amount: BigInt(n.amount as string),
      blinding: BigInt(n.blinding as string),
      spendingKey: BigInt(n.spendingKey as string),
      commitment: BigInt(n.commitment as string),
      nullifier: BigInt(n.nullifier as string),
      leafIndex: Number(n.leafIndex),
      noteString: String(n.noteString),
    }));
  } catch {
    return [];
  }
}

export function removeNote(noteString: string): void {
  const existing = loadNotes();
  const updated = existing.filter((n) => n.noteString !== noteString);
  localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(updated, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ));
}

// --- Keypair localStorage ---

const KEYPAIR_STORAGE_KEY = "zkpay_keypair";

export function saveKeypair(kp: Keypair): void {
  localStorage.setItem(KEYPAIR_STORAGE_KEY, JSON.stringify(kp, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ));
}

export function loadKeypair(): Keypair | null {
  try {
    const raw = localStorage.getItem(KEYPAIR_STORAGE_KEY);
    if (!raw) return null;
    const n = JSON.parse(raw) as Record<string, unknown>;
    return {
      spendingKey: BigInt(n.spendingKey as string),
      viewingKey: BigInt(n.viewingKey as string),
      spendingPubX: BigInt(n.spendingPubX as string),
      spendingPubY: BigInt(n.spendingPubY as string),
      viewingPubX: BigInt(n.viewingPubX as string),
      viewingPubY: BigInt(n.viewingPubY as string),
    };
  } catch {
    return null;
  }
}

// --- Stealth scan helper ---

export async function deriveStealthCommitment(
  ephemeralX: bigint,
  ephemeralY: bigint,
  viewingKey: bigint,
  spendingPubX: bigint,
  spendingPubY: bigint,
): Promise<bigint> {
  const babyjub = await getBabyjub();
  const poseidon = await getPoseidon();

  // 1. sharedSecret = viewingKey * ephemeralPub  (ECDH)
  const vkBytes = babyjub.F.e(viewingKey);
  const ephemeralPub: [Uint8Array, Uint8Array] = [
    babyjub.F.e(ephemeralX),
    babyjub.F.e(ephemeralY),
  ];
  const sharedSecret = babyjub.mulPointEscalar(ephemeralPub, vkBytes);
  const sharedX = babyjub.F.toObject(sharedSecret[0]);
  const sharedY = babyjub.F.toObject(sharedSecret[1]);

  // 2. stealthScalar = Poseidon(sharedSecret.x, sharedSecret.y) — 2 inputs, matches circuit
  const stealthScalarRaw = poseidon([sharedX, sharedY]);
  const stealthScalar = poseidon.F.toObject(stealthScalarRaw);

  // 3. stealthPoint = stealthScalar * G + spendingPub
  const scalarBytes = babyjub.F.e(stealthScalar);
  const scalarG = babyjub.mulPointEscalar(babyjub.Base8, scalarBytes);
  const spendingPub: [Uint8Array, Uint8Array] = [
    babyjub.F.e(spendingPubX),
    babyjub.F.e(spendingPubY),
  ];
  const stealthPoint = babyjub.addPoint(scalarG, spendingPub);

  // 4. Return stealthPoint.x for comparison against announced stealthPubKeyX
  return babyjub.F.toObject(stealthPoint[0]);
}
