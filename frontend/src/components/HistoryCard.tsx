import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatEther, parseAbiItem } from "viem";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { POOL_ABI, DEPLOY_BLOCK } from "@/lib/constants";

const POOL_ADDRESS_ZERO =
  "0x0000000000000000000000000000000000000000" as `0x${string}`;
const IS_DEPLOYED =
  POOL_ADDRESS_ZERO !== "0x0000000000000000000000000000000000000000";

const MAX_HISTORY_ENTRIES = 30;

type EventType = "Deposit" | "Transfer" | "Withdrawal";

type HistoryEntry =
  | {
      type: "Deposit";
      blockNumber: bigint;
      commitment: string;
      leafIndex: number;
      timestamp: string;
    }
  | {
      type: "Transfer";
      blockNumber: bigint;
      nullifier: string;
      outCommitment1: string;
      outCommitment2: string;
    }
  | {
      type: "Withdrawal";
      blockNumber: bigint;
      nullifier: string;
      amount: string;
      recipient: string;
    };

function truncateHex(hex: string, chars = 8): string {
  const clean = hex.startsWith("0x") ? hex : `0x${hex}`;
  if (clean.length <= chars * 2 + 2) return clean;
  return `${clean.slice(0, chars + 2)}...${clean.slice(-4)}`;
}

function bigintToHex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function fetchHistory(
  client: ReturnType<typeof usePublicClient>,
): Promise<HistoryEntry[]> {
  if (!client) return [];

  const [depositLogs, transferLogs, withdrawalLogs] = await Promise.all([
    client.getLogs({
      address: POOL_ADDRESS_ZERO,
      event: parseAbiItem(
        "event Deposit(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
      ),
      fromBlock: DEPLOY_BLOCK,
      toBlock: "latest",
    }),
    client.getLogs({
      address: POOL_ADDRESS_ZERO,
      event: parseAbiItem(
        "event Transfer(uint256 indexed nullifier, uint256 outCommitment1, uint256 outCommitment2)",
      ),
      fromBlock: DEPLOY_BLOCK,
      toBlock: "latest",
    }),
    client.getLogs({
      address: POOL_ADDRESS_ZERO,
      event: parseAbiItem(
        "event Withdrawal(uint256 indexed nullifier, uint256 amount, address recipient, uint256 changeCommitment, address relayer, uint256 fee)",
      ),
      fromBlock: DEPLOY_BLOCK,
      toBlock: "latest",
    }),
  ]);

  const entries: HistoryEntry[] = [];

  for (const log of depositLogs) {
    const args = log.args as {
      commitment?: bigint;
      leafIndex?: number;
      timestamp?: bigint;
    };
    if (args.commitment === undefined) continue;
    entries.push({
      type: "Deposit",
      blockNumber: log.blockNumber ?? 0n,
      commitment: truncateHex(bigintToHex(args.commitment)),
      leafIndex: Number(args.leafIndex ?? 0),
      timestamp: args.timestamp
        ? new Date(Number(args.timestamp) * 1000).toLocaleString()
        : "—",
    });
  }

  for (const log of transferLogs) {
    const args = log.args as {
      nullifier?: bigint;
      outCommitment1?: bigint;
      outCommitment2?: bigint;
    };
    if (args.nullifier === undefined) continue;
    entries.push({
      type: "Transfer",
      blockNumber: log.blockNumber ?? 0n,
      nullifier: truncateHex(bigintToHex(args.nullifier)),
      outCommitment1: truncateHex(bigintToHex(args.outCommitment1 ?? 0n)),
      outCommitment2: truncateHex(bigintToHex(args.outCommitment2 ?? 0n)),
    });
  }

  for (const log of withdrawalLogs) {
    const args = log.args as {
      nullifier?: bigint;
      amount?: bigint;
      recipient?: string;
    };
    if (args.nullifier === undefined) continue;
    entries.push({
      type: "Withdrawal",
      blockNumber: log.blockNumber ?? 0n,
      nullifier: truncateHex(bigintToHex(args.nullifier)),
      amount: args.amount !== undefined ? formatEther(args.amount) : "—",
      recipient: args.recipient
        ? `${args.recipient.slice(0, 6)}...${args.recipient.slice(-4)}`
        : "—",
    });
  }

  return entries
    .sort((a, b) => {
      if (a.blockNumber > b.blockNumber) return -1;
      if (a.blockNumber < b.blockNumber) return 1;
      return 0;
    })
    .slice(0, MAX_HISTORY_ENTRIES);
}

const EVENT_BADGE_CLASS: Record<EventType, string> = {
  Deposit:
    "border-transparent bg-emerald-800 text-emerald-100 hover:bg-emerald-700",
  Transfer: "border-transparent bg-blue-800 text-blue-100 hover:bg-blue-700",
  Withdrawal:
    "border-transparent bg-amber-800 text-amber-100 hover:bg-amber-700",
};

function EventRow({ entry }: { entry: HistoryEntry }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
      <div className="flex items-center gap-2">
        <Badge className={EVENT_BADGE_CLASS[entry.type]}>{entry.type}</Badge>
        <span className="text-xs text-zinc-500">
          block {entry.blockNumber.toString()}
        </span>
      </div>

      {entry.type === "Deposit" && (
        <div className="space-y-0.5 text-xs text-zinc-300">
          <p>
            <span className="text-zinc-500">commitment</span>{" "}
            <span className="font-mono">{entry.commitment}</span>
          </p>
          <p>
            <span className="text-zinc-500">leaf</span> {entry.leafIndex}
            {entry.timestamp !== "—" && (
              <>
                {" "}
                <span className="text-zinc-500">at</span> {entry.timestamp}
              </>
            )}
          </p>
        </div>
      )}

      {entry.type === "Transfer" && (
        <div className="space-y-0.5 text-xs text-zinc-300">
          <p>
            <span className="text-zinc-500">nullifier</span>{" "}
            <span className="font-mono">{entry.nullifier}</span>
          </p>
          <p>
            <span className="text-zinc-500">out1</span>{" "}
            <span className="font-mono">{entry.outCommitment1}</span>
          </p>
          <p>
            <span className="text-zinc-500">out2</span>{" "}
            <span className="font-mono">{entry.outCommitment2}</span>
          </p>
        </div>
      )}

      {entry.type === "Withdrawal" && (
        <div className="space-y-0.5 text-xs text-zinc-300">
          <p>
            <span className="text-zinc-500">amount</span>{" "}
            <span className="font-mono">{entry.amount} ETH</span>
          </p>
          <p>
            <span className="text-zinc-500">recipient</span>{" "}
            <span className="font-mono">{entry.recipient}</span>
          </p>
          <p>
            <span className="text-zinc-500">nullifier</span>{" "}
            <span className="font-mono">{entry.nullifier}</span>
          </p>
        </div>
      )}
    </div>
  );
}

export function HistoryCard() {
  const publicClient = usePublicClient();

  const {
    data: entries,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["pool-history", POOL_ADDRESS_ZERO, IS_DEPLOYED],
    queryFn: () => fetchHistory(publicClient),
    enabled: IS_DEPLOYED && publicClient !== undefined,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>History</CardTitle>
        <CardDescription>
          Recent pool activity — last {MAX_HISTORY_ENTRIES} events sorted by
          block.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3 px-4 sm:px-6">
        {!IS_DEPLOYED && (
          <div className="rounded-lg border border-amber-700 bg-amber-950 p-3 text-sm text-amber-300">
            ConfidentialPool not deployed. History unavailable until the
            contract address is configured.
          </div>
        )}

        {IS_DEPLOYED && isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <LoadingSkeleton key={i} lines={3} />
            ))}
          </div>
        )}

        {IS_DEPLOYED && isError && (
          <div className="rounded-lg border border-red-700 bg-red-950 p-3 text-sm text-red-300">
            Failed to load events:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </div>
        )}

        {IS_DEPLOYED && !isLoading && !isError && entries !== undefined && (
          <>
            {entries.length === 0 ? (
              <p className="text-sm text-zinc-500 text-center py-6">
                No events found. Deposits, transfers, and withdrawals will
                appear here.
              </p>
            ) : (
              entries.map((entry, i) => <EventRow key={i} entry={entry} />)
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
