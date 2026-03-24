import { useReadContract } from "wagmi";
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

export function DashboardCard() {
  const { data: lastRoot, isLoading: rootLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "getLastRoot",
    query: { enabled: isDeployed },
  });

  const { data: nextIndex, isLoading: indexLoading } = useReadContract({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    functionName: "nextIndex",
    query: { enabled: isDeployed },
  });

  const localNotes = loadNotes();
  const totalLocalBalance = localNotes.reduce((sum, n) => sum + n.amount, 0n);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dashboard</CardTitle>
        <CardDescription>
          Pool statistics and your local balance.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {!isDeployed && (
          <div className="rounded-lg border border-amber-700 bg-amber-950 p-3 text-sm text-amber-300">
            ConfidentialPool not deployed. Stats unavailable.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <StatTile
            label="Total Deposits"
            value={
              !isDeployed
                ? "—"
                : indexLoading
                  ? "..."
                  : (nextIndex?.toString() ?? "0")
            }
          />
          <StatTile
            label="Local Notes"
            value={localNotes.length.toString()}
          />
          <StatTile
            label="Local Balance"
            value={`${(Number(totalLocalBalance) / 1e18).toFixed(4)} ETH`}
          />
          <StatTile
            label="Merkle Root"
            value={
              !isDeployed
                ? "—"
                : rootLoading
                  ? "..."
                  : lastRoot !== undefined
                    ? `${(lastRoot as bigint).toString(16).slice(0, 8)}...`
                    : "—"
            }
            mono
          />
        </div>

        {isDeployed && lastRoot !== undefined && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 space-y-1">
            <span className="text-xs text-zinc-400">Full Merkle Root</span>
            <p className="font-mono text-xs text-zinc-300 break-all">
              {(lastRoot as bigint).toString(16).padStart(64, "0")}
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
      <p className={`text-sm font-semibold text-zinc-100 ${mono ? "font-mono" : ""}`}>
        {value}
      </p>
    </div>
  );
}
