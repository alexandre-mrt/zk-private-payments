# Night Shift Problems — 2026-03-24

> Items that need your attention. Run `grep -r "NIGHT-SHIFT-REVIEW" .` to find marked code.

## Summary
- 0 uncertainties remaining
- 0 tasks blocked
- 0 fixes failed
- 0 assumptions unresolved

## Resolved Problems

### RESOLVED: Note commitment scheme mismatch
- **Was**: Frontend used Poseidon(amount, blinding, pubX, pubY) — 4 inputs
- **Circuit uses**: Poseidon(amount, blinding, ownerPubKeyX) — 3 inputs
- **Fix**: Updated computeCommitment and createNote to use 3 inputs matching circuit

### RESOLVED: Proof signal names mismatch
- **Was**: Frontend used non-matching signal names (outRecipientPubX, changePubX, etc.)
- **Circuit uses**: ownerPubKeyXIn, ownerPubKeyXOut1, ownerPubKeyXOut2, etc.
- **Fix**: Rewrote proof.ts with exact circuit signal names, updated all components

### RESOLVED: Circuit artifact paths
- **Was**: CLI assumed flat paths (build/circuits/withdraw.wasm)
- **Actual**: Circom outputs to build/circuits/<name>/<name>_js/<name>.wasm
- **Fix**: Updated CLI transfer.ts, withdraw.ts, and frontend proof.ts with correct paths

### RESOLVED: Stealth scan matching logic
- **Was**: Simple X coordinate equality check (unreliable)
- **Fix**: Full ECDH derivation: sharedSecret → Poseidon(shared.x) → scalar*G + spendPubKey → compare X

### RESOLVED: ABI consistency
- Frontend ABIs verified against compiled contracts

### RESOLVED: Nullifier scheme
- Both CLI and frontend confirmed using Poseidon(commitment, spendingKey) matching circuits
