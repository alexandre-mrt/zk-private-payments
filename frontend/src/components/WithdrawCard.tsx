import { useState } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useContractEvents,
} from "wagmi";
import { isAddress, parseEther } from "viem";
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
import { generateWithdrawProof } from "@/lib/proof";
import { POOL_ABI, DEPLOY_BLOCK, FIELD_SIZE, getPoolAddress } from "@/lib/constants";

type WithdrawStep =
  | "idle"
  | "parsing"
  | "building-tree"
  | "generating-proof"
  | "submitting"
  | "success"
  | "error";

const STEP_LABELS: Record<WithdrawStep, string> = {
  idle: "",
  parsing: "Preparing note...",
  "building-tree": "Building Merkle tree...",
  "generating-proof": "Generating ZK proof (10-30s)...",
  submitting: "Submitting transaction...",
  success: "Withdrawal complete!",
  error: "Error",
};

const ACTIVE_STEPS: WithdrawStep[] = [
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

export function WithdrawCard() {
  const { isConnected } = useAccount();
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [recipientInput, setRecipientInput] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [step, setStep] = useState<WithdrawStep>("idle");
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

  const handleWithdraw = async () => {
    if (!isConnected) {
      setError("Please connect your wallet first.");
      return;
    }
    if (!selectedNote) {
      setError("Please select a note to spend.");
      return;
    }

    const recipient = recipientInput.trim();
    if (!isAddress(recipient)) {
      setError("Please enter a valid recipient address.");
      return;
    }

    const withdrawFloat = parseFloat(withdrawAmount);
    if (isNaN(withdrawFloat) || withdrawFloat <= 0) {
      setError("Please enter a valid withdrawal amount.");
      return;
    }

    const keypair = loadKeypair();
    if (!keypair) {
      setError("No keypair found. Please generate keys first.");
      return;
    }

    try {
      setError(null);
      setStep("parsing");

      const withdrawAmountWei = parseEther(withdrawAmount);
      const changeAmount = selectedNote.amount - withdrawAmountWei;

      if (changeAmount < 0n) {
        throw new Error("Withdraw amount exceeds note balance.");
      }

      const changeBlinding = randomFieldElement();
      const changeCommitment = await computeCommitment(
        changeAmount,
        changeBlinding,
        keypair.spendingPubX,
      );

      const nullifier = await computeNullifier(
        selectedNote.commitment,
        keypair.spendingKey,
      );

      const recipientBigInt = BigInt(recipient);

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

      const proof = await generateWithdrawProof({
        root: merkleProof.root,
        nullifier,
        amount: withdrawAmountWei,
        recipient: recipientBigInt,
        changeCommitment,
        amountIn: selectedNote.amount,
        blindingIn: selectedNote.blinding,
        ownerPubKeyXIn: keypair.spendingPubX,
        spendingKey: keypair.spendingKey,
        changeAmount,
        changeBlinding,
        changeOwnerPubKeyX: keypair.spendingPubX,
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
        functionName: "withdraw",
        args: [
          proof.pA,
          proof.pB,
          proof.pC,
          merkleProof.root,
          nullifier,
          withdrawAmountWei,
          recipient as `0x${string}`,
          changeCommitment,
        ],
      });

      setTxHash(hash);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdrawal failed");
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
        <CardTitle>Withdraw</CardTitle>
        <CardDescription>
          Exit funds from the confidential pool to a plaintext ETH address
          using a ZK proof.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 px-4 sm:px-6">
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

        <div className="space-y-1">
          <label className="text-sm text-zinc-400">Amount to Withdraw (ETH)</label>
          <Input
            type="number"
            min="0.001"
            step="0.001"
            placeholder="0.05"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            disabled={isProcessing}
            className="font-mono"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-zinc-400">Recipient Address</label>
          <Input
            placeholder="0x..."
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            disabled={isProcessing}
            className="font-mono text-xs"
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
            Withdrawal confirmed!{" "}
            <span className="font-mono text-xs">{txHash.slice(0, 10)}...</span>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-700 bg-red-950 p-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </CardContent>

      <CardFooter className="px-4 sm:px-6">
        {step === "success" ? (
          <Button variant="secondary" onClick={handleReset} className="w-full text-sm sm:text-base">
            New Withdrawal
          </Button>
        ) : (
          <Button
            onClick={handleWithdraw}
            disabled={isProcessing || !isConnected || !selectedNote}
            className="w-full text-sm sm:text-base"
          >
            {isProcessing
              ? STEP_LABELS[step] || "Processing..."
              : "Withdraw"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
