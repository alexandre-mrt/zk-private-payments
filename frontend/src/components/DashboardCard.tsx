import { useReadContract, useAccount } from "wagmi";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { POOL_ABI } from "@/lib/constants";
import { loadNotes } from "@/lib/crypto";

// NIGHT-SHIFT-REVIEW: POOL_ADDRESS_ZERO used for stats — update after deployment
const POOL_ADDRESS_ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const isDeployed = POOL_ADDRESS_ZERO !== "0x0000000000000000000000000000000000000000";

function formatEth(wei: bigint): string {
  return `${(Number(wei) / 1e18).toFixed(4)} ETH`;
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function DashboardCard() {
  const { isConnected } = useAccount();

  const { data: lastRoot, isLoading: rootLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "getLastRoot",
    query: { enabled: isDeployed },
  });

  const { data: depositCount, isLoading: depositCountLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "getDepositCount",
    query: { enabled: isDeployed },
  });

  const { data: poolBalance, isLoading: balanceLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "getPoolBalance",
    query: { enabled: isDeployed },
  });

  const { data: denominations, isLoading: denominationsLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "getDenominations",
    query: { enabled: isDeployed },
  });

  const { data: minDepositAge, isLoading: minDepositAgeLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "minDepositAge",
    query: { enabled: isDeployed },
  });

  const { data: allowlistEnabled, isLoading: allowlistLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "allowlistEnabled",
    query: { enabled: isDeployed },
  });

  const { data: maxWithdrawAmount, isLoading: maxWithdrawLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "maxWithdrawAmount",
    query: { enabled: isDeployed },
  });

  const { data: ownerAddress, isLoading: ownerLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "owner",
    query: { enabled: isDeployed },
  });

  const localNotes = loadNotes();
  const totalLocalBalance = localNotes.reduce((sum, n) => sum + n.amount, 0n);

  if (!isConnected) {
    return (
      <Card className="max-w-2xl mx-auto">
        <CardContent className="py-8 text-center text-zinc-400">
          Connect your wallet to continue
        </CardContent>
      </Card>
    );
  }

  const denominationValue = (): string => {
    if (!isDeployed) return "—";
    if (denominationsLoading) return "...";
    const list = denominations as readonly bigint[] | undefined;
    if (!list || list.length === 0) return "Any";
    return list.map((d) => formatEth(d)).join(", ");
  };

  const minDepositAgeValue = (): string => {
    if (!isDeployed) return "—";
    if (minDepositAgeLoading) return "...";
    const age = minDepositAge as bigint | undefined;
    if (age === undefined) return "—";
    if (age === 0n) return "None";
    return `${age.toString()} blocks`;
  };

  const maxWithdrawValue = (): string => {
    if (!isDeployed) return "—";
    if (maxWithdrawLoading) return "...";
    const max = maxWithdrawAmount as bigint | undefined;
    if (max === undefined) return "—";
    if (max === 0n) return "No limit";
    return formatEth(max);
  };

  return (
    <Card className="max-w-2xl mx-auto">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>Dashboard</CardTitle>
        <CardDescription>
          Pool statistics and your local balance.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 px-4 sm:px-6">
        {!isDeployed && (
          <div className="rounded-lg border border-amber-700 bg-amber-950 p-3 text-sm text-amber-300">
            ConfidentialPool not deployed. Stats unavailable.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile
            label="Pool Balance"
            value={
              !isDeployed
                ? "—"
                : balanceLoading
                  ? "..."
                  : poolBalance !== undefined
                    ? formatEth(poolBalance as bigint)
                    : "—"
            }
          />
          <StatTile
            label="Deposit Count"
            value={
              !isDeployed
                ? "—"
                : depositCountLoading
                  ? "..."
                  : (depositCount?.toString() ?? "0")
            }
          />
          <StatTile
            label="Local Notes"
            value={localNotes.length.toString()}
          />
          <StatTile
            label="Local Balance"
            value={formatEth(totalLocalBalance)}
          />
          <StatTile
            label="Allowlist"
            value={
              !isDeployed
                ? "—"
                : allowlistLoading
                  ? "..."
                  : allowlistEnabled !== undefined
                    ? (allowlistEnabled as boolean)
                      ? "Enabled"
                      : "Disabled"
                    : "—"
            }
          />
          <StatTile
            label="Max Withdrawal"
            value={maxWithdrawValue()}
          />
          <StatTile
            label="Min Deposit Age"
            value={minDepositAgeValue()}
          />
          <StatTile
            label="Denominations"
            value={denominationValue()}
          />
          <StatTile
            label="Merkle Root"
            value={
              !isDeployed
                ? "—"
                : rootLoading
                  ? "..."
                  : lastRoot !== undefined
                    ? `0x${(lastRoot as bigint).toString(16).slice(0, 8)}...`
                    : "—"
            }
            mono
          />
          <StatTile
            label="Owner"
            value={
              !isDeployed
                ? "—"
                : ownerLoading
                  ? "..."
                  : ownerAddress
                    ? shortenAddress(ownerAddress as string)
                    : "—"
            }
            mono
          />
        </div>

        {isDeployed && lastRoot !== undefined && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 space-y-1">
            <span className="text-xs text-zinc-400">Full Merkle Root</span>
            <p className="font-mono text-xs text-zinc-300 break-all">
              0x{(lastRoot as bigint).toString(16).padStart(64, "0")}
            </p>
          </div>
        )}

        {isDeployed && ownerAddress && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 space-y-1">
            <span className="text-xs text-zinc-400">Owner Address</span>
            <p className="font-mono text-xs text-zinc-300 break-all">
              {ownerAddress as string}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatTile({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 space-y-1">
      <span className="text-xs text-zinc-400">{label}</span>
      <p className={`text-sm font-semibold text-zinc-100 truncate ${mono ? "font-mono" : ""}`}>
        {value}
      </p>
    </div>
  );
}
