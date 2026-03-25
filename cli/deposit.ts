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
      "--to <viewingPubKeyX>",
      "Recipient viewing pubkey X (for ECDH shared secret — announce stealth payment)"
    )
    .option("--to-y <viewingPubKeyY>", "Recipient viewing pubkey Y")
    .option("--to-spend-x <spendingPubKeyX>", "Recipient spending pubkey X")
    .option("--to-spend-y <spendingPubKeyY>", "Recipient spending pubkey Y")
    .option("--rpc <url>", "RPC URL")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay deposit --amount 1.0
  $ zk-pay deposit --amount 0.5 --to <viewingPubKeyX> --to-y <viewingPubKeyY> --to-spend-x <spendingPubKeyX> --to-spend-y <spendingPubKeyY>
  $ zk-pay deposit --amount 1.0 --rpc http://localhost:8545
`
    )
    .action(
      async (opts: {
        amount: string;
        to?: string;
        toY?: string;
        toSpendX?: string;
        toSpendY?: string;
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
          if (opts.to && (!opts.toY || !opts.toSpendX || !opts.toSpendY)) {
            log.error("--to-y, --to-spend-x, and --to-spend-y are all required when announcing a stealth payment.");
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
          if (opts.to && opts.toY && opts.toSpendX && opts.toSpendY) {
            const recipientViewingPubKeyX = BigInt(opts.to);
            const recipientViewingPubKeyY = BigInt(opts.toY);
            const recipientSpendingPubKeyX = BigInt(opts.toSpendX);
            const recipientSpendingPubKeyY = BigInt(opts.toSpendY);

            log.info("Announcing stealth payment...");
            const stealth = await deriveStealthKeypair(
              recipientViewingPubKeyX,
              recipientViewingPubKeyY,
              recipientSpendingPubKeyX,
              recipientSpendingPubKeyY
            );

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
