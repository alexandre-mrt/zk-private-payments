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

export function registerWithdraw(program: Command): void {
  program
    .command("withdraw")
    .description("Withdraw ETH from a private note to a public address")
    .requiredOption("--note <commitment>", "Commitment of the note to withdraw from")
    .requiredOption("--amount <ETH>", "Amount in ETH to withdraw")
    .requiredOption("--to <address>", "Recipient ETH address")
    .option("--relayer <address>", "Relayer address to pay a submission fee (optional)")
    .option("--fee <ETH>", "Fee in ETH to pay to the relayer (optional, requires --relayer)")
    .option("--rpc <url>", "RPC URL")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay withdraw --note <commitment> --amount 1.0 --to 0xRecipientAddress
  $ zk-pay withdraw --note <commitment> --amount 0.5 --to 0xRecipientAddress --rpc http://localhost:8545
  $ zk-pay withdraw --note <commitment> --amount 1.0 --to 0xRecipientAddress --relayer 0xRelayerAddress --fee 0.01

Notes:
  Run 'zk-pay scan' first to ensure your note has a leafIndex.
  Any remaining amount is saved as a change note.
  When --relayer and --fee are provided, (amount - fee) goes to recipient and fee goes to the relayer.
`
    )
    .action(
      async (opts: {
        note: string;
        amount: string;
        to: string;
        relayer?: string;
        fee?: string;
        rpc?: string;
      }) => {
        const rpcUrl = opts.rpc ?? process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
        try {
          // Validate recipient address before async work
          if (!ethers.isAddress(opts.to)) {
            log.error(`Invalid recipient address: "${opts.to}". Must be a valid Ethereum address.`);
            process.exit(1);
          }

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

          // Validate relayer + fee options
          const relayerAddress: string = opts.relayer ?? ethers.ZeroAddress;
          let feeWei = 0n;

          if (opts.relayer !== undefined && !ethers.isAddress(opts.relayer)) {
            log.error(`Invalid relayer address: "${opts.relayer}". Must be a valid Ethereum address.`);
            process.exit(1);
          }

          if (opts.fee !== undefined) {
            const parsedFee = Number.parseFloat(opts.fee);
            if (Number.isNaN(parsedFee) || parsedFee < 0) {
              log.error(`Invalid fee: "${opts.fee}". Fee must be a non-negative number.`);
              process.exit(1);
            }
            feeWei = ethers.parseEther(opts.fee);
          }

          if (feeWei > 0n && relayerAddress === ethers.ZeroAddress) {
            log.error("--relayer must be specified when --fee is non-zero.");
            process.exit(1);
          }

          const provider = getProvider(opts.rpc);
          const wallet = getWallet(provider);
          const keys = loadFirstKeys();

          const inputNote = loadNote(opts.note);
          const withdrawAmountWei = ethers.parseEther(opts.amount);

          if (withdrawAmountWei > inputNote.amount) {
            log.error(
              `Withdrawal amount (${opts.amount} ETH) exceeds note amount (${ethers.formatEther(inputNote.amount)} ETH).`
            );
            process.exit(1);
          }

          const changeAmount = inputNote.amount - withdrawAmountWei;

          // Build Merkle tree from all on-chain commitment events
          log.info("Building Merkle tree from chain...");
          const pool = getConfidentialPool(provider);
          const tree = await buildFullMerkleTree(pool);
          const root = tree.root;

          const leafIndex = inputNote.leafIndex;
          if (leafIndex === undefined) {
            log.error("Note file found but is missing leafIndex. Did you run 'zk-pay scan' first?");
            process.exit(1);
          }

          const { pathElements, pathIndices } = tree.getProof(leafIndex);
          const nullifier = await computeNullifier(inputNote.commitment, keys.spendingKey);

          // Change note (zero amount if full withdrawal)
          const changeNote = await createNote(changeAmount, keys.spendingPubKey.x);

          // Bind recipient address as field element
          const recipientBigInt = BigInt(opts.to);

          log.info("Generating ZK proof...");
          const wasmPath = path.join(CLI_DIRS.circuits, "withdraw", "withdraw_js", "withdraw.wasm");
          const zkeyPath = path.join(CLI_DIRS.circuits, "withdraw", "withdraw_final.zkey");

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

          log.info("Submitting withdrawal transaction...");
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
            changeNote.commitment,
            relayerAddress,
            feeWei
          );
          log.step(`Transaction sent: ${tx.hash}`);

          const receipt = await tx.wait();
          log.step(`Confirmed in block: ${receipt.blockNumber}`);

          markNoteSpent(opts.note);

          if (changeAmount > 0n) {
            saveNote({ ...changeNote, txHash: tx.hash, createdAt: new Date().toISOString() });
            log.step(
              `Change note saved: ${ethers.formatEther(changeAmount)} ETH -> commitment ${changeNote.commitment}`
            );
          }

          log.success("Withdrawal complete.");
          log.step(`Withdrew: ${ethers.formatEther(withdrawAmountWei)} ETH`);
          log.step(`To:       ${opts.to}`);
          if (feeWei > 0n) {
            log.step(`Fee:      ${ethers.formatEther(feeWei)} ETH -> ${relayerAddress}`);
          }
          log.step(`Tx hash:  ${tx.hash}`);
        } catch (err) {
          const message = (err as Error).message;
          if (
            message.includes("PRIVATE_KEY") ||
            message.includes("Note not found") ||
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
