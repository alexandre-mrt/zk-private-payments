# ZK Private Payments

## Overview
Privacy-preserving payment system using zero-knowledge proofs. Combines stealth addresses (receiver privacy) with confidential amounts (Pedersen commitments + range proofs). UTXO-based note system.

## Stack
- **Circuits**: Circom 2.1.x + snarkjs (Groth16) + circomlib (Poseidon, BabyJubjub, ECDH)
- **Contracts**: Solidity + Hardhat + ethers.js
- **CLI**: TypeScript + Bun + Commander.js
- **Frontend**: React + Vite + wagmi + viem + Tailwind + shadcn/ui
- **Package manager**: Bun

## Structure
```
circuits/       — Circom circuits (stealth, transfer, range proof, withdraw)
contracts/      — Solidity (StealthRegistry, ConfidentialPool, MerkleTree, Verifier)
scripts/        — Circuit compilation + deploy scripts
test/           — Contract + circuit tests
cli/            — Commander.js CLI (keygen, register, deposit, scan, transfer, withdraw, balance)
frontend/       — React app with client-side proof generation
```

## Dev Commands
```bash
bun install
npx hardhat compile
npx hardhat test
npx hardhat node
npx hardhat run scripts/deploy.ts --network localhost
bun run cli/index.ts keygen
cd frontend && bun dev
```

## Crypto Design
- Stealth addresses: BabyJubjub ECDH, Poseidon-derived one-time addresses
- Notes: UTXO model, commitment = Poseidon(amount, blinding, owner)
- Nullifier = Poseidon(commitment, spending_key)
- Range proofs: binary decomposition [0, 2^64)
- Merkle tree depth 20, 30 root history
