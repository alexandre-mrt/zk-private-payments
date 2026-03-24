pragma circom 2.1.0;

include "./note_commitment.circom";

// Deposit: compute a note commitment for a new note entering the pool.
// Used by the depositor to generate the commitment to insert into the Merkle tree.
template Deposit() {
    signal input amount;
    signal input blinding;
    signal input ownerPubKeyX;
    signal output commitment;

    component nc = NoteCommitment();
    nc.amount       <== amount;
    nc.blinding     <== blinding;
    nc.ownerPubKeyX <== ownerPubKeyX;
    commitment <== nc.commitment;
}

component main = Deposit();
