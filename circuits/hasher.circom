pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

template Hasher2() {
    signal input in[2];
    signal output hash;

    component h = Poseidon(2);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    hash <== h.out;
}

template Hasher3() {
    signal input in[3];
    signal output hash;

    component h = Poseidon(3);
    h.inputs[0] <== in[0];
    h.inputs[1] <== in[1];
    h.inputs[2] <== in[2];
    hash <== h.out;
}

template HashLeftRight() {
    signal input left;
    signal input right;
    signal output hash;

    component h = Poseidon(2);
    h.inputs[0] <== left;
    h.inputs[1] <== right;
    hash <== h.out;
}
