## Night Shift State

### Timing
- Started: 2026-03-24T23:45:00+01:00
- Finished: (in progress)

### Spec
NIGHT_SHIFT_ENRICHED_SPEC.md

### Current Phase
Execution

### Tasks

#### Part 1: ZK Mixer fixes (~/Desktop/zk-mixer)
- [x] M1: Add relayer as 5th public signal in circuit + contract + CLI + frontend + tests
- [x] M2: Optimize CLI MerkleTree with incremental approach
- [x] M3: Add MIXER_ADDRESS zero-address runtime check in frontend
- [x] M4: Add event pagination in WithdrawCard.tsx

#### Part 2: ZK Private Payments (~/Desktop/zk-private-payments)
- [x] P1: Scaffold project structure + dependencies
- [x] P2: Circom circuits — stealth address, confidential transfer, withdraw, note commitment, range proof, deposit
- [x] P3: Circuit compilation scripts + deploy script + hasher helper
- [ ] P4: Solidity contracts — StealthRegistry, ConfidentialPool, Verifier placeholder
- [ ] P5: Contract tests (Hardhat)
- [ ] P6: CLI with commander.js — keygen, register, deposit, scan, transfer, withdraw, balance
- [ ] P7: Frontend (React + wagmi + shadcn) — keygen, deposit, scan, transfer, withdraw
- [ ] P8: Final validation + code review + PR

### Last Checkpoint
88eb90e — chore: scaffold project structure and dependencies

### Last Validation
Build: PASS (hardhat compile + frontend build) | Tests: N/A | Lint: N/A

### Completed This Session
- M1: Relayer as 5th public signal (circuit, contract, CLI, frontend, tests)
- M2: Optimized CLI MerkleTree (incremental layers instead of 2^20 allocations)
- M3: getMixerAddress() runtime check for zero address
- M4: DEPLOY_BLOCK constant for event pagination
- P1: Scaffold project structure (package.json, hardhat.config.ts, tsconfig.json, .gitignore, .env.example, directories, frontend with Vite+Tailwind+wagmi+shadcn)
