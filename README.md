# ZK Private Payments

Privacy-preserving payment system with stealth addresses and confidential amounts. Built with Circom zero-knowledge proofs on Ethereum.

## Features

- **Stealth Addresses**: BabyJubjub ECDH — receivers generate one-time addresses, senders pay without revealing who they are paying
- **Confidential Amounts**: Pedersen commitments with ZK range proofs — amounts hidden, only balance preservation is verified
- **UTXO Model**: Notes are created on deposit, split on transfer, consumed on withdrawal
- **Encrypted Notes**: Stealth payment announcements include encrypted note data for receiver discovery

## Architecture

```
circuits/       8 Circom circuits (stealth, transfer, withdraw, range proofs)
contracts/      5 Solidity contracts (ConfidentialPool, StealthRegistry, MerkleTree, verifiers)
cli/            TypeScript CLI (keygen, deposit, scan, transfer, withdraw, balance)
frontend/       React + wagmi + Tailwind + shadcn/ui (7 views)
shared/         EventIndexer with caching
test/           224 Hardhat tests
scripts/        Deploy, verify, compile, local setup
```

```
  Sender                              Receiver
    |                                    |
    | (spending_key, viewing_key)        | (spending_key, viewing_key)
    |         on BabyJubjub              |         on BabyJubjub
    |                                    |
    | ephemeral_key (random)             |
    | shared_secret = ECDH(eph, view_pub)|
    | stealth_addr = Poseidon(ss.x)*G    |
    |               + spending_pub       |
    |                                    |
    | deposit(commitment, stealth_addr)  |
    | commitment = Poseidon(amount,      |
    |              blinding, ownerPubX)  |
    |                                    |
    +---- announcement (encrypted) ----->|
                                         | scan: try ECDH with viewing_key
                                         | decrypt note if match found
                                         | nullifier = Poseidon(commitment, sk)
                                         | transfer / withdraw with ZK proof
```

## Crypto Design

```
STEALTH ADDRESSES
  Receiver keypairs: (spending_key, viewing_key) on BabyJubjub curve
  Sender:  ephemeral_key
           shared_secret = ECDH(ephemeral_key, viewing_pub)
           stealth_address = Poseidon(shared_secret.x) * G + spending_pub

CONFIDENTIAL NOTES (UTXO)
  commitment  = Poseidon(amount, blinding, ownerPubKeyX)
  nullifier   = Poseidon(commitment, spendingKey)

TRANSFER CIRCUIT
  Proves:      input_amount == output1 + output2  (balance preserved)
  Range proof: amounts in [0, 2^64) via binary decomposition
  Merkle proof: commitment is in the tree
```

## Quick Start

```bash
# Install
bun install

# Run tests
npx hardhat test

# Local deployment
bash scripts/local-setup.sh

# CLI
bun run cli/index.ts keygen
bun run cli/index.ts deposit --amount 1
bun run cli/index.ts scan
bun run cli/index.ts transfer --note <commitment> --to <pubKeyX> --amount 0.5
bun run cli/index.ts withdraw --note <commitment> --amount 0.5 --to <address>
bun run cli/index.ts balance

# Frontend
cd frontend && bun install && bun dev
```

## Smart Contract Features

- Multi-denomination support (owner-managed denomination set)
- Relayer fee system for gasless withdrawals
- Batch deposits (up to 10 notes per tx)
- Compliance allowlist (optional depositor restrictions)
- Minimum deposit age (flash loan protection)
- Maximum withdrawal amount (rate limiting)
- Emergency drain (owner-only, when paused)
- Chain ID replay protection
- OpenZeppelin: ReentrancyGuard, Pausable, Ownable

## Tests

```bash
npx hardhat test                  # 224 tests
npx hardhat test --grep E2E       # E2E with real Poseidon
npx hardhat test --grep Gas       # Gas benchmarks
npx hardhat test --grep Security  # Security tests
```

## Tech Stack

| Component  | Technology                                           |
|------------|------------------------------------------------------|
| Circuits   | Circom 2.1 + snarkjs (Groth16) + circomlib           |
| Contracts  | Solidity 0.8.20 + Hardhat + OpenZeppelin             |
| CLI        | TypeScript + Commander.js + circomlibjs              |
| Frontend   | React + Vite + wagmi + shadcn/ui                     |
| Crypto     | Poseidon hash, BabyJubjub (ECDH), Pedersen commitments |

## License

MIT
