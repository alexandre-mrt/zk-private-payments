import { Command } from "commander";
import path from "path";
import { ethers } from "ethers";
import { groth16 } from "snarkjs";
import { createNote, computeNullifier } from "./crypto.js";
import { MerkleTree, ZERO_VALUE } from "./merkle-tree.js";
import { MERKLE_TREE_HEIGHT, CLI_DIRS } from "./config.js";
import {
  getProvider,
  getWallet,
  getConfidentialPool,
  loadFirstKeys,
  loadNote,
  saveNote,
  markNoteSpent,
  formatProofForSolidity,
} from "./utils.js";

export function registerTransfer(program: Command): void {
  program
    .command("transfer")
    .description("Confidentially transfer funds: split one note into two output notes")
    .requiredOption("--note <commitment>", "Commitment of the input note to spend")
    .requiredOption("--to <pubKeyX>", "Recipient's spending pubkey X")
    .requiredOption("--amount <ETH>", "Amount to send (rest becomes change note for you)")
    .option("--rpc <url>", "RPC URL")
    .action(
      async (opts: {
        note: string;
        to: string;
        amount: string;
        rpc?: string;
      }) => {
        try {
          const provider = getProvider(opts.rpc);
          const wallet = getWallet(provider);
          const keys = loadFirstKeys();

          const inputNote = loadNote(opts.note);
          const amountOut1Wei = ethers.parseEther(opts.amount);

          if (amountOut1Wei > inputNote.amount) {
            throw new Error(
              `Transfer amount (${opts.amount} ETH) exceeds note amount (${ethers.formatEther(inputNote.amount)} ETH)`
            );
          }

          const amountOut2 = inputNote.amount - amountOut1Wei;
          const recipientPubKeyX = BigInt(opts.to);

          // Build Merkle tree from on-chain Deposit events
          console.log("Building Merkle tree from chain...");
          const pool = getConfidentialPool(provider);
          const depositFilter = pool.filters["Deposit"]();
          const depositEvents = await pool.queryFilter(depositFilter, 0);

          const tree = await MerkleTree.create(MERKLE_TREE_HEIGHT);
          const leaves: bigint[] = depositEvents
            .sort((a, b) => {
              const la = pool.interface.parseLog(a);
              const lb = pool.interface.parseLog(b);
              return Number(la?.args["leafIndex"] ?? 0) - Number(lb?.args["leafIndex"] ?? 0);
            })
            .map((e) => {
              const log = pool.interface.parseLog(e);
              return BigInt(log?.args["commitment"]?.toString() ?? "0");
            });

          tree.insertAll(leaves);
          const root = tree.root;

          // Find our leaf index
          const leafIndex = inputNote.leafIndex;
          if (leafIndex === undefined) {
            throw new Error(
              "Note is missing leafIndex. Run 'zk-pay scan' first to update it."
            );
          }

          const { pathElements, pathIndices } = tree.getProof(leafIndex);

          // Compute nullifier
          const nullifier = await computeNullifier(inputNote.commitment, keys.spendingKey);

          // Create output notes
          const outNote1 = await createNote(amountOut1Wei, recipientPubKeyX);
          const outNote2 = await createNote(amountOut2, keys.spendingPubKey.x);

          console.log("Generating ZK proof...");
          const wasmPath = path.join(CLI_DIRS.circuits, "confidential_transfer.wasm");
          const zkeyPath = path.join(CLI_DIRS.circuits, "confidential_transfer.zkey");

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

          const { proof, publicSignals } = await groth16.fullProve(input, wasmPath, zkeyPath);
          const { pA, pB, pC } = formatProofForSolidity(proof);

          console.log("Submitting transfer transaction...");
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
          console.log("Transaction sent:", tx.hash);

          const receipt = await tx.wait();
          console.log("Confirmed in block:", receipt.blockNumber);

          // Mark input note as spent, save output notes
          markNoteSpent(opts.note);
          saveNote({ ...outNote1, txHash: tx.hash, createdAt: new Date().toISOString() });
          saveNote({ ...outNote2, txHash: tx.hash, createdAt: new Date().toISOString() });

          console.log(`\nTransfer complete:`);
          console.log(`  Sent:   ${ethers.formatEther(amountOut1Wei)} ETH → commitment ${outNote1.commitment}`);
          console.log(`  Change: ${ethers.formatEther(amountOut2)} ETH → commitment ${outNote2.commitment}`);
        } catch (err) {
          console.error("transfer failed:", (err as Error).message);
          process.exit(1);
        }
      }
    );
}
