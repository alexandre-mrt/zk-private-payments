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

// Derive ephemeral keypair and stealth pubkey for an announcement
export async function deriveStealthKeypair(
  recipientViewingPubKeyX: bigint,
  recipientViewingPubKeyY: bigint
): Promise<{
  ephemeralPrivKey: bigint;
  ephemeralPubKeyX: bigint;
  ephemeralPubKeyY: bigint;
  stealthPubKeyX: bigint;
  stealthPubKeyY: bigint;
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
  const sharedX = poseidon.F.toObject(poseidon([F.toObject(sharedPoint[0])]));

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
  };
}
