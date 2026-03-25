# Security Model — ZK Private Payments

## Smart Contract Security

### Access Control

| Role   | Capabilities |
|--------|-------------|
| Owner  | `pause()`, `unpause()`, `addDenomination()`, `removeDenomination()`, `setMaxWithdrawAmount()`, `setMinDepositAge()`, `setAllowlistEnabled()`, `setAllowlisted()`, `batchSetAllowlisted()`, `emergencyDrain()` (paused only) |
| Anyone | `deposit()`, `batchDeposit()`, `transfer()`, `withdraw()` with a valid ZK proof (subject to allowlist) |

### Reentrancy Protection

`ReentrancyGuard` (`nonReentrant`) is applied to `deposit`, `batchDeposit`, `transfer`, and
`withdraw`. In `withdraw`, all state mutations occur before any ETH transfer
(checks-effects-interactions):

```
nullifiers[_nullifier] = true           // state write
totalWithdrawn += _amount               // state write
withdrawalCount++                       // state write
_insert(_changeCommitment)              // state write (change note)
_recipient.call{value: recipientAmount} // ETH transfer (last)
_relayer.call{value: _fee}              // ETH transfer (last)
```

### Replay and Double-Spend Protection

- `deployedChainId` stored at construction, checked by `onlyDeployedChain` on every pool
  operation. Prevents cross-chain replays of commitments or proofs.
- `nullifiers` mapping: once a nullifier is marked spent, the same proof can never be replayed.
  Nullifier = `Poseidon(commitment, spendingKey)` is derived from private inputs and never
  revealed on-chain other than as an opaque hash.
- `commitments` mapping: prevents duplicate insertion of the same commitment.

### Root Staleness

The Merkle tree maintains a ring buffer of the last `ROOT_HISTORY_SIZE` roots. Proofs
generated against any of these roots remain valid, providing in-flight tolerance for concurrent
deposits.

---

## Stealth Address Privacy Model

The `StealthRegistry` contract implements a BabyJubjub ECDH-based stealth address scheme:

1. Recipient generates a long-lived spending key pair `(s, S = s·G)` and viewing key pair
   `(v, V = v·G)` on the BabyJubjub curve, then publishes `V` via `registerViewingKey`.
2. Sender generates a per-payment ephemeral key pair `(e, E = e·G)` and derives a one-time
   stealth key: `shared = Poseidon(e·V)`, `P = shared·G + S`.
3. Sender deposits into `ConfidentialPool` using a commitment that encodes `P.x` as the
   owner key, then calls `announceStealthPayment(commitment, E, P, encryptedAmount, encryptedBlinding)`.
4. Recipients scan `StealthPayment` events off-chain, compute `shared = Poseidon(v·E)`, then
   check whether `shared·G + S == P`. If it matches, the note belongs to them. They decrypt
   the note data using the shared key: `amount = encryptedAmount XOR key[0..8]`,
   `blinding = encryptedBlinding XOR key`, where `key = Poseidon(v·E.x, v·E.y)`.

**Separation of keys**: the viewing key `v` allows scanning for incoming notes without
spending ability. The spending key `s` is required to generate withdrawal proofs. This
enables watch-only wallets and delegated scanning.

**What is public**: the ephemeral public key `E` and the one-time stealth public key `P` are
broadcast in clear on-chain. An observer who does not know `v` cannot determine which
Ethereum address `P` corresponds to. The `encryptedAmount` and `encryptedBlinding` fields are
XOR-encrypted with a Poseidon-derived shared key; they are not confidential against an attacker
who knows the shared secret (i.e., anyone who knows either `e` or `v`).

---

## UTXO Model Security

Each deposit creates one note (UTXO) whose on-chain identity is a Poseidon commitment:

```
commitment = Poseidon(amount, blinding, ownerPubKeyX)
nullifier  = Poseidon(commitment, spendingKey)
```

Three pool operations:

- **deposit**: converts plaintext ETH into one commitment inserted in the Merkle tree.
- **transfer**: spends one input note (reveals its nullifier), creates two output notes. No ETH
  leaves the pool. The circuit enforces `amountIn == amountOut1 + amountOut2` (value conservation)
  and all amounts are range-checked to `[0, 2^64)`.
- **withdraw**: spends one input note, extracts a plaintext ETH amount, optionally creates a
  change note. The circuit enforces `amountIn == amount + changeAmount` and range-checks all
  three values.

**Amount confidentiality**: amounts are hidden inside commitments. On-chain, only the nullifier
(opaque hash) and output commitments are visible during a transfer. The withdrawal amount is
a public circuit signal and is therefore visible on-chain.

---

## Encrypted Note Broadcasting

`announceStealthPayment` emits a `StealthPayment` event with XOR-encrypted note data. Key
properties:

- **Encryption**: XOR with a 256-bit key derived as `Poseidon(sharedPoint.x, sharedPoint.y)`.
  XOR-based encryption is not semantically secure against chosen-plaintext attacks. However,
  each payment uses a fresh ephemeral key, so keys are not reused across payments.
- **Integrity**: there is no MAC or AEAD tag. A malicious sender could broadcast corrupted
  encrypted data. Recipients must verify that the decrypted commitment matches the one in the
  pool. If it does not, the note is either corrupted or not theirs.
- **Non-repudiation**: the announcement is on-chain and immutable, but `announceStealthPayment`
  has no access control. Anyone can emit a `StealthPayment` event for any commitment. Receivers
  must always verify the announced commitment exists in the tree.

---

## Allowlist Compliance Features

When `allowlistEnabled` is `true`, only addresses in `allowlisted` may call `deposit` or
`batchDeposit`. Withdrawals and transfers are not gated.

Admin controls:

- `setAllowlistEnabled(bool)` — toggle the allowlist on or off.
- `setAllowlisted(address, bool)` — add or remove a single address.
- `batchSetAllowlisted(address[], bool)` — bulk update.

**Limitation**: the allowlist controls who can enter the pool, not who can exit. It can be
used to implement basic KYC at the deposit layer, but it does not prevent allowlisted addresses
from transferring funds to non-allowlisted stealth addresses inside the pool.

---

## Multi-Denomination Considerations

When `denominationList` is non-empty, every deposit must match an allowed denomination exactly.
This enforces a uniform anonymity set per denomination.

When the list is empty, any non-zero deposit amount is accepted. Mixed-denomination pools
reduce the anonymity set because the deposit amount partially identifies the note, potentially
enabling correlation with the plaintext withdrawal amount.

Removing a denomination (`removeDenomination`) marks it as disallowed for future deposits but
does not affect existing notes of that denomination. The denomination remains in
`denominationList` (for enumeration) with `allowedDenominations[d] == false`.

---

## Additional Security Controls

### Minimum Deposit Age

`minDepositAge` (in blocks) requires a cooling-off period between the last deposit and any
withdrawal. This prevents flash-loan-style same-block deposit-and-withdraw attacks. Set to 0
(default) to disable. Note: the check is pool-wide against the last deposit block, not
per-note.

### Maximum Withdrawal Amount

`maxWithdrawAmount` caps the ETH that can be withdrawn in a single transaction. This limits
the damage window if a compromised spending key is used.

### Emergency Drain

`emergencyDrain(address payable _to)` transfers the entire pool balance to a designated
address. It is only callable by the owner when the contract is paused. This is the last-resort
recovery mechanism for critical bugs. Users should be aware that the owner retains this power
and assess their trust in the deployer accordingly.

---

## Known Limitations

### Verifier Placeholders

Both `TransferVerifier.sol` and `WithdrawVerifier.sol` are **placeholders that always return
`true`** on Hardhat (chain ID 31337) and revert on any other network. They must be replaced
with snarkjs-generated verifiers before any non-local deployment. Without real verifiers, the
contract provides no ZK security guarantees.

### Relayer Not Bound by Proof

The `_relayer` and `_fee` parameters in `withdraw` are **not included in the circuit public
signals**. This means the transaction submitter could modify them without invalidating the ZK
proof. Users must trust the relayer they select. In production, `relayer` and `fee` should be
added as public signals (as implemented in zk-mixer) to bind them cryptographically.

See: `// NIGHT-SHIFT-REVIEW` comment in `ConfidentialPool.sol` line 607.

### Trusted Setup

Groth16 requires a trusted setup ceremony for each circuit. The security of the proof system
depends on at least one participant being honest. No public ceremony has been run for these
circuits.

### Stealth Address Key Management

The spending key is a BabyJubjub scalar stored client-side. Loss of the spending key means
permanent loss of all notes whose commitments encode the corresponding public key. There is no
on-chain recovery mechanism.

### XOR Encryption Limitations

The encrypted note data in `StealthPayment` events uses XOR with a Poseidon-derived key. This
is not an authenticated encryption scheme. Recipients must verify decrypted data against the
on-chain commitment before treating it as valid.

### Frontend / Client Security

- Note data (amounts, blinding factors, spending keys) is stored client-side. XSS can
  compromise all stored notes.
- No server stores private data. Loss of client state means loss of funds.

---

## Circuit Security

- `commitment = Poseidon(amount, blinding, ownerPubKeyX)` — Poseidon over BN254.
- `nullifier = Poseidon(commitment, spendingKey)` — private inputs; only the hash is public.
- Range proofs use binary decomposition (`Num2Bits(64)`) from circomlib, constraining all
  amounts to `[0, 2^64)`. This is complete and sound for Circom's constraint system.
- The withdraw circuit binds `recipient` as a public signal via a squaring constraint
  (`recipientSquare <== recipient * recipient`), preventing front-running by tying the
  proof to a specific recipient address.
- The stealth circuit proves knowledge of ephemeral secret `r` such that `R = r·G` and
  `P = Poseidon(r·V)·G + S` using circomlib's `EscalarMulFix` (fixed base) and
  `EscalarMulAny` (variable base) over BabyJubjub.

---

## Upgrade Path

Contracts are **not upgradeable** (no proxy, no `delegatecall`). This is intentional for
trust minimisation.

To deploy an improved version:

1. Deploy new contracts with production verifiers.
2. Announce the new address publicly.
3. Users withdraw from the old pool and deposit into the new one.

There is no automated migration mechanism. Funds in the old contract remain accessible as
long as users hold their spending keys and the old contract exists on-chain.

---

## Reporting Vulnerabilities

Do not open a public GitHub issue for security vulnerabilities. Contact the maintainer directly
before disclosure.
