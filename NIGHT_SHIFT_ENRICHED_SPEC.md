# Night Shift Enriched Spec — 2026-03-24

## Two-part session

### Part 1: ZK Mixer fixes (30min)
Fix the 4 non-blocking suggestions from the code review on ~/Desktop/zk-mixer:

1. **Add `relayer` as 5th public signal** in the withdraw circuit (circuits/withdraw.circom) and Mixer.sol — prevents relayer front-running. Update IVerifier to accept uint256[5], update all call sites (contract, CLI, frontend, tests).

2. **Optimize CLI MerkleTree** (cli/merkle-tree.ts) — replace O(2^levels) allocations with an incremental approach that only stores populated nodes. The frontend already has a better implementation.

3. **Add MIXER_ADDRESS runtime check** in frontend/src/lib/constants.ts — throw if address is zero when used, so developers get an immediate error.

4. **Event pagination for frontend** — WithdrawCard.tsx fetches all events from block 0. Add pagination or at least a fromBlock parameter.

### Part 2: ZK Private Payments — new project (rest of the night)
Build a full-stack ZK Private Payments system at ~/Desktop/zk-private-payments.

#### Concept
Privacy-preserving payment system with:
- **Stealth addresses**: receivers generate ephemeral one-time addresses. Senders can pay without revealing who they're paying. Observers cannot link payments to recipients.
- **Confidential amounts**: payment amounts are hidden using Pedersen commitments. ZK range proofs ensure amounts are valid (non-negative, no overflow) without revealing the actual value.

#### Architecture

##### Crypto primitives (Circom circuits)
- **Stealth address generation**:
  - Receiver has (spending key, viewing key) keypair
  - Sender generates ephemeral key, computes shared secret via ECDH on Baby Jubjub
  - Stealth address = hash(shared_secret, spending_pubkey)
  - Receiver scans by trying to derive each stealth address with their viewing key
- **Confidential transfer circuit**:
  - Input: sender's note (amount, blinding factor, nullifier)
  - Output: two new notes (recipient note + change note)
  - Constraint: input_amount == output_amount_1 + output_amount_2 (balance preservation)
  - Pedersen commitment: C = amount * G + blinding * H
  - Range proof: amount in [0, 2^64) — use binary decomposition
  - Nullifier for input note (prevent double-spend)
  - Merkle proof for input note membership
- **Stealth address verification circuit**:
  - Proves the stealth address was correctly derived from the shared secret
  - Without revealing which viewing key was used

##### Smart contracts (Solidity + Hardhat)
- **StealthRegistry.sol**: Register viewing public keys. Emit events for stealth payments.
- **ConfidentialPool.sol**:
  - deposit(commitment, stealthAddress) — add a note commitment to the Merkle tree
  - transfer(proof, nullifier, newCommitments[2]) — spend a note, create 2 new notes
  - withdraw(proof, nullifier, amount, recipient) — exit to plaintext ETH
  - Uses Poseidon for Merkle tree (same pattern as mixer)
- **Verifier.sol**: Groth16 verifier (auto-generated)

##### CLI (TypeScript + Bun + Commander.js)
- `zk-pay keygen` — generate spending + viewing keypair
- `zk-pay register` — register viewing key on StealthRegistry
- `zk-pay deposit --amount <ETH> --to <stealth_pubkey>` — deposit with stealth address
- `zk-pay scan` — scan for incoming payments using viewing key
- `zk-pay transfer --note <id> --to <stealth_pubkey> --amount <ETH>` — confidential transfer
- `zk-pay withdraw --note <id> --amount <ETH> --to <address>` — withdraw to plaintext
- `zk-pay balance` — show total balance (scanned notes)

##### Frontend (React + Vite + wagmi + shadcn)
- Dark theme, same stack as mixer
- Pages: Keygen, Deposit, Scan/Balance, Transfer, Withdraw
- Client-side proof generation

##### Tech stack
- Circom 2.1.x + snarkjs (Groth16) + circomlib (Poseidon, BabyJubjub, ECDH)
- Hardhat + ethers.js
- Bun for CLI
- React + Vite + wagmi + viem + Tailwind + shadcn/ui

#### Key design decisions
- Baby Jubjub curve for stealth addresses (snark-friendly, circomlib has it)
- Pedersen commitments for amount hiding
- Binary decomposition range proofs (0 to 2^64)
- UTXO model: each payment creates note commitments
- Merkle tree depth 20 (same as mixer)
- 30 root history

## Clarifications from pre-flight
- **Location**: ~/Desktop/zk-private-payments
- **Scope**: Full stack — circuits + contracts + CLI + frontend
- **Duration**: All night (6-8h, ~30-40 iterations)
- **Priority**: Part 1 (mixer fixes) first, then Part 2 (private payments)
- **Stretch goals**: If time remains, add a "private DEX swap" feature
- **Testing**: Full coverage (contracts + circuits if circom available)
- **Deploy**: Local Hardhat + Sepolia-ready config
- **Package manager**: Bun
- **No AI/Claude mentions** in any code or commits
