import { Command } from "commander";
import { ethers } from "ethers";
import { computeNullifier } from "./crypto.js";
import {
  getProvider,
  getConfidentialPool,
  loadFirstKeys,
  loadAllNotes,
  markNoteSpent,
} from "./utils.js";

export function registerBalance(program: Command): void {
  program
    .command("balance")
    .description("Show total unspent balance across all known notes")
    .option("--rpc <url>", "RPC URL")
    .option("--verbose", "Show each note's details")
    .action(async (opts: { rpc?: string; verbose?: boolean }) => {
      try {
        const provider = getProvider(opts.rpc);
        const keys = loadFirstKeys();
        const pool = getConfidentialPool(provider);

        const allNotes = loadAllNotes();
        if (allNotes.length === 0) {
          console.log("No notes found. Run 'zk-pay deposit' first.");
          return;
        }

        console.log(`Checking ${allNotes.length} note(s) on-chain...\n`);

        let totalBalance = 0n;
        let unspentCount = 0;
        let spentCount = 0;

        for (const note of allNotes) {
          // Compute nullifier and check on-chain
          const nullifier = await computeNullifier(note.commitment, keys.spendingKey);
          const isSpent = await pool["nullifiers"](nullifier) as boolean;

          if (isSpent && !note.spent) {
            // Sync local state
            markNoteSpent(note.commitment.toString());
          }

          if (!isSpent) {
            totalBalance += note.amount;
            unspentCount++;

            if (opts.verbose) {
              console.log(`  [UNSPENT] commitment: ${note.commitment}`);
              console.log(`            amount:     ${ethers.formatEther(note.amount)} ETH`);
              console.log(`            leafIndex:  ${note.leafIndex ?? "unknown"}`);
              console.log(`            created:    ${note.createdAt ?? "unknown"}`);
              console.log();
            }
          } else {
            spentCount++;
            if (opts.verbose) {
              console.log(`  [SPENT]   commitment: ${note.commitment}`);
              console.log(`            amount:     ${ethers.formatEther(note.amount)} ETH`);
              console.log();
            }
          }
        }

        console.log(`Balance:     ${ethers.formatEther(totalBalance)} ETH`);
        console.log(`Unspent:     ${unspentCount} note(s)`);
        console.log(`Spent:       ${spentCount} note(s)`);
      } catch (err) {
        console.error("balance failed:", (err as Error).message);
        process.exit(1);
      }
    });
}
