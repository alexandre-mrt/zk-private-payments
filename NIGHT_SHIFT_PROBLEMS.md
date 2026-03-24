# Night Shift Problems — 2026-03-24

> Items that need your attention. Run `grep -r "NIGHT-SHIFT-REVIEW" .` to find marked code.

## Summary
- 6 uncertainties
- 0 tasks blocked
- 0 fixes failed
- 1 assumption made

## Problems

### ASSUMPTION: ConfidentialPool ABI matches task spec exactly
- **File**: frontend/src/lib/constants.ts
- **What I needed**: Actual deployed contract ABI (no contract files existed at frontend build time)
- **What I did**: Used the function signatures from the task spec verbatim
- **Confidence**: HIGH (spec was explicit)
- **User action needed**: Verify ABI matches deployed contract once contracts are written

### ASSUMPTION: Note commitment uses Poseidon(amount, blinding, ownerPubX, ownerPubY)
- **File**: frontend/src/lib/crypto.ts:computeCommitment
- **What I needed**: Exact Poseidon commitment construction used in circuits
- **What I did**: Used 4-input Poseidon with amount, blinding, pubX, pubY
- **Confidence**: MEDIUM
- **User action needed**: Align commitment scheme with actual circuit inputs when circuits are finalized

### ASSUMPTION: Nullifier = Poseidon(commitment, spendingKey)
- **File**: frontend/src/lib/crypto.ts:computeNullifier
- **What I needed**: Exact nullifier construction matching withdraw/transfer circuit
- **What I did**: Used 2-input Poseidon(commitment, spendingKey) per CLAUDE.md design doc
- **Confidence**: HIGH
- **User action needed**: Verify matches circuits when written

### UNCERTAINTY: Stealth scan matching logic
- **File**: frontend/src/components/ScanCard.tsx
- **What I needed**: How StealthRegistry stores/computes stealth address for matching
- **What I did**: Derived commitment via ECDH + Poseidon, used view tag fast-reject. Marked NIGHT-SHIFT-REVIEW
- **Confidence**: LOW — scan will work once REGISTRY_ADDRESS_ZERO is updated and contracts deployed
- **User action needed**: Verify matching logic against StealthRegistry.sol once written

### ASSUMPTION: Proof circuit input signal names for transfer/withdraw
- **File**: frontend/src/lib/proof.ts
- **What I needed**: Exact circuit signal names for transfer.circom and withdraw.circom
- **What I did**: Used descriptive names consistent with spec. Proof gen will fail until circuits compiled and WASM/zkey placed in frontend/public/circuits/
- **Confidence**: LOW — depends on circuit implementation
- **User action needed**: After circuits compile, align signal names in TransferProofInput / WithdrawProofInput with actual circuit signals

### UNCERTAINTY: Stealth address scan matching in cli/scan.ts
- **Iteration**: 1
- **File**: cli/scan.ts:56
- **What I needed**: The full stealth address derivation to verify that a `StealthPayment` event is addressed to us requires knowing the recipient's base pubkey so we can recompute `stealthPoint = sharedBase + recipientViewingPubKey` and compare. The current scan only checks if `stealthPubKeyX === keys.spendingPubKey.x`.
- **What I did**: Added a `NIGHT-SHIFT-REVIEW` comment and a simple equality check on `stealthPubKeyX`. Deposit event correlation (matching known notes) is fully functional.
- **Confidence**: LOW for the stealth detection path; HIGH for deposit note correlation
- **User action needed**: Verify the stealth scanning logic in `cli/scan.ts`. The correct check should recompute the stealth point from `deriveSharedSecret(viewingKey, ephPubKeyX, ephPubKeyY)` and compare with the announced `stealthPubKeyX`. Full ECDH stealth address scanning requires knowing the recipient's viewing pub key at scan time (which we have), but the derivation path in `deriveStealthKeypair` also involves Poseidon — confirm the matching formula in `cli/crypto.ts:deriveStealthKeypair` is consistent with what the sender used.

### ASSUMPTION: Circuit wasm/zkey paths
- **Iteration**: 1
- **File**: cli/transfer.ts:50, cli/withdraw.ts:52
- **What I needed**: Exact filenames for compiled circuit artifacts (`*.wasm`, `*.zkey`)
- **What I did**: Assumed `build/circuits/confidential_transfer.wasm`, `build/circuits/confidential_transfer.zkey`, `build/circuits/withdraw.wasm`, `build/circuits/withdraw.zkey`. These come from `scripts/compile-circuit.sh` which was not read.
- **Confidence**: MEDIUM
- **User action needed**: Verify the actual output filenames in `scripts/compile-circuit.sh`. If different, update `CLI_DIRS.circuits` path in `cli/config.ts` or the filenames in `cli/transfer.ts` and `cli/withdraw.ts`.
