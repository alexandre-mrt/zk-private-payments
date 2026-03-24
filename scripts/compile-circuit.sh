#!/bin/bash
set -e

CIRCUITS=("confidential_transfer" "withdraw" "stealth_address")
BUILD_DIR="build/circuits"
PTAU_FILE="$BUILD_DIR/pot20_final.ptau"

mkdir -p "$BUILD_DIR"

# Download powers of tau if needed (pot20 for depth-20 Merkle trees)
if [ ! -f "$PTAU_FILE" ]; then
    echo "Downloading powers of tau (pot20)..."
    curl -L -o "$PTAU_FILE" "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau"
fi

for CIRCUIT in "${CIRCUITS[@]}"; do
    echo ""
    echo "========================================"
    echo "Compiling: $CIRCUIT"
    echo "========================================"

    CIRCUIT_DIR="$BUILD_DIR/$CIRCUIT"
    mkdir -p "$CIRCUIT_DIR"

    # Compile
    echo "Step 1: Compiling circuit..."
    circom "circuits/$CIRCUIT.circom" --r1cs --wasm --sym -o "$CIRCUIT_DIR"

    # Groth16 setup
    echo "Step 2: Groth16 setup..."
    npx snarkjs groth16 setup "$CIRCUIT_DIR/$CIRCUIT.r1cs" "$PTAU_FILE" "$CIRCUIT_DIR/${CIRCUIT}_0000.zkey"

    # Contribute to ceremony
    echo "Step 3: Contributing to ceremony..."
    npx snarkjs zkey contribute "$CIRCUIT_DIR/${CIRCUIT}_0000.zkey" "$CIRCUIT_DIR/${CIRCUIT}_final.zkey" --name="Dev contribution" -v -e="$(date +%s) random entropy for $CIRCUIT"

    # Export verification key
    echo "Step 4: Exporting verification key..."
    npx snarkjs zkey export verificationkey "$CIRCUIT_DIR/${CIRCUIT}_final.zkey" "$CIRCUIT_DIR/verification_key.json"

    # Clean up intermediate zkey
    rm -f "$CIRCUIT_DIR/${CIRCUIT}_0000.zkey"

    echo "Done: $CIRCUIT"
done

echo ""
echo "All circuits compiled successfully!"
echo "Artifacts in: $BUILD_DIR/"
