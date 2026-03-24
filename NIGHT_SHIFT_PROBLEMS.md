# Night Shift Problems — 2026-03-24

> Items that need your attention. Run `grep -r "NIGHT-SHIFT-REVIEW" .` to find marked code.

## Summary
- 1 uncertainty
- 0 tasks blocked
- 0 fixes failed
- 1 assumption made

## Problems

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
