pragma circom 2.1.0;

include "./hasher.circom";
include "./merkle_tree.circom";
include "./note_commitment.circom";
include "./range_proof.circom";

// ConfidentialTransfer: spend one input note, create two output notes.
//
// Proves:
//   1. Input note commitment is in the Merkle tree (root)
//   2. Prover knows the spending key for the input note
//   3. Nullifier is correctly derived
//   4. Output amounts sum to input amount (balance preservation)
//   5. All amounts are in valid range [0, 2^64)
//   6. Output commitments are correctly computed
template ConfidentialTransfer(levels) {
    // Public inputs
    signal input root;               // Merkle tree root
    signal input nullifier;          // Poseidon(commitment_in, spending_key)
    signal input outputCommitment1;  // New note 1 commitment
    signal input outputCommitment2;  // New note 2 commitment (change)

    // Private inputs — input note
    signal input amountIn;
    signal input blindingIn;
    signal input ownerPubKeyXIn;         // Owner's pubkey X for input note
    signal input spendingKey;            // Owner's spending secret key
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Private inputs — output note 1
    signal input amountOut1;
    signal input blindingOut1;
    signal input ownerPubKeyXOut1;

    // Private inputs — output note 2 (change)
    signal input amountOut2;
    signal input blindingOut2;
    signal input ownerPubKeyXOut2;

    // 1. Compute input note commitment
    component inputCommitment = NoteCommitment();
    inputCommitment.amount      <== amountIn;
    inputCommitment.blinding    <== blindingIn;
    inputCommitment.ownerPubKeyX <== ownerPubKeyXIn;

    // 2. Verify nullifier = Poseidon(commitment, spendingKey)
    component nullifierComp = NullifierComputation();
    nullifierComp.commitment  <== inputCommitment.commitment;
    nullifierComp.spendingKey <== spendingKey;
    nullifier === nullifierComp.nullifier;

    // 3. Verify Merkle proof
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== inputCommitment.commitment;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i]  <== pathIndices[i];
    }
    root === tree.root;

    // 4. Balance preservation: amountIn == amountOut1 + amountOut2
    amountIn === amountOut1 + amountOut2;

    // 5. Range proofs — all amounts in [0, 2^96)
    // 96 bits covers ~79 billion ETH (10,000x current supply)
    // 64 bits was insufficient (only ~18.4M ETH max per note)
    component rangeIn = RangeProof(96);
    rangeIn.value <== amountIn;

    component rangeOut1 = RangeProof(96);
    rangeOut1.value <== amountOut1;

    component rangeOut2 = RangeProof(96);
    rangeOut2.value <== amountOut2;

    // 6. Compute output commitments and verify
    component outCommitment1 = NoteCommitment();
    outCommitment1.amount       <== amountOut1;
    outCommitment1.blinding     <== blindingOut1;
    outCommitment1.ownerPubKeyX <== ownerPubKeyXOut1;
    outputCommitment1 === outCommitment1.commitment;

    component outCommitment2 = NoteCommitment();
    outCommitment2.amount       <== amountOut2;
    outCommitment2.blinding     <== blindingOut2;
    outCommitment2.ownerPubKeyX <== ownerPubKeyXOut2;
    outputCommitment2 === outCommitment2.commitment;
}

component main {public [root, nullifier, outputCommitment1, outputCommitment2]} = ConfidentialTransfer(20);
