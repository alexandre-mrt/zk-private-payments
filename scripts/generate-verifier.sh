#!/bin/bash
set -e

CIRCUITS=("confidential_transfer" "withdraw" "stealth_address")
BUILD_DIR="build/circuits"

for CIRCUIT in "${CIRCUITS[@]}"; do
    ZKEY="$BUILD_DIR/$CIRCUIT/${CIRCUIT}_final.zkey"
    OUTPUT="contracts/verifiers/${CIRCUIT^}Verifier.sol"

    if [ ! -f "$ZKEY" ]; then
        echo "Skipping $CIRCUIT — zkey not found at $ZKEY"
        echo "Run: bash scripts/compile-circuit.sh first"
        continue
    fi

    mkdir -p contracts/verifiers
    echo "Generating verifier for $CIRCUIT..."
    npx snarkjs zkey export solidityverifier "$ZKEY" "$OUTPUT"

    # Fix pragma version (macOS-compatible sed with fallback for Linux)
    sed -i '' "s/pragma solidity ^0.6.11;/pragma solidity ^0.8.20;/" "$OUTPUT" 2>/dev/null || \
    sed -i "s/pragma solidity ^0.6.11;/pragma solidity ^0.8.20;/" "$OUTPUT"

    echo "Generated: $OUTPUT"
done

echo "Done! Verifier contracts in contracts/verifiers/"
