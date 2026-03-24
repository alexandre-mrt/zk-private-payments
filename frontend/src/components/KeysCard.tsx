import { useState, useEffect } from "react";
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
  generateKeypair,
  saveKeypair,
  loadKeypair,
  type Keypair,
} from "@/lib/crypto";

type KeysState = "idle" | "generating" | "ready";

function truncateBigInt(v: bigint): string {
  const hex = v.toString(16).padStart(64, "0");
  return `${hex.slice(0, 8)}...${hex.slice(-8)}`;
}

export function KeysCard() {
  const [state, setState] = useState<KeysState>("idle");
  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const existing = loadKeypair();
    if (existing) {
      setKeypair(existing);
      setState("ready");
    }
  }, []);

  const handleGenerate = async () => {
    try {
      setState("generating");
      setError(null);
      const kp = await generateKeypair();
      saveKeypair(kp);
      setKeypair(kp);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Key generation failed");
      setState("idle");
    }
  };

  const handleCopy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleReset = () => {
    if (!confirm("This will replace your current keypair. Existing notes will become unspendable. Continue?")) return;
    setState("idle");
    setKeypair(null);
    localStorage.removeItem("zkpay_keypair");
    localStorage.removeItem("zkpay_notes");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Keys</CardTitle>
        <CardDescription>
          Generate your spending and viewing keypair. These are stored locally
          and never leave your browser.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-lg border border-red-700 bg-red-950 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {state === "generating" && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm text-zinc-300">
            Generating BabyJubjub keypair...
          </div>
        )}

        {keypair && state === "ready" && (
          <div className="space-y-3">
            <KeyRow
              label="Spending Key"
              value={keypair.spendingKey.toString(16).padStart(64, "0")}
              display={truncateBigInt(keypair.spendingKey)}
              onCopy={handleCopy}
              copied={copied}
              sensitive
            />
            <KeyRow
              label="Viewing Key"
              value={keypair.viewingKey.toString(16).padStart(64, "0")}
              display={truncateBigInt(keypair.viewingKey)}
              onCopy={handleCopy}
              copied={copied}
              sensitive
            />
            <div className="grid grid-cols-2 gap-2">
              <PubKeyRow
                label="Spending Pub X"
                value={keypair.spendingPubX.toString(16).padStart(64, "0")}
                display={truncateBigInt(keypair.spendingPubX)}
                onCopy={handleCopy}
                copied={copied}
              />
              <PubKeyRow
                label="Spending Pub Y"
                value={keypair.spendingPubY.toString(16).padStart(64, "0")}
                display={truncateBigInt(keypair.spendingPubY)}
                onCopy={handleCopy}
                copied={copied}
              />
              <PubKeyRow
                label="Viewing Pub X"
                value={keypair.viewingPubX.toString(16).padStart(64, "0")}
                display={truncateBigInt(keypair.viewingPubX)}
                onCopy={handleCopy}
                copied={copied}
              />
              <PubKeyRow
                label="Viewing Pub Y"
                value={keypair.viewingPubY.toString(16).padStart(64, "0")}
                display={truncateBigInt(keypair.viewingPubY)}
                onCopy={handleCopy}
                copied={copied}
              />
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="flex gap-2">
        {state === "ready" ? (
          <Button variant="destructive" size="sm" onClick={handleReset}>
            Regenerate Keys
          </Button>
        ) : (
          <Button
            onClick={handleGenerate}
            disabled={state === "generating"}
            className="w-full"
          >
            {state === "generating" ? "Generating..." : "Generate Keypair"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function KeyRow({
  label,
  value,
  display,
  onCopy,
  copied,
  sensitive,
}: {
  label: string;
  value: string;
  display: string;
  onCopy: (label: string, value: string) => void;
  copied: string | null;
  sensitive?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-400">{label}</span>
        {sensitive && (
          <span className="text-xs text-amber-500">Private — never share</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-zinc-300">{display}</span>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-6 px-2"
          onClick={() => onCopy(label, value)}
        >
          {copied === label ? "Copied!" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function PubKeyRow({
  label,
  value,
  display,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  display: string;
  onCopy: (label: string, value: string) => void;
  copied: string | null;
}) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-2 space-y-1">
      <span className="text-xs text-zinc-400 block">{label}</span>
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-xs text-zinc-300 truncate">{display}</span>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-5 px-1.5 flex-shrink-0"
          onClick={() => onCopy(label, value)}
        >
          {copied === label ? "✓" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
