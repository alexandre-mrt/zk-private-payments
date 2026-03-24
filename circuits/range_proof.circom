pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/bitify.circom";

// Proves that `value` is representable in `n` bits, i.e. 0 <= value < 2^n.
// Num2Bits constrains value = sum(bits[i] * 2^i) and each bit is 0 or 1.
template RangeProof(n) {
    signal input value;

    component bits = Num2Bits(n);
    bits.in <== value;
}
