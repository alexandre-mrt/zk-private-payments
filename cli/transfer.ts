import { Command } from "commander";
import path from "path";
import { ethers } from "ethers";
import { groth16 } from "snarkjs";
import { createNote, computeNullifier } from "./crypto.js";
import { CLI_DIRS } from "./config.js";
import {
  getProvider,
  getWallet,
  getConfidentialPool,
  loadFirstKeys,
  loadNote,
  saveNote,
  markNoteSpent,
  formatProofForSolidity,
  buildFullMerkleTree,
  log,
} from "./utils.js";

export function registerTransfer(program: Command): void {
  program
    .command("transfer")
    .description("Confidentially transfer funds: split one note into two output notes")
    .requiredOption("--note <commitment>", "Commitment of the input note to spend")
    .requiredOption("--to <pubKeyX>", "Recipient's spending pubkey X")
    .requiredOption("--amount <ETH>", "Amount to send (rest becomes change note for you)")
    .option("--rpc <url>", "RPC URL")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay transfer --note <commitment> --to <recipientPubKeyX> --amount 0.5
  $ zk-pay transfer --note <commitment> --to <recipientPubKeyX> --amount 0.5 --rpc http://localhost:8545

Notes:
  Run 'zk-pay scan' first to ensure your note has a leafIndex.
  The remainder after --amount is returned to you as a change note.
`
    )
    .action(
      async (opts: {
        note: string;
        to: string;
        amount: string;
        rpc?: string;
      }) => {
        const rpcUrl = opts.rpc ?? process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
        try {
          // Validate amount before async work
          const parsedAmount = Number.parseFloat(opts.amount);
          if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
            log.error(`Invalid amount: "${opts.amount}". Amount must be a positive number.`);
            process.exit(1);
          }

          // Validate note commitment format
          if (!opts.note || opts.note.trim() === "") {
            log.error("Note commitment cannot be empty.");
            process.exit(1);
          }

          const provider = getProvider(opts.rpc);
          const wallet = getWallet(provider);
          const keys = loadFirstKeys();

          const inputNote = loadNote(opts.note);
          const amountOut1Wei = ethers.parseEther(opts.amount);

          if (amountOut1Wei > inputNote.amount) {
            log.error(
              `Transfer amount (${opts.amount} ETH) exceeds note amount (${ethers.formatEther(inputNote.amount)} ETH).`
            );
            process.exit(1);
          }

          const amountOut2 = inputNote.amount - amountOut1Wei;
          const recipientPubKeyX = BigInt(opts.to);

          // Build Merkle tree from all on-chain commitment events
          log.info("Building Merkle tree from chain...");
          const pool = getConfidentialPool(provider);
          const tree = await buildFullMerkleTree(pool);
          const root = tree.root;

          // Find our leaf index
          const leafIndex = inputNote.leafIndex;
          if (leafIndex === undefined) {
            log.error("Note file found but is missing leafIndex. Did you run 'zk-pay scan' first?");
            process.exit(1);
          }

          const { pathElements, pathIndices } = tree.getProof(leafIndex);

          // Compute nullifier
          const nullifier = await computeNullifier(inputNote.commitment, keys.spendingKey);

          // Create output notes
          const outNote1 = await createNote(amountOut1Wei, recipientPubKeyX);
          const outNote2 = await createNote(amountOut2, keys.spendingPubKey.x);

          log.info("Generating ZK proof...");
          const wasmPath = path.join(
            CLI_DIRS.circuits,
            "confidential_transfer",
            "confidential_transfer_js",
            "confidential_transfer.wasm"
          );
          const zkeyPath = path.join(
            CLI_DIRS.circuits,
            "confidential_transfer",
            "confidential_transfer_final.zkey"
          );

          const input = {
            root: root.toString(),
            nullifier: nullifier.toString(),
            outputCommitment1: outNote1.commitment.toString(),
            outputCommitment2: outNote2.commitment.toString(),
            amountIn: inputNote.amount.toString(),
            blindingIn: inputNote.blinding.toString(),
            ownerPubKeyXIn: inputNote.ownerPubKeyX.toString(),
            spendingKey: keys.spendingKey.toString(),
            pathElements: pathElements.map((e) => e.toString()),
            pathIndices: pathIndices.map((i) => i.toString()),
            amountOut1: amountOut1Wei.toString(),
            blindingOut1: outNote1.blinding.toString(),
            ownerPubKeyXOut1: recipientPubKeyX.toString(),
            amountOut2: amountOut2.toString(),
            blindingOut2: outNote2.blinding.toString(),
            ownerPubKeyXOut2: keys.spendingPubKey.x.toString(),
          };

          const { proof } = await groth16.fullProve(input, wasmPath, zkeyPath);
          const { pA, pB, pC } = formatProofForSolidity(proof);

          log.info("Submitting transfer transaction...");
          const poolSigner = getConfidentialPool(wallet);
          const tx = await poolSigner["transfer"](
            [pA[0], pA[1]],
            [
              [pB[0][0], pB[0][1]],
              [pB[1][0], pB[1][1]],
            ],
            [pC[0], pC[1]],
            root,
            nullifier,
            outNote1.commitment,
            outNote2.commitment
          );
          log.step(`Transaction sent: ${tx.hash}`);

          const receipt = await tx.wait();
          log.step(`Confirmed in block: ${receipt.blockNumber}`);

          // Mark input note as spent, save output notes
          markNoteSpent(opts.note);
          saveNote({ ...outNote1, txHash: tx.hash, createdAt: new Date().toISOString() });
          saveNote({ ...outNote2, txHash: tx.hash, createdAt: new Date().toISOString() });

          log.success("Transfer complete.");
          log.step(`Sent:   ${ethers.formatEther(amountOut1Wei)} ETH -> commitment ${outNote1.commitment}`);
          log.step(`Change: ${ethers.formatEther(amountOut2)} ETH -> commitment ${outNote2.commitment}`);
        } catch (err) {
          const message = (err as Error).message;
          if (
            message.includes("PRIVATE_KEY") ||
            message.includes("Note not found") ||
            message.includes("No key files") ||
            message.includes("deployment.json")
          ) {
            log.error(message);
          } else if (message.includes("Note not found")) {
            log.error(`Note file not found at notes/${opts.note}.json. Did you run 'zk-pay deposit' first?`);
          } else {
            log.error(`Failed to connect to RPC at ${rpcUrl}: ${message}`);
          }
          process.exit(1);
        }
      }
    );
}
