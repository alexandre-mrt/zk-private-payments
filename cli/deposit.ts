import { Command } from "commander";
import { ethers } from "ethers";
import { createNote, deriveStealthKeypair, encryptNoteData } from "./crypto.js";
import {
  getProvider,
  getWallet,
  getConfidentialPool,
  getStealthRegistry,
  loadFirstKeys,
  saveNote,
  log,
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
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay deposit --amount 1.0
  $ zk-pay deposit --amount 0.5 --to <recipientPubKeyX> --to-y <recipientPubKeyY>
  $ zk-pay deposit --amount 1.0 --rpc http://localhost:8545
`
    )
    .action(
      async (opts: {
        amount: string;
        to?: string;
        toY?: string;
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

          // Validate stealth payment args
          if (opts.to && !opts.toY) {
            log.error("--to-y is required when announcing a stealth payment (provide recipient viewing pubkey Y).");
            process.exit(1);
          }

          const provider = getProvider(opts.rpc);
          const wallet = getWallet(provider);
          const keys = loadFirstKeys();

          const amountWei = ethers.parseEther(opts.amount);

          log.info(`Creating note for ${opts.amount} ETH...`);
          const note = await createNote(amountWei, keys.spendingPubKey.x);

          log.step(`commitment: ${note.commitment.toString()}`);
          log.step(`blinding:   ${note.blinding.toString()}`);

          const pool = getConfidentialPool(wallet);
          log.info("Submitting deposit transaction...");

          const tx = await pool["deposit"](note.commitment, { value: amountWei });
          log.step(`Transaction sent: ${tx.hash}`);

          const receipt = await tx.wait();
          log.step(`Confirmed in block: ${receipt.blockNumber}`);

          // Find the leaf index from the Deposit event
          let leafIndex: number | undefined;
          for (const txLog of receipt.logs) {
            try {
              const parsed = pool.interface.parseLog(txLog);
              if (parsed?.name === "Deposit") {
                leafIndex = Number(parsed.args["leafIndex"]);
                log.step(`Leaf index: ${leafIndex}`);
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
          log.success(`Note saved to notes/${note.commitment}.json`);

          // Optional stealth announcement with encrypted note data
          if (opts.to && opts.toY) {
            const recipientPubKeyX = BigInt(opts.to);
            const recipientPubKeyY = BigInt(opts.toY);

            log.info("Announcing stealth payment...");
            const stealth = await deriveStealthKeypair(recipientPubKeyX, recipientPubKeyY);

            // Encrypt note data so the receiver can reconstruct the note from the event
            const { encryptedAmount, encryptedBlinding } = await encryptNoteData(
              note.amount,
              note.blinding,
              stealth.sharedPointX,
              stealth.sharedPointY
            );

            const registry = getStealthRegistry(wallet);
            const announceTx = await registry["announceStealthPayment"](
              note.commitment,
              stealth.ephemeralPubKeyX,
              stealth.ephemeralPubKeyY,
              stealth.stealthPubKeyX,
              stealth.stealthPubKeyY,
              encryptedAmount,
              encryptedBlinding
            );
            await announceTx.wait();
            log.success(`Stealth payment announced: ${announceTx.hash}`);
          }
        } catch (err) {
          const message = (err as Error).message;
          if (
            message.includes("PRIVATE_KEY") ||
            message.includes("No key files") ||
            message.includes("deployment.json")
          ) {
            log.error(message);
          } else {
            log.error(`Failed to connect to RPC at ${rpcUrl}: ${message}`);
          }
          process.exit(1);
        }
      }
    );
}
