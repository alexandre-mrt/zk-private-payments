pragma circom 2.1.0;

include "./hasher.circom";

// Selects between (in[0], in[1]) based on s:
//   s=0 => out = [in[0], in[1]]
//   s=1 => out = [in[1], in[0]]
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// Verifies that `leaf` is in a Merkle tree of depth `levels` with root `root`.
// pathElements[i] is the sibling at level i, pathIndices[i] is 0 (left) or 1 (right).
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component selectors[levels];
    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        selectors[i].in[0] <== i == 0 ? leaf : hashers[i - 1].hash;
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s     <== pathIndices[i];

        hashers[i] = HashLeftRight();
        hashers[i].left  <== selectors[i].out[0];
        hashers[i].right <== selectors[i].out[1];
    }

    root <== hashers[levels - 1].hash;
}
