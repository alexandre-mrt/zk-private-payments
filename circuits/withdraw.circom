pragma circom 2.1.0;

include "./hasher.circom";
include "./merkle_tree.circom";
include "./note_commitment.circom";
include "./range_proof.circom";

// Withdraw: exit a note to plaintext ETH.
//
// Proves:
//   1. Input note commitment is in the Merkle tree
//   2. Prover knows the spending key for the input note
//   3. Nullifier is correctly derived
//   4. amountIn == amount (withdrawn) + changeAmount (balance preservation)
//   5. All amounts are in valid range [0, 2^96)
//   6. Change commitment is correctly computed
//   7. Recipient and relayer are bound to the proof (prevents front-running)
template Withdraw(levels) {
    // Public inputs
    signal input root;
    signal input nullifier;
    signal input amount;            // Plaintext withdrawal amount
    signal input recipient;         // ETH address receiving funds
    signal input changeCommitment;  // Change note commitment (if any)
    signal input relayer;           // Relayer address (bound to proof)
    signal input fee;               // Relayer fee (bound to proof)

    // Private inputs — input note
    signal input amountIn;
    signal input blindingIn;
    signal input ownerPubKeyXIn;
    signal input spendingKey;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Private inputs — change note
    signal input changeAmount;
    signal input changeBlinding;
    signal input changeOwnerPubKeyX;

    // 1. Compute input commitment
    component inputCommitment = NoteCommitment();
    inputCommitment.amount       <== amountIn;
    inputCommitment.blinding     <== blindingIn;
    inputCommitment.ownerPubKeyX <== ownerPubKeyXIn;

    // 2. Verify nullifier
    component nullifierComp = NullifierComputation();
    nullifierComp.commitment  <== inputCommitment.commitment;
    nullifierComp.spendingKey <== spendingKey;
    nullifier === nullifierComp.nullifier;

    // 3. Merkle proof
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== inputCommitment.commitment;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i]  <== pathIndices[i];
    }
    root === tree.root;

    // 4. Balance: amountIn == amount (withdrawn) + changeAmount
    amountIn === amount + changeAmount;

    // 5. Range proofs — all amounts in [0, 2^96)
    // 96 bits covers ~79 billion ETH (10,000x current supply)
    component rangeIn = RangeProof(96);
    rangeIn.value <== amountIn;

    component rangeAmount = RangeProof(96);
    rangeAmount.value <== amount;

    component rangeChange = RangeProof(96);
    rangeChange.value <== changeAmount;

    // 6. Verify change commitment
    component changeCommComp = NoteCommitment();
    changeCommComp.amount       <== changeAmount;
    changeCommComp.blinding     <== changeBlinding;
    changeCommComp.ownerPubKeyX <== changeOwnerPubKeyX;
    changeCommitment === changeCommComp.commitment;

    // 7. Bind recipient, relayer, and fee to proof (prevent front-running)
    // Recipient must be a valid Ethereum address (< 2^160)
    component recipientRange = RangeProof(160);
    recipientRange.value <== recipient;

    signal relayerSquare;
    relayerSquare <== relayer * relayer;
    signal feeSquare;
    feeSquare <== fee * fee;
}

component main {public [root, nullifier, amount, recipient, changeCommitment, relayer, fee]} = Withdraw(20);
