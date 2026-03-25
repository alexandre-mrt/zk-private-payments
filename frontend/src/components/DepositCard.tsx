import { useState, useEffect } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseEther, parseEventLogs } from "viem";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  loadKeypair,
  createNote,
  saveNote,
  removeNote,
  serializeNote,
  type Note,
} from "@/lib/crypto";
import { POOL_ABI, getPoolAddress } from "@/lib/constants";

type DepositState =
  | "idle"
  | "generating"
  | "confirming"
  | "waiting"
  | "success"
  | "error";

export function DepositCard() {
  const { isConnected } = useAccount();
  const [amountInput, setAmountInput] = useState("0.1");
  const [state, setState] = useState<DepositState>("idle");
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { writeContractAsync } = useWriteContract();

  const {
    isLoading: isWaiting,
    isSuccess: isConfirmed,
    data: receipt,
  } = useWaitForTransactionReceipt({ hash: txHash });

  // After confirmation: parse real leafIndex from the Deposit event and update the saved note
  useEffect(() => {
    if (!isConfirmed || !receipt || !note) return;

    const logs = parseEventLogs({
      abi: POOL_ABI,
      eventName: "Deposit",
      logs: receipt.logs,
    });

    if (logs.length === 0) return;

    const realLeafIndex = Number(logs[0].args.leafIndex);
    const updatedNoteString = serializeNote(
      note.amount,
      note.blinding,
      note.spendingKey,
      realLeafIndex,
    );
    const updatedNote: Note = { ...note, leafIndex: realLeafIndex, noteString: updatedNoteString };

    removeNote(note.noteString);
    saveNote(updatedNote);
    setNote(updatedNote);
  }, [isConfirmed, receipt, note]);

  const handleDeposit = async () => {
    if (!isConnected) {
      setError("Please connect your wallet first.");
      return;
    }

    const keypair = loadKeypair();
    if (!keypair) {
      setError("No keypair found. Please generate keys first.");
      return;
    }

    const amountFloat = parseFloat(amountInput);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      setError("Please enter a valid amount.");
      return;
    }

    try {
      setError(null);
      setState("generating");

      const amountWei = parseEther(amountInput);
      const amountBigInt = amountWei;

      // leafIndex starts at 0 — will be updated from the Deposit event after confirmation
      const generatedNote = await createNote(
        amountBigInt,
        keypair.spendingKey,
        keypair.spendingPubX,
        0,
      );

      setNote(generatedNote);
      setState("confirming");

      let poolAddress: `0x${string}`;
      try {
        poolAddress = getPoolAddress();
      } catch {
        // Pool not deployed yet — demo mode: save note and skip chain call
        saveNote(generatedNote);
        setState("success");
        return;
      }

      const hash = await writeContractAsync({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: "deposit",
        args: [generatedNote.commitment],
        value: amountWei,
      });

      setTxHash(hash);
      saveNote(generatedNote);
      setState("waiting");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
      setState("error");
    }
  };

  const handleCopyNote = async () => {
    if (!note) return;
    await navigator.clipboard.writeText(note.noteString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setState("idle");
    setNote(null);
    setError(null);
    setTxHash(undefined);
    setCopied(false);
  };

  const isProcessing =
    state === "generating" || state === "confirming" || isWaiting;
  const showNote =
    note !== null && (state === "success" || state === "waiting" || isConfirmed);

  if (!isConnected) {
    return (
      <Card className="max-w-lg mx-auto">
        <CardContent className="py-8 text-center text-zinc-400">
          Connect your wallet to continue
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>Deposit</CardTitle>
        <CardDescription>
          Deposit ETH into the confidential pool. A private note will be
          generated — save it to spend later.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 px-4 sm:px-6">
        <div className="space-y-2">
          <label className="text-sm text-zinc-400">Amount (ETH)</label>
          <Input
            type="number"
            min="0.001"
            step="0.01"
            placeholder="0.1"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            disabled={isProcessing}
            className="font-mono"
          />
        </div>

        {state === "generating" && (
          <StatusMessage type="info">
            Generating cryptographic note...
          </StatusMessage>
        )}
        {state === "confirming" && (
          <StatusMessage type="info">
            Please confirm the transaction in your wallet...
          </StatusMessage>
        )}
        {isWaiting && txHash && (
          <StatusMessage type="info">
            Waiting for confirmation...{" "}
            <TxLink hash={txHash} />
          </StatusMessage>
        )}
        {(isConfirmed || state === "success") && (
          <StatusMessage type="success">
            Deposit confirmed! Your note has been saved locally.
            {txHash && (
              <>
                {" "}
                <TxLink hash={txHash} />
              </>
            )}
          </StatusMessage>
        )}
        {error && <StatusMessage type="error">{error}</StatusMessage>}

        {showNote && note && (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-700 bg-amber-950 p-4">
              <p className="mb-2 text-sm font-semibold text-amber-400">
                Save your note — this is the only way to spend these funds.
                Do not share it.
              </p>
              <div className="rounded-md bg-zinc-900 p-3 font-mono text-xs text-zinc-300 break-all">
                {note.noteString}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyNote}
              className="w-full"
            >
              {copied ? "Copied!" : "Copy Note to Clipboard"}
            </Button>
          </div>
        )}
      </CardContent>

      <CardFooter className="px-4 sm:px-6">
        {state === "success" || isConfirmed ? (
          <Button variant="secondary" onClick={handleReset} className="w-full text-sm sm:text-base">
            Make Another Deposit
          </Button>
        ) : (
          <Button
            onClick={handleDeposit}
            disabled={isProcessing || !isConnected}
            className="w-full text-sm sm:text-base"
          >
            {isProcessing ? "Processing..." : "Deposit"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

type StatusType = "info" | "success" | "error";

function StatusMessage({
  type,
  children,
}: {
  type: StatusType;
  children: React.ReactNode;
}) {
  const colorMap: Record<StatusType, string> = {
    info: "border-zinc-700 bg-zinc-800 text-zinc-300",
    success: "border-emerald-700 bg-emerald-950 text-emerald-300",
    error: "border-red-700 bg-red-950 text-red-300",
  };
  return (
    <div className={`rounded-lg border p-3 text-sm ${colorMap[type]}`}>
      {children}
    </div>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <span className="font-mono text-xs text-zinc-400">
      {hash.slice(0, 10)}...
    </span>
  );
}
