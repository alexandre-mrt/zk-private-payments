import { Command } from "commander";
import { ethers } from "ethers";
import { createNote } from "./crypto.js";
import { deriveStealthKeypair } from "./crypto.js";
import {
  getProvider,
  getWallet,
  getConfidentialPool,
  getStealthRegistry,
  loadFirstKeys,
  saveNote,
} from "./utils.js";

export function registerDeposit(program: Command): void {
  program
    .command("deposit")
    .description("Deposit ETH into the pool and create a private note")
    .requiredOption("--amount <ETH>", "Amount in ETH to deposit")
    .option(
      "--to <stealthPubKeyX>",
      "Stealth spending pubkey X of recipient (announce stealth payment)"
    )
    .option("--to-y <stealthPubKeyY>", "Stealth spending pubkey Y of recipient")
    .option("--rpc <url>", "RPC URL")
    .action(
      async (opts: {
        amount: string;
        to?: string;
        toY?: string;
        rpc?: string;
      }) => {
        try {
          const provider = getProvider(opts.rpc);
          const wallet = getWallet(provider);
          const keys = loadFirstKeys();

          const amountWei = ethers.parseEther(opts.amount);
          const amountBigInt = amountWei;

          console.log(`Creating note for ${opts.amount} ETH...`);
          const note = await createNote(amountBigInt, keys.spendingPubKey.x);

          console.log("  commitment:", note.commitment.toString());
          console.log("  blinding:  ", note.blinding.toString());

          const pool = getConfidentialPool(wallet);
          console.log("\nSubmitting deposit transaction...");

          const tx = await pool["deposit"](note.commitment, { value: amountWei });
          console.log("Transaction sent:", tx.hash);

          const receipt = await tx.wait();
          console.log("Confirmed in block:", receipt.blockNumber);

          // Find the leaf index from the Deposit event
          let leafIndex: number | undefined;
          for (const log of receipt.logs) {
            try {
              const parsed = pool.interface.parseLog(log);
              if (parsed?.name === "Deposit") {
                leafIndex = Number(parsed.args["leafIndex"]);
                console.log("Leaf index:", leafIndex);
              }
            } catch {
              // Not a pool log
            }
          }

          saveNote({
            ...note,
            leafIndex,
            txHash: tx.hash,
            createdAt: new Date().toISOString(),
          });
          console.log(`\nNote saved to notes/${note.commitment}.json`);

          // Optional stealth announcement
          if (opts.to) {
            if (!opts.toY) {
              console.error(
                "Error: --to-y is required when announcing a stealth payment (provide recipient viewing pubkey Y)"
              );
              process.exit(1);
            }
            const recipientPubKeyX = BigInt(opts.to);
            const recipientPubKeyY = BigInt(opts.toY);

            console.log("\nAnnouncing stealth payment...");
            const stealth = await deriveStealthKeypair(recipientPubKeyX, recipientPubKeyY);

            const registry = getStealthRegistry(wallet);
            const announceTx = await registry["announceStealthPayment"](
              note.commitment,
              stealth.ephemeralPubKeyX,
              stealth.ephemeralPubKeyY,
              stealth.stealthPubKeyX,
              stealth.stealthPubKeyY
            );
            await announceTx.wait();
            console.log("Stealth payment announced:", announceTx.hash);
          }
        } catch (err) {
          console.error("deposit failed:", (err as Error).message);
          process.exit(1);
        }
      }
    );
}
