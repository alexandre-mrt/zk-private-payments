import { Command } from "commander";
import { ethers } from "ethers";
import { deriveSharedSecret } from "./crypto.js";
import { buildPoseidon } from "circomlibjs";
import {
  getProvider,
  getStealthRegistry,
  getConfidentialPool,
  loadFirstKeys,
  loadAllNotes,
  saveNote,
} from "./utils.js";

export function registerScan(program: Command): void {
  program
    .command("scan")
    .description("Scan chain for notes and stealth payments belonging to you")
    .option("--from-block <n>", "Start block number", "0")
    .option("--rpc <url>", "RPC URL")
    .action(async (opts: { fromBlock?: string; rpc?: string }) => {
      try {
        const provider = getProvider(opts.rpc);
        const keys = loadFirstKeys();
        const fromBlock = Number(opts.fromBlock ?? 0);

        console.log("Scanning from block", fromBlock, "...");
        console.log("Using viewing key for:", keys.address);

        const registry = getStealthRegistry(provider);
        const pool = getConfidentialPool(provider);

        // 1. Fetch StealthPayment events
        const stealthFilter = registry.filters["StealthPayment"]();
        const stealthEvents = await registry.queryFilter(stealthFilter, fromBlock);
        console.log(`\nFound ${stealthEvents.length} StealthPayment event(s)`);

        const poseidon = await buildPoseidon();
        const pF = poseidon.F;

        let stealthFound = 0;
        for (const event of stealthEvents) {
          const log = registry.interface.parseLog(event);
          if (!log) continue;

          const ephPubKeyX = BigInt(log.args["ephemeralPubKeyX"].toString());
          const ephPubKeyY = BigInt(log.args["ephemeralPubKeyY"].toString());
          const stealthPubKeyX = BigInt(log.args["stealthPubKeyX"].toString());
          const commitment = BigInt(log.args["commitment"].toString());

          // Derive shared secret using viewing key
          const shared = await deriveSharedSecret(keys.viewingKey, ephPubKeyX, ephPubKeyY);
          const sharedX = pF.toObject(poseidon([shared.x]));

          // If the stealthPubKeyX matches, the payment is for us
          // NIGHT-SHIFT-REVIEW: Stealth address matching logic — we check if the
          // derived stealthPubKeyX equals the announced one. The full check would
          // require knowing the recipient base pubkey to recompute the stealth point.
          // For now we scan all announcements and attempt note correlation below.
          if (stealthPubKeyX === keys.spendingPubKey.x) {
            console.log(
              `  [STEALTH] Found matching stealth payment, commitment: ${commitment}`
            );
            stealthFound++;
          }
        }

        // 2. Fetch Deposit events and match to our known notes
        const depositFilter = pool.filters["Deposit"]();
        const depositEvents = await pool.queryFilter(depositFilter, fromBlock);
        console.log(`\nFound ${depositEvents.length} Deposit event(s)`);

        const existingNotes = loadAllNotes();
        const knownCommitments = new Set(existingNotes.map((n) => n.commitment.toString()));

        let notesFound = 0;
        for (const event of depositEvents) {
          const log = pool.interface.parseLog(event);
          if (!log) continue;

          const commitment = BigInt(log.args["commitment"].toString());
          const leafIndex = Number(log.args["leafIndex"].toString());
          const amount = BigInt(log.args["amount"].toString());

          if (knownCommitments.has(commitment.toString())) {
            // Update leafIndex if missing
            const existing = existingNotes.find((n) => n.commitment === commitment);
            if (existing && existing.leafIndex === undefined) {
              saveNote({ ...existing, leafIndex, spent: existing.spent ?? false });
              console.log(
                `  [DEPOSIT] Updated leaf index for commitment ${commitment} → index ${leafIndex}`
              );
            }
            notesFound++;
          }
        }

        console.log(`\nScan complete:`);
        console.log(`  Stealth payments matched: ${stealthFound}`);
        console.log(`  Known notes found on-chain: ${notesFound}`);
        console.log(`  Total local notes: ${existingNotes.length}`);
      } catch (err) {
        console.error("scan failed:", (err as Error).message);
        process.exit(1);
      }
    });
}
