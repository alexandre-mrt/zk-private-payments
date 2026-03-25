import "dotenv/config";
import { Command } from "commander";
import { ethers } from "ethers";
import { CONFIDENTIAL_POOL_ABI, DEFAULT_RPC_URL, loadDeployment } from "./config.js";
import { log } from "./utils.js";

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description("Watch for real-time deposit, transfer, and withdrawal events")
    .option("--rpc <url>", "RPC endpoint URL", DEFAULT_RPC_URL)
    .option("--pool <address>", "ConfidentialPool contract address (overrides deployment.json)")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay watch
  $ zk-pay watch --rpc ws://localhost:8545
`
    )
    .action(async (opts: { rpc?: string; pool?: string }) => {
      try {
        const deployment = loadDeployment();
        const poolAddress = opts.pool ?? deployment.confidentialPool;

        // Use WebSocket provider for real-time events, fallback to polling HTTP
        let provider: ethers.Provider;
        const rpcUrl = opts.rpc ?? DEFAULT_RPC_URL;
        if (rpcUrl.startsWith("ws")) {
          provider = new ethers.WebSocketProvider(rpcUrl);
        } else {
          provider = new ethers.JsonRpcProvider(rpcUrl);
        }

        const contract = new ethers.Contract(poolAddress, CONFIDENTIAL_POOL_ABI, provider);

        log.info(`Watching events on ${poolAddress}...`);
        log.info("Press Ctrl+C to stop\n");

        contract.on(
          "Deposit",
          (commitment: bigint, leafIndex: bigint, amount: bigint, timestamp: bigint) => {
            const time = new Date(Number(timestamp) * 1000).toISOString();
            log.success(
              `[DEPOSIT] Leaf #${leafIndex} | Amount: ${ethers.formatEther(amount)} ETH | Commitment: ${commitment.toString(16).substring(0, 16)}... | ${time}`
            );
          }
        );

        contract.on(
          "Transfer",
          (nullifier: bigint, outputCommitment1: bigint, outputCommitment2: bigint) => {
            log.success(
              `[TRANSFER] Nullifier: ${nullifier.toString(16).substring(0, 16)}... | Out1: ${outputCommitment1.toString(16).substring(0, 16)}... | Out2: ${outputCommitment2.toString(16).substring(0, 16)}...`
            );
          }
        );

        contract.on(
          "Withdrawal",
          (nullifier: bigint, amount: bigint, recipient: string) => {
            log.success(
              `[WITHDRAW] Amount: ${ethers.formatEther(amount)} ETH | Recipient: ${recipient} | Nullifier: ${nullifier.toString(16).substring(0, 16)}...`
            );
          }
        );

        // Keep process alive
        await new Promise(() => {});
      } catch (err) {
        log.error(`Watch failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
