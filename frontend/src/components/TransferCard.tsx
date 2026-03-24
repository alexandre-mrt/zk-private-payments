import { useState } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useContractEvents,
} from "wagmi";
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
  loadNotes,
  computeCommitment,
  computeNullifier,
  type Note,
} from "@/lib/crypto";
import { buildTreeFromLeaves } from "@/lib/merkle-tree";
import { generateTransferProof } from "@/lib/proof";
import { POOL_ABI, DEPLOY_BLOCK, FIELD_SIZE, getPoolAddress } from "@/lib/constants";

type TransferStep =
  | "idle"
  | "parsing"
  | "building-tree"
  | "generating-proof"
  | "submitting"
  | "success"
  | "error";

const STEP_LABELS: Record<TransferStep, string> = {
  idle: "",
  parsing: "Preparing note...",
  "building-tree": "Building Merkle tree...",
  "generating-proof": "Generating ZK proof (10-30s)...",
  submitting: "Submitting transaction...",
  success: "Transfer complete!",
  error: "Error",
};

const ACTIVE_STEPS: TransferStep[] = [
  "parsing",
  "building-tree",
  "generating-proof",
  "submitting",
];

// NIGHT-SHIFT-REVIEW: POOL_ADDRESS_ZERO used for event fetching — update after deployment
const POOL_ADDRESS_ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

function randomFieldElement(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value % FIELD_SIZE;
}

export function TransferCard() {
  const { isConnected } = useAccount();
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [recipientPubX, setRecipientPubX] = useState("");
  const [recipientPubY, setRecipientPubY] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [step, setStep] = useState<TransferStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { writeContractAsync } = useWriteContract();
  const { isLoading: isWaiting, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  const { data: depositEvents } = useContractEvents({
    address: POOL_ADDRESS_ZERO,
    abi: POOL_ABI,
    eventName: "Deposit",
    fromBlock: DEPLOY_BLOCK,
    query: {
      enabled: POOL_ADDRESS_ZERO !== "0x0000000000000000000000000000000000000000",
    },
  });

  const notes = loadNotes();

  const handleTransfer = async () => {
    if (!isConnected) {
      setError("Please connect your wallet first.");
      return;
    }
    if (!selectedNote) {
      setError("Please select a note to spend.");
      return;
    }

    const keypair = loadKeypair();
    if (!keypair) {
      setError("No keypair found. Please generate keys first.");
      return;
    }

    const pubXHex = recipientPubX.trim().replace(/^0x/, "");
    const pubYHex = recipientPubY.trim().replace(/^0x/, "");
    if (!pubXHex || !pubYHex) {
      setError("Please enter recipient public key coordinates.");
      return;
    }

    const sendAmountFloat = parseFloat(sendAmount);
    if (isNaN(sendAmountFloat) || sendAmountFloat <= 0) {
      setError("Please enter a valid send amount.");
      return;
    }

    try {
      setError(null);
      setStep("parsing");

      const recipPubX = BigInt("0x" + pubXHex);
      const recipPubY = BigInt("0x" + pubYHex);
      const sendAmountWei = BigInt(Math.floor(sendAmountFloat * 1e18));
      const changeAmount = selectedNote.amount - sendAmountWei;

      if (changeAmount < 0n) {
        throw new Error("Send amount exceeds note balance.");
      }

      const outBlinding1 = randomFieldElement();
      const outBlinding2 = randomFieldElement();

      const outCommitment1 = await computeCommitment(
        sendAmountWei,
        outBlinding1,
        recipPubX,
      );

      const outCommitment2 = await computeCommitment(
        changeAmount,
        outBlinding2,
        keypair.spendingPubX,
      );

      const nullifier = await computeNullifier(
        selectedNote.commitment,
        keypair.spendingKey,
      );

      setStep("building-tree");

      const sortedEvents = depositEvents
        ? [...depositEvents].sort((a, b) => {
            const aIdx = Number((a.args as { leafIndex?: number }).leafIndex ?? 0);
            const bIdx = Number((b.args as { leafIndex?: number }).leafIndex ?? 0);
            return aIdx - bIdx;
          })
        : [];

      const commitments: bigint[] = sortedEvents.map((e) => {
        const args = e.args as { commitment?: bigint };
        if (args.commitment === undefined) {
          throw new Error("Deposit event missing commitment field");
        }
        return args.commitment;
      });

      if (!commitments.includes(selectedNote.commitment)) {
        throw new Error(
          "Note commitment not found on-chain. Make sure the deposit was confirmed.",
        );
      }

      const tree = await buildTreeFromLeaves(commitments);
      const leafIndex = commitments.indexOf(selectedNote.commitment);
      const merkleProof = tree.getProof(leafIndex);

      setStep("generating-proof");

      const proof = await generateTransferProof({
        root: merkleProof.root,
        nullifier,
        outputCommitment1: outCommitment1,
        outputCommitment2: outCommitment2,
        amountIn: selectedNote.amount,
        blindingIn: selectedNote.blinding,
        ownerPubKeyXIn: keypair.spendingPubX,
        spendingKey: keypair.spendingKey,
        amountOut1: sendAmountWei,
        blindingOut1: outBlinding1,
        ownerPubKeyXOut1: recipPubX,
        amountOut2: changeAmount,
        blindingOut2: outBlinding2,
        ownerPubKeyXOut2: keypair.spendingPubX,
        pathElements: merkleProof.pathElements,
        pathIndices: merkleProof.pathIndices,
      });

      setStep("submitting");

      let poolAddress: `0x${string}`;
      try {
        poolAddress = getPoolAddress();
      } catch {
        throw new Error(
          "ConfidentialPool not deployed. Update POOL_ADDRESS_RAW in constants.ts.",
        );
      }

      const hash = await writeContractAsync({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: "transfer",
        args: [
          proof.pA,
          proof.pB,
          proof.pC,
          merkleProof.root,
          nullifier,
          outCommitment1,
          outCommitment2,
        ],
      });

      setTxHash(hash);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer failed");
      setStep("error");
    }
  };

  const handleReset = () => {
    setStep("idle");
    setError(null);
    setTxHash(undefined);
  };

  const isActive = ACTIVE_STEPS.includes(step as (typeof ACTIVE_STEPS)[number]);
  const isProcessing = isActive || isWaiting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transfer</CardTitle>
        <CardDescription>
          Spend a note and send funds to a recipient stealth address with a ZK
          proof.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm text-zinc-400">Select Note</label>
          <div className="space-y-1.5">
            {notes.length === 0 && (
              <p className="text-xs text-zinc-500">
                No notes stored. Deposit first.
              </p>
            )}
            {notes.map((n, i) => (
              <button
                key={i}
                onClick={() => setSelectedNote(n)}
                disabled={isProcessing}
                className={`w-full text-left rounded-lg border p-3 text-xs font-mono transition-colors ${
                  selectedNote?.noteString === n.noteString
                    ? "border-emerald-600 bg-emerald-950 text-emerald-300"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                {n.noteString.slice(0, 40)}...
                <span className="ml-2 text-zinc-500">
                  {(Number(n.amount) / 1e18).toFixed(4)} ETH
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs text-zinc-400">Recipient Pub X</label>
            <Input
              placeholder="0x..."
              value={recipientPubX}
              onChange={(e) => setRecipientPubX(e.target.value)}
              disabled={isProcessing}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-zinc-400">Recipient Pub Y</label>
            <Input
              placeholder="0x..."
              value={recipientPubY}
              onChange={(e) => setRecipientPubY(e.target.value)}
              disabled={isProcessing}
              className="font-mono text-xs"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm text-zinc-400">Amount to Send (ETH)</label>
          <Input
            type="number"
            min="0.001"
            step="0.001"
            placeholder="0.05"
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
            disabled={isProcessing}
            className="font-mono"
          />
        </div>

        {isActive && (
          <div className="space-y-1.5">
            {ACTIVE_STEPS.map((s) => {
              const current = ACTIVE_STEPS.indexOf(step as (typeof ACTIVE_STEPS)[number]);
              const index = ACTIVE_STEPS.indexOf(s);
              const isDone = index < current;
              const isCurrent = s === step;
              return (
                <div
                  key={s}
                  className={`flex items-center gap-2 text-sm ${
                    isCurrent
                      ? "text-emerald-400"
                      : isDone
                        ? "text-zinc-500"
                        : "text-zinc-700"
                  }`}
                >
                  <span className="text-xs">
                    {isDone ? "✓" : isCurrent ? "→" : "·"}
                  </span>
                  {STEP_LABELS[s]}
                </div>
              );
            })}
          </div>
        )}

        {isWaiting && txHash && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-sm text-zinc-300">
            Waiting for confirmation...{" "}
            <span className="font-mono text-xs text-zinc-400">
              {txHash.slice(0, 10)}...
            </span>
          </div>
        )}

        {isConfirmed && step === "success" && txHash && (
          <div className="rounded-lg border border-emerald-700 bg-emerald-950 p-3 text-sm text-emerald-300">
            Transfer confirmed!{" "}
            <span className="font-mono text-xs">{txHash.slice(0, 10)}...</span>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-700 bg-red-950 p-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </CardContent>

      <CardFooter>
        {step === "success" ? (
          <Button variant="secondary" onClick={handleReset} className="w-full">
            New Transfer
          </Button>
        ) : (
          <Button
            onClick={handleTransfer}
            disabled={isProcessing || !isConnected || !selectedNote}
            className="w-full"
          >
            {isProcessing
              ? STEP_LABELS[step] || "Processing..."
              : "Transfer"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
