# Night Shift Problems — 2026-03-24

> Items that need your attention. Run `grep -r "NIGHT-SHIFT-REVIEW" .` to find marked code.

## Summary
- 1 uncertainty remaining (see below)
- 0 tasks blocked
- 0 fixes failed
- 0 assumptions unresolved

## Open Problems

### ASSUMPTION: getAllCommitments insertion order for transfers/withdrawals
- **File**: shared/indexer.ts (getAllCommitments)
- **What I needed**: Transfer and Withdrawal events do not carry a leafIndex, so the exact insertion order within the same block is unknown from logs alone.
- **What I did**: Sort transfer outputs and change commitments by blockNumber. Within the same block, ordering is undefined — this is correct for single-tx-per-block workloads (local dev) but may produce a wrong Merkle root on mainnet/testnet if multiple transactions land in the same block.
- **Confidence**: MEDIUM
- **User action needed**: Before using getAllCommitments for Merkle proof generation, verify the reconstructed root matches `pool.getLastRoot()`. If it does not, a full log-index-based sort (using transactionIndex + logIndex from the raw receipt) is needed.

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
