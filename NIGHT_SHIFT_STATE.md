## Night Shift State

### Timing
- Started: 2026-03-24T23:45:00+01:00
- Finished: (in progress — stretch goals)

### Stats
- ZK Mixer: 78 tests, ~4,800 LOC, 32 commits
- ZK Private Payments: 155 tests, ~10,000 LOC, 42 commits
- Combined: 233 tests, ~15K LOC, 74 commits

### Completed

#### Part 1: ZK Mixer fixes
- [x] M1-M4: All code review fixes

#### Part 2: ZK Private Payments — Core
- [x] P1-P7: Full stack (circuits, contracts, tests, CLI, frontend)
- [x] P-FIX: All alignment fixes (commitment scheme, signals, paths, stealth scan)

#### Part 3: Stretch Goals
- [x] S1: E2E integration tests (real Poseidon)
- [x] S2: Mixer E2E tests (real Poseidon)
- [x] S3: CLI crypto/merkle/stealth unit tests
- [x] S4: Frontend polish (error boundary, skeletons, responsive, wallet check)
- [x] S5: EventIndexer shared module with caching
- [x] S6: Security hardening (ReentrancyGuard, Pausable, Ownable)
- [x] S7: Gas benchmarks
- [x] S8: GitHub Actions CI for both repos
- [x] S9: Multi-denomination support
- [x] S10: Code review
- [x] S11: NatSpec documentation
- [x] S12: Etherscan verification script
- [x] S13: CLI polish (help text, validation, errors)
- [x] S14: Relayer fee support in withdraw
- [x] S15: Withdrawal limits + emergency drain
- [x] S16: Batch deposit
- [x] S17: View functions (isSpent, isCommitted, getDepositCount, getPoolBalance)
- [x] S18: Transaction history views for both frontends
- [x] S19: Local setup scripts for both projects
- [x] S20: Mixer security hardening + NatSpec
- [x] S21: Mixer CLI polish
- [x] S22: Contract size checks in CI
- [x] S23: EventIndexer caching with TTL
