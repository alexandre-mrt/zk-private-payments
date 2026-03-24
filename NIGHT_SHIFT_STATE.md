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
- [ ] M1: Add relayer as 5th public signal in circuit + contract + CLI + frontend + tests
- [ ] M2: Optimize CLI MerkleTree with incremental approach
- [ ] M3: Add MIXER_ADDRESS zero-address runtime check in frontend
- [ ] M4: Add event pagination in WithdrawCard.tsx

#### Part 2: ZK Private Payments (~/Desktop/zk-private-payments)
- [ ] P1: Scaffold project structure + dependencies
- [ ] P2: Circom circuits — stealth address (BabyJubjub ECDH), confidential transfer (Pedersen + range proof), note commitment
- [ ] P3: Circuit compilation scripts
- [ ] P4: Solidity contracts — StealthRegistry, ConfidentialPool, Verifier placeholder
- [ ] P5: Contract tests (Hardhat)
- [ ] P6: CLI with commander.js — keygen, register, deposit, scan, transfer, withdraw, balance
- [ ] P7: Frontend (React + wagmi + shadcn) — keygen, deposit, scan, transfer, withdraw
- [ ] P8: Final validation + code review + PR

### Last Checkpoint
(none)

### Last Validation
Build: N/A | Tests: N/A | Lint: N/A

### Completed This Session
(none yet)
