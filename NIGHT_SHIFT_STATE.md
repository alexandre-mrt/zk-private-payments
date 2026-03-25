## Night Shift State

### Timing
- Started: 2026-03-24T23:45:00+01:00
- Finished: (in progress)

### Stats (live)
- ZK Mixer: 126 tests, ~5,800 LOC, 40 commits
- ZK Private Payments: 224 tests, ~11,500 LOC, 57 commits
- Puppeteer E2E: 5 visual tests
- Combined: 355 tests, ~17,300 LOC, 97 commits

### Completed (all)
- M1-M4: Mixer code review fixes
- P1-P7: Full stack private payments
- P-FIX: Circuit/frontend/CLI alignment
- S1-S23: E2E tests, security, CI, NatSpec, CLI polish, multi-denomination, relayer fees, withdrawal limits, emergency drain, batch deposit, view functions, history views, local setup, contract size checks, EventIndexer caching
- S24: Multi-denomination support
- S25: Compliance allowlist
- S26: Min deposit age (flash loan protection)
- S27: Mixer cumulative stats + frontend
- S28: Chain ID replay protection (both)
- S29: Enhanced dashboard with all pool stats
- S30: Tree capacity/utilization view functions (both)
- S31: Root history query functions (both)
- S32: Edge case tests (307+ total)
- S33: Soulbound ERC721 deposit receipt (mixer)
- S34: Pool analytics (totalDeposited/Withdrawn/Transfers/uniqueDepositors)
- S35: Commitment-to-leafIndex mapping (both)
- S36: Node polyfills fix (both frontends now render in browser)
- S37: Withdrawal event in mixer history
- S38: Complete event history for private payments
- S39: 5 Puppeteer E2E visual tests
- S40: Code review — 5 critical bugs fixed (ABI mismatches, stealth derivation)
- S41: Important fixes (CLI tree reconstruction, leafIndex from event, nullifier validation)
- S42: Encrypted note broadcasting for stealth payments

### Pending
- [ ] S43: Add proper README.md for both projects
- [ ] S44: Add Hardhat gas reporter config to both projects
- [ ] S45: Add fuzz tests for Poseidon hash consistency between on-chain and off-chain
