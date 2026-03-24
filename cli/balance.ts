import { Command } from "commander";
import { ethers } from "ethers";
import { computeNullifier } from "./crypto.js";
import {
  getProvider,
  getConfidentialPool,
  loadFirstKeys,
  loadAllNotes,
  markNoteSpent,
  log,
} from "./utils.js";

export function registerBalance(program: Command): void {
  program
    .command("balance")
    .description("Show total unspent balance across all known notes")
    .option("--rpc <url>", "RPC URL")
    .option("--verbose", "Show each note's details")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay balance
  $ zk-pay balance --verbose
  $ zk-pay balance --rpc http://localhost:8545
`
    )
    .action(async (opts: { rpc?: string; verbose?: boolean }) => {
      const rpcUrl = opts.rpc ?? process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
      try {
        const provider = getProvider(opts.rpc);
        const keys = loadFirstKeys();
        const pool = getConfidentialPool(provider);

        const allNotes = loadAllNotes();
        if (allNotes.length === 0) {
          log.info("No notes found. Run 'zk-pay deposit' first.");
          return;
        }

        log.info(`Checking ${allNotes.length} note(s) on-chain...`);

        let totalBalance = 0n;
        let unspentCount = 0;
        let spentCount = 0;

        for (const note of allNotes) {
          // Compute nullifier and check on-chain
          const nullifier = await computeNullifier(note.commitment, keys.spendingKey);
          const isSpent = (await pool["nullifiers"](nullifier)) as boolean;

          if (isSpent && !note.spent) {
            // Sync local state
            markNoteSpent(note.commitment.toString());
          }

          if (!isSpent) {
            totalBalance += note.amount;
            unspentCount++;

            if (opts.verbose) {
              log.step(`[UNSPENT] commitment: ${note.commitment}`);
              log.step(`          amount:     ${ethers.formatEther(note.amount)} ETH`);
              log.step(`          leafIndex:  ${note.leafIndex ?? "unknown"}`);
              log.step(`          created:    ${note.createdAt ?? "unknown"}`);
              console.log();
            }
          } else {
            spentCount++;
            if (opts.verbose) {
              log.step(`[SPENT]   commitment: ${note.commitment}`);
              log.step(`          amount:     ${ethers.formatEther(note.amount)} ETH`);
              console.log();
            }
          }
        }

        log.success(`Balance: ${ethers.formatEther(totalBalance)} ETH`);
        log.step(`Unspent: ${unspentCount} note(s)`);
        log.step(`Spent:   ${spentCount} note(s)`);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("No key files") || message.includes("deployment.json")) {
          log.error(message);
        } else {
          log.error(`Failed to connect to RPC at ${rpcUrl}: ${message}`);
        }
        process.exit(1);
      }
    });
}
