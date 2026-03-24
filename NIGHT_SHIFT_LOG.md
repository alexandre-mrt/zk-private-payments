## Night Shift Plan — 2026-03-24

### Objective
Two-part session:
1. Fix 4 non-blocking code review suggestions on zk-mixer (~30min)
2. Build a full-stack ZK Private Payments system with stealth addresses + confidential amounts (rest of night)

### Architecture — ZK Private Payments

```
zk-private-payments/
├── circuits/
│   ├── stealth_address.circom   # BabyJubjub ECDH + stealth derivation
│   ├── confidential_transfer.circom  # Pedersen commitments + range proof + balance check
│   ├── note_commitment.circom   # Note = Poseidon(amount, blinding, owner)
│   ├── range_proof.circom       # Binary decomposition range proof [0, 2^64)
│   ├── withdraw.circom          # Exit to plaintext ETH
│   └── hasher.circom            # Poseidon wrapper
├── contracts/
│   ├── StealthRegistry.sol      # Viewing key registry + stealth payment events
│   ├── ConfidentialPool.sol     # UTXO pool: deposit, transfer, withdraw
│   ├── MerkleTree.sol           # Incremental Merkle tree (reuse from mixer)
│   └── Verifier.sol             # Groth16 verifier
├── scripts/
│   ├── compile-circuit.sh
│   ├── generate-verifier.sh
│   └── deploy.ts
├── test/
│   ├── stealth.test.ts
│   └── pool.test.ts
├── cli/
│   ├── index.ts                 # keygen, register, deposit, scan, transfer, withdraw, balance
│   └── ...
├── frontend/
│   └── src/                     # React + wagmi + shadcn
└── hardhat.config.ts
```

### Crypto design

```
STEALTH ADDRESSES
=================
Receiver: (s, S=s*G) spending key, (v, V=v*G) viewing key
Sender generates ephemeral r, R=r*G
Shared secret: ss = ECDH(r, V) = r*V = r*v*G
Stealth address: P = Poseidon(ss) * G + S
Receiver scans: ss' = v*R, tries P' = Poseidon(ss') * G + S

CONFIDENTIAL NOTES (UTXO)
==========================
Note = { amount, blinding, owner_pubkey, index }
Commitment = Poseidon(amount, blinding, owner_pubkey)
NullifierHash = Poseidon(commitment, owner_privkey)

TRANSFER CIRCUIT
================
Public: root, nullifier, newCommitment1, newCommitment2
Private: amount_in, blinding_in, key_in, path, amount_out1, blinding_out1, owner_out1, amount_out2, blinding_out2, owner_out2
Constraints:
  1. commitment_in = Poseidon(amount_in, blinding_in, owner_in)
  2. nullifier = Poseidon(commitment_in, key_in)
  3. MerkleProof(commitment_in, root, path)
  4. amount_in == amount_out1 + amount_out2 (balance)
  5. RangeProof(amount_out1, 64 bits)
  6. RangeProof(amount_out2, 64 bits)
  7. newCommitment1 = Poseidon(amount_out1, blinding_out1, owner_out1)
  8. newCommitment2 = Poseidon(amount_out2, blinding_out2, owner_out2)
```

### Tasks (ordered by dependency)
1. [M1-M4] Mixer fixes — 4 targeted changes
2. [P1] Scaffold private payments project
3. [P2] Circom circuits — stealth + confidential + range proof
4. [P3] Compilation scripts
5. [P4] Solidity contracts
6. [P5] Contract tests
7. [P6] CLI
8. [P7] Frontend
9. [P8] Finalize

### Pre-made decisions
- BabyJubjub for stealth (circomlib native)
- Poseidon for all hashing (snark-friendly)
- UTXO model (like Zcash) for note management
- Pedersen commitments: C = amount*G + blinding*H on BabyJubjub
- Range proofs via binary decomposition (simple, proven)
- 64-bit amounts (sufficient for ETH with wei precision)
