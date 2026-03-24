import { buildBabyjub, buildPoseidon } from "circomlibjs";

// Generate a random field element as BigInt (< BabyJubjub subOrder)
function randomBytes32(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return BigInt(hex);
}

export interface Keypair {
  privKey: bigint;
  pubKey: { x: bigint; y: bigint };
}

export interface FullKeypair {
  spendingKey: bigint;
  spendingPubKey: { x: bigint; y: bigint };
  viewingKey: bigint;
  viewingPubKey: { x: bigint; y: bigint };
}

export interface Note {
  amount: bigint;
  blinding: bigint;
  ownerPubKeyX: bigint;
  commitment: bigint;
}

async function generateSingleKeypair(): Promise<Keypair> {
  const babyjub = await buildBabyjub();
  const F = babyjub.F;

  const rawBytes = randomBytes32();
  // Mask to fit within the subOrder (255 bits)
  rawBytes[0] &= 0x1f;
  const privKey = bytesToBigInt(rawBytes);

  const pubPoint = babyjub.mulPointEscalar(babyjub.Base8, privKey);
  return {
    privKey,
    pubKey: {
      x: F.toObject(pubPoint[0]),
      y: F.toObject(pubPoint[1]),
    },
  };
}

export async function generateKeypair(): Promise<FullKeypair> {
  const spending = await generateSingleKeypair();
  const viewing = await generateSingleKeypair();

  return {
    spendingKey: spending.privKey,
    spendingPubKey: spending.pubKey,
    viewingKey: viewing.privKey,
    viewingPubKey: viewing.pubKey,
  };
}

export async function createNote(amount: bigint, ownerPubKeyX: bigint): Promise<Note> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const blindingBytes = randomBytes32();
  blindingBytes[0] &= 0x1f;
  const blinding = bytesToBigInt(blindingBytes);

  const commitmentRaw = poseidon([amount, blinding, ownerPubKeyX]);
  const commitment = F.toObject(commitmentRaw);

  return { amount, blinding, ownerPubKeyX, commitment };
}

export async function computeNullifier(commitment: bigint, spendingKey: bigint): Promise<bigint> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([commitment, spendingKey]));
}

export async function verifyNoteOwnership(note: Note, spendingPubKeyX: bigint): Promise<boolean> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const recomputed = F.toObject(poseidon([note.amount, note.blinding, note.ownerPubKeyX]));
  return recomputed === note.commitment && note.ownerPubKeyX === spendingPubKeyX;
}

// Derive an ECDH shared secret for stealth address scanning
// sharedSecret = viewingKey * ephemeralPubKey
export async function deriveSharedSecret(
  viewingKey: bigint,
  ephPubKeyX: bigint,
  ephPubKeyY: bigint
): Promise<{ x: bigint; y: bigint }> {
  const babyjub = await buildBabyjub();
  const F = babyjub.F;
  const point: [unknown, unknown] = [F.e(ephPubKeyX), F.e(ephPubKeyY)];
  const shared = babyjub.mulPointEscalar(point, viewingKey);
  return {
    x: F.toObject(shared[0]),
    y: F.toObject(shared[1]),
  };
}

// Derive ephemeral keypair and stealth pubkey for an announcement.
// Also returns the raw ECDH shared point (before Poseidon hashing) so
// the caller can pass it to encryptNoteData without recomputing.
export async function deriveStealthKeypair(
  recipientViewingPubKeyX: bigint,
  recipientViewingPubKeyY: bigint
): Promise<{
  ephemeralPrivKey: bigint;
  ephemeralPubKeyX: bigint;
  ephemeralPubKeyY: bigint;
  stealthPubKeyX: bigint;
  stealthPubKeyY: bigint;
  sharedPointX: bigint;
  sharedPointY: bigint;
}> {
  const babyjub = await buildBabyjub();
  const poseidon = await buildPoseidon();
  const F = babyjub.F;

  // Random ephemeral key
  const ephBytes = randomBytes32();
  ephBytes[0] &= 0x1f;
  const ephemeralPrivKey = bytesToBigInt(ephBytes);

  const ephPubPoint = babyjub.mulPointEscalar(babyjub.Base8, ephemeralPrivKey);
  const ephemeralPubKeyX = F.toObject(ephPubPoint[0]);
  const ephemeralPubKeyY = F.toObject(ephPubPoint[1]);

  // Shared secret = ephemeralPrivKey * recipientViewingPubKey
  const recipientPoint: [unknown, unknown] = [
    F.e(recipientViewingPubKeyX),
    F.e(recipientViewingPubKeyY),
  ];
  const sharedPoint = babyjub.mulPointEscalar(recipientPoint, ephemeralPrivKey);
  const sharedPointX: bigint = F.toObject(sharedPoint[0]);
  const sharedPointY: bigint = F.toObject(sharedPoint[1]);
  const sharedX = poseidon.F.toObject(poseidon([sharedPointX]));

  // Stealth pubkey = sharedX * G + recipientViewingPubKey
  const sharedBase = babyjub.mulPointEscalar(babyjub.Base8, sharedX);
  const stealthPoint = babyjub.addPoint(sharedBase, recipientPoint);
  const stealthPubKeyX = F.toObject(stealthPoint[0]);
  const stealthPubKeyY = F.toObject(stealthPoint[1]);

  return {
    ephemeralPrivKey,
    ephemeralPubKeyX,
    ephemeralPubKeyY,
    stealthPubKeyX,
    stealthPubKeyY,
    sharedPointX,
    sharedPointY,
  };
}

// Maximum uint64 value — amounts are capped to 64 bits (covers all practical ETH amounts in wei)
const UINT64_MASK = (1n << 64n) - 1n;

// Derive the XOR encryption key from the ECDH shared point.
// key = Poseidon(sharedPoint.x, sharedPoint.y)
async function deriveEncryptionKey(sharedPointX: bigint, sharedPointY: bigint): Promise<bigint> {
  const poseidon = await buildPoseidon();
  return poseidon.F.toObject(poseidon([sharedPointX, sharedPointY]));
}

// Encrypt note data for on-chain broadcast using the ECDH shared point.
// The receiver derives the same shared point via viewingKey * ephemeralPubKey.
//
//   key               = Poseidon(sharedPoint.x, sharedPoint.y)
//   encryptedAmount   = amount   XOR (key AND UINT64_MASK)
//   encryptedBlinding = blinding XOR key
export async function encryptNoteData(
  amount: bigint,
  blinding: bigint,
  sharedPointX: bigint,
  sharedPointY: bigint
): Promise<{ encryptedAmount: bigint; encryptedBlinding: bigint }> {
  const key = await deriveEncryptionKey(sharedPointX, sharedPointY);
  const encryptedAmount = amount ^ (key & UINT64_MASK);
  const encryptedBlinding = blinding ^ key;
  return { encryptedAmount, encryptedBlinding };
}

// Decrypt note data received from a StealthPayment event.
// XOR is its own inverse — decryption is identical to encryption.
//
//   key      = Poseidon(sharedPoint.x, sharedPoint.y)
//   amount   = encryptedAmount   XOR (key AND UINT64_MASK)
//   blinding = encryptedBlinding XOR key
export async function decryptNoteData(
  encryptedAmount: bigint,
  encryptedBlinding: bigint,
  sharedPointX: bigint,
  sharedPointY: bigint
): Promise<{ amount: bigint; blinding: bigint }> {
  const key = await deriveEncryptionKey(sharedPointX, sharedPointY);
  const amount = encryptedAmount ^ (key & UINT64_MASK);
  const blinding = encryptedBlinding ^ key;
  return { amount, blinding };
}
