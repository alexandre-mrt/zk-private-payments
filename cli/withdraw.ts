import { Command } from "commander";
import path from "path";
import { ethers } from "ethers";
import { groth16 } from "snarkjs";
import { createNote, computeNullifier } from "./crypto.js";
import { MerkleTree } from "./merkle-tree.js";
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

export function registerWithdraw(program: Command): void {
  program
    .command("withdraw")
    .description("Withdraw ETH from a private note to a public address")
    .requiredOption("--note <commitment>", "Commitment of the note to withdraw from")
    .requiredOption("--amount <ETH>", "Amount in ETH to withdraw")
    .requiredOption("--to <address>", "Recipient ETH address")
    .option("--rpc <url>", "RPC URL")
    .action(
      async (opts: {
        note: string;
        amount: string;
        to: string;
        rpc?: string;
      }) => {
        try {
          if (!ethers.isAddress(opts.to)) {
            throw new Error(`Invalid recipient address: ${opts.to}`);
          }

          const provider = getProvider(opts.rpc);
          const wallet = getWallet(provider);
          const keys = loadFirstKeys();

          const inputNote = loadNote(opts.note);
          const withdrawAmountWei = ethers.parseEther(opts.amount);

          if (withdrawAmountWei > inputNote.amount) {
            throw new Error(
              `Withdrawal amount (${opts.amount} ETH) exceeds note amount (${ethers.formatEther(inputNote.amount)} ETH)`
            );
          }

          const changeAmount = inputNote.amount - withdrawAmountWei;

          // Build Merkle tree
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

          const leafIndex = inputNote.leafIndex;
          if (leafIndex === undefined) {
            throw new Error(
              "Note is missing leafIndex. Run 'zk-pay scan' first to update it."
            );
          }

          const { pathElements, pathIndices } = tree.getProof(leafIndex);
          const nullifier = await computeNullifier(inputNote.commitment, keys.spendingKey);

          // Change note (zero amount if full withdrawal)
          const changeNote = await createNote(changeAmount, keys.spendingPubKey.x);

          // Bind recipient address as field element
          const recipientBigInt = BigInt(opts.to);

          console.log("Generating ZK proof...");
          const wasmPath = path.join(CLI_DIRS.circuits, "withdraw.wasm");
          const zkeyPath = path.join(CLI_DIRS.circuits, "withdraw.zkey");

          const input = {
            root: root.toString(),
            nullifier: nullifier.toString(),
            amount: withdrawAmountWei.toString(),
            recipient: recipientBigInt.toString(),
            changeCommitment: changeNote.commitment.toString(),
            amountIn: inputNote.amount.toString(),
            blindingIn: inputNote.blinding.toString(),
            ownerPubKeyXIn: inputNote.ownerPubKeyX.toString(),
            spendingKey: keys.spendingKey.toString(),
            pathElements: pathElements.map((e) => e.toString()),
            pathIndices: pathIndices.map((i) => i.toString()),
            changeAmount: changeAmount.toString(),
            changeBlinding: changeNote.blinding.toString(),
            changeOwnerPubKeyX: keys.spendingPubKey.x.toString(),
          };

          const { proof } = await groth16.fullProve(input, wasmPath, zkeyPath);
          const { pA, pB, pC } = formatProofForSolidity(proof);

          console.log("Submitting withdrawal transaction...");
          const poolSigner = getConfidentialPool(wallet);
          const tx = await poolSigner["withdraw"](
            [pA[0], pA[1]],
            [
              [pB[0][0], pB[0][1]],
              [pB[1][0], pB[1][1]],
            ],
            [pC[0], pC[1]],
            root,
            nullifier,
            withdrawAmountWei,
            opts.to,
            changeNote.commitment
          );
          console.log("Transaction sent:", tx.hash);

          const receipt = await tx.wait();
          console.log("Confirmed in block:", receipt.blockNumber);

          markNoteSpent(opts.note);

          if (changeAmount > 0n) {
            saveNote({ ...changeNote, txHash: tx.hash, createdAt: new Date().toISOString() });
            console.log(`Change note saved: ${ethers.formatEther(changeAmount)} ETH → commitment ${changeNote.commitment}`);
          }

          console.log(`\nWithdrawal complete:`);
          console.log(`  Withdrew: ${ethers.formatEther(withdrawAmountWei)} ETH`);
          console.log(`  To:       ${opts.to}`);
          console.log(`  Tx hash:  ${tx.hash}`);
        } catch (err) {
          console.error("withdraw failed:", (err as Error).message);
          process.exit(1);
        }
      }
    );
}
