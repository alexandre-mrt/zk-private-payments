import { ethers } from "ethers";

export interface DepositEvent {
  commitment: bigint;
  leafIndex: number;
  amount: bigint;
  timestamp: number;
  blockNumber: number;
  txHash: string;
}

export interface TransferEvent {
  nullifier: bigint;
  outputCommitment1: bigint;
  outputCommitment2: bigint;
  blockNumber: number;
  txHash: string;
}

export interface WithdrawalEvent {
  nullifier: bigint;
  amount: bigint;
  recipient: string;
  changeCommitment: bigint;
  blockNumber: number;
  txHash: string;
}

export interface PoolStats {
  totalDeposits: number;
  totalTransfers: number;
  totalWithdrawals: number;
  poolBalance: bigint;
}

// Minimal ABI for event querying — matches ConfidentialPool.sol exactly
const POOL_EVENTS_ABI = [
  "event Deposit(uint256 indexed commitment, uint32 leafIndex, uint256 amount, uint256 timestamp)",
  "event Transfer(uint256 indexed nullifier, uint256 outputCommitment1, uint256 outputCommitment2)",
  "event Withdrawal(uint256 indexed nullifier, uint256 amount, address recipient, uint256 changeCommitment)",
] as const;

export class EventIndexer {
  private readonly contract: ethers.Contract;
  private readonly provider: ethers.Provider;
  private readonly fromBlock: number;

  constructor(poolAddress: string, provider: ethers.Provider, fromBlock = 0) {
    this.contract = new ethers.Contract(poolAddress, POOL_EVENTS_ABI, provider);
    this.provider = provider;
    this.fromBlock = fromBlock;
  }

  async getDeposits(): Promise<DepositEvent[]> {
    const filter = this.contract.filters.Deposit();
    const events = await this.contract.queryFilter(filter, this.fromBlock);
    return events.map((e) => {
      const log = this.contract.interface.parseLog(e);
      if (!log) throw new Error("Failed to parse Deposit event");
      return {
        commitment: BigInt(log.args[0].toString()),
        leafIndex: Number(log.args[1]),
        amount: BigInt(log.args[2].toString()),
        timestamp: Number(log.args[3]),
        blockNumber: e.blockNumber,
        txHash: e.transactionHash,
      };
    });
  }

  async getTransfers(): Promise<TransferEvent[]> {
    const filter = this.contract.filters.Transfer();
    const events = await this.contract.queryFilter(filter, this.fromBlock);
    return events.map((e) => {
      const log = this.contract.interface.parseLog(e);
      if (!log) throw new Error("Failed to parse Transfer event");
      return {
        nullifier: BigInt(log.args[0].toString()),
        outputCommitment1: BigInt(log.args[1].toString()),
        outputCommitment2: BigInt(log.args[2].toString()),
        blockNumber: e.blockNumber,
        txHash: e.transactionHash,
      };
    });
  }

  async getWithdrawals(): Promise<WithdrawalEvent[]> {
    const filter = this.contract.filters.Withdrawal();
    const events = await this.contract.queryFilter(filter, this.fromBlock);
    return events.map((e) => {
      const log = this.contract.interface.parseLog(e);
      if (!log) throw new Error("Failed to parse Withdrawal event");
      return {
        nullifier: BigInt(log.args[0].toString()),
        amount: BigInt(log.args[1].toString()),
        recipient: log.args[2] as string,
        changeCommitment: BigInt(log.args[3].toString()),
        blockNumber: e.blockNumber,
        txHash: e.transactionHash,
      };
    });
  }

  // Get all commitments in Merkle tree insertion order.
  //
  // Deposits carry an explicit leafIndex, so they are sorted by that field.
  // Transfer output commitments and non-zero withdrawal change commitments are
  // appended after all deposits, sorted by blockNumber.
  //
  // NIGHT-SHIFT-REVIEW: insertion order for transfers/withdrawals within the
  // same block is ambiguous here (no leafIndex in those events). For a
  // fully correct Merkle path reconstruction the caller should use the
  // on-chain nextIndex state or reconstruct from a full event log with
  // log-index ordering. This implementation is correct for single-block-per-tx
  // workloads and should be validated against on-chain root before generating
  // proofs.
  async getAllCommitments(): Promise<bigint[]> {
    const [deposits, transfers, withdrawals] = await Promise.all([
      this.getDeposits(),
      this.getTransfers(),
      this.getWithdrawals(),
    ]);

    const sorted = [...deposits].sort((a, b) => a.leafIndex - b.leafIndex);
    const commitments: bigint[] = sorted.map((d) => d.commitment);

    // Transfer outputs, ordered by block number
    const transfersSorted = [...transfers].sort((a, b) => a.blockNumber - b.blockNumber);
    for (const t of transfersSorted) {
      commitments.push(t.outputCommitment1);
      commitments.push(t.outputCommitment2);
    }

    // Non-zero withdrawal change commitments, ordered by block number
    const withdrawalsSorted = [...withdrawals].sort((a, b) => a.blockNumber - b.blockNumber);
    for (const w of withdrawalsSorted) {
      if (w.changeCommitment !== 0n) {
        commitments.push(w.changeCommitment);
      }
    }

    return commitments;
  }

  // Return the set of nullifiers that have been spent (Transfer + Withdrawal).
  async getSpentNullifiers(): Promise<Set<bigint>> {
    const [transfers, withdrawals] = await Promise.all([
      this.getTransfers(),
      this.getWithdrawals(),
    ]);

    const spent = new Set<bigint>();
    for (const t of transfers) spent.add(t.nullifier);
    for (const w of withdrawals) spent.add(w.nullifier);
    return spent;
  }

  async getPoolStats(): Promise<PoolStats> {
    const [deposits, transfers, withdrawals, balance] = await Promise.all([
      this.getDeposits(),
      this.getTransfers(),
      this.getWithdrawals(),
      this.provider.getBalance(await this.contract.getAddress()),
    ]);

    return {
      totalDeposits: deposits.length,
      totalTransfers: transfers.length,
      totalWithdrawals: withdrawals.length,
      poolBalance: balance,
    };
  }
}
