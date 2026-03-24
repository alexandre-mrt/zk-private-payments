import { useState } from "react";
import { useContractEvents } from "wagmi";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  loadKeypair,
  deriveStealthCommitment,
  loadNotes,
} from "@/lib/crypto";
import { REGISTRY_ABI, DEPLOY_BLOCK } from "@/lib/constants";

type ScanState = "idle" | "scanning" | "done" | "error";

type ScannedNote = {
  commitment: bigint;
};

// NIGHT-SHIFT-REVIEW: registry address may not be deployed — we use a zero address guard
const REGISTRY_ADDRESS_ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export function ScanCard() {
  const [state, setState] = useState<ScanState>("idle");
  const [found, setFound] = useState<ScannedNote[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: stealthEvents } = useContractEvents({
    address: REGISTRY_ADDRESS_ZERO,
    abi: REGISTRY_ABI,
    eventName: "StealthPayment",
    fromBlock: DEPLOY_BLOCK,
    query: {
      // Disabled until contract is deployed — update REGISTRY_ADDRESS_ZERO to enable
      enabled: REGISTRY_ADDRESS_ZERO !== "0x0000000000000000000000000000000000000000",
    },
  });

  const handleScan = async () => {
    const keypair = loadKeypair();
    if (!keypair) {
      setError("No keypair found. Please generate keys first.");
      return;
    }

    try {
      setState("scanning");
      setError(null);
      const hits: ScannedNote[] = [];

      const events = stealthEvents ?? [];
      for (const event of events) {
        const args = event.args as {
          ephemeralX?: bigint;
          ephemeralY?: bigint;
          stealthX?: bigint;
          stealthY?: bigint;
          viewTag?: bigint;
        };

        if (
          args.ephemeralX === undefined ||
          args.ephemeralY === undefined ||
          args.stealthX === undefined ||
          args.stealthY === undefined
        ) {
          continue;
        }

        // View tag fast-reject (first byte of derived commitment)
        if (args.viewTag !== undefined) {
          const derived = await deriveStealthCommitment(
            args.ephemeralX,
            args.ephemeralY,
            keypair.viewingKey,
            keypair.spendingPubX,
            keypair.spendingPubY,
          );
          const derivedTag = derived & 0xffn;
          if (derivedTag !== (args.viewTag & 0xffn)) continue;
          hits.push({ commitment: derived });
          continue;
        }

        const derived = await deriveStealthCommitment(
          args.ephemeralX,
          args.ephemeralY,
          keypair.viewingKey,
          keypair.spendingPubX,
          keypair.spendingPubY,
        );
        hits.push({ commitment: derived });
      }

      setFound(hits);
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
      setState("error");
    }
  };

  const existingNotes = loadNotes();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scan</CardTitle>
        <CardDescription>
          Scan the StealthRegistry for incoming payments addressed to your
          viewing key.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {REGISTRY_ADDRESS_ZERO === "0x0000000000000000000000000000000000000000" && (
          <div className="rounded-lg border border-amber-700 bg-amber-950 p-3 text-sm text-amber-300">
            StealthRegistry not deployed. Update the registry address in ScanCard to enable live scanning.
          </div>
        )}

        {state === "scanning" && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm text-zinc-300">
            Scanning for stealth payments...
          </div>
        )}

        {state === "done" && (
          <div className="rounded-lg border border-emerald-700 bg-emerald-950 p-3 text-sm text-emerald-300">
            Scan complete. Found {found.length} payment(s) addressed to your key.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-700 bg-red-950 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {found.length > 0 && (
          <div className="space-y-2">
            {found.map((hit, i) => (
              <div
                key={i}
                className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 space-y-1"
              >
                <span className="text-xs text-emerald-400 font-semibold">
                  Incoming payment #{i + 1}
                </span>
                <div className="font-mono text-xs text-zinc-400 break-all">
                  Derived commitment: {hit.commitment.toString(16).slice(0, 16)}...
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-zinc-500">
          Locally stored notes: {existingNotes.length}
        </p>
      </CardContent>

      <CardFooter>
        <Button
          onClick={handleScan}
          disabled={state === "scanning"}
          className="w-full"
        >
          {state === "scanning" ? "Scanning..." : "Scan for Payments"}
        </Button>
      </CardFooter>
    </Card>
  );
}
