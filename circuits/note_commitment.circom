pragma circom 2.1.0;

include "./hasher.circom";

// NoteCommitment: commitment = Poseidon(amount, blinding, ownerPubKeyX)
// ownerPubKeyX is the X coordinate of the owner's public key on BabyJubjub.
template NoteCommitment() {
    signal input amount;
    signal input blinding;
    signal input ownerPubKeyX;
    signal output commitment;

    component h = Hasher3();
    h.in[0] <== amount;
    h.in[1] <== blinding;
    h.in[2] <== ownerPubKeyX;
    commitment <== h.hash;
}

// NullifierComputation: nullifier = Poseidon(commitment, spendingKey)
template NullifierComputation() {
    signal input commitment;
    signal input spendingKey;
    signal output nullifier;

    component h = Hasher2();
    h.in[0] <== commitment;
    h.in[1] <== spendingKey;
    nullifier <== h.hash;
}
