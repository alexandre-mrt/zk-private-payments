pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/babyjub.circom";
include "../node_modules/circomlib/circuits/escalarmulany.circom";
include "../node_modules/circomlib/circuits/escalarmulfix.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/poseidon.circom";

// Verifies that a stealth address was correctly derived.
//
// Protocol:
//   Sender generates ephemeral keypair (r, R = r*G).
//   Shared secret: S = r * V  (ECDH with receiver's viewing key V).
//   Stealth pubkey: P = hash(S.x) * G + SpendPubKey
//
// This circuit proves knowledge of ephemeral secret r such that:
//   1. R = r * G  (published ephemeral public key)
//   2. S = r * V  (shared secret via ECDH)
//   3. P = hash(S.x)*G + SpendPubKey  (stealth address derivation)
template StealthAddressVerifier() {
    // Public inputs
    signal input ephemeralPubKeyX;  // R.x
    signal input ephemeralPubKeyY;  // R.y
    signal input stealthPubKeyX;    // P.x (the stealth address X)
    signal input stealthPubKeyY;    // P.y (the stealth address Y)

    // Private inputs
    signal input ephemeralSecret;   // r (sender's ephemeral secret)
    signal input viewingPubKeyX;    // V.x (receiver's viewing public key)
    signal input viewingPubKeyY;    // V.y
    signal input spendPubKeyX;      // SpendPubKey.x (receiver's spending public key)
    signal input spendPubKeyY;      // SpendPubKey.y

    // BabyJubjub base point (verified from circomlib/babyjub.circom)
    var Bx = 5299619240641551281634865583518297030282874472190772894086521144482721001553;
    var By = 16950150798460657717958625567821834550301663161624707787222815936182638968203;

    // 1. Decompose ephemeral secret r into bits
    component rBits = Num2Bits(253);
    rBits.in <== ephemeralSecret;

    // 2. Verify R = r * G
    component rG = EscalarMulFix(253, [Bx, By]);
    for (var i = 0; i < 253; i++) {
        rG.e[i] <== rBits.out[i];
    }
    rG.out[0] === ephemeralPubKeyX;
    rG.out[1] === ephemeralPubKeyY;

    // 3. Compute shared secret S = r * V (ECDH)
    component rV = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) {
        rV.e[i] <== rBits.out[i];
    }
    rV.p[0] <== viewingPubKeyX;
    rV.p[1] <== viewingPubKeyY;
    // S = (rV.out[0], rV.out[1])

    // 4. Compute stealth key scalar = Poseidon(S.x, S.y)
    // Uses full shared secret point entropy (matches Tornado Cash Nova pattern)
    // Previously used Poseidon(S.x) only — less robust
    component stealthScalarHash = Poseidon(2);
    stealthScalarHash.inputs[0] <== rV.out[0]; // S.x
    stealthScalarHash.inputs[1] <== rV.out[1]; // S.y

    // 5. Decompose stealth scalar into bits
    component sBits = Num2Bits(253);
    sBits.in <== stealthScalarHash.out;

    // 6. Compute stealthScalar * G
    component sG = EscalarMulFix(253, [Bx, By]);
    for (var i = 0; i < 253; i++) {
        sG.e[i] <== sBits.out[i];
    }

    // 7. Stealth pubkey P = sG + SpendPubKey
    component add = BabyAdd();
    add.x1 <== sG.out[0];
    add.y1 <== sG.out[1];
    add.x2 <== spendPubKeyX;
    add.y2 <== spendPubKeyY;

    // 8. Verify result matches claimed stealth pubkey
    add.xout === stealthPubKeyX;
    add.yout === stealthPubKeyY;
}
