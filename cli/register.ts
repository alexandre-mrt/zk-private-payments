import { Command } from "commander";
import { getProvider, getWallet, getStealthRegistry, loadFirstKeys, loadKeys, log } from "./utils.js";

export function registerRegister(program: Command): void {
  program
    .command("register")
    .description("Register your viewing public key on-chain via StealthRegistry")
    .option("--rpc <url>", "RPC URL")
    .option("--address <addr>", "Use keys for this ETH address (defaults to PRIVATE_KEY address)")
    .option("--pubkey-x <x>", "Viewing pubkey X (skips key file lookup)")
    .option("--pubkey-y <y>", "Viewing pubkey Y (skips key file lookup)")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay register
  $ zk-pay register --address 0xYourAddress
  $ zk-pay register --pubkey-x 1234567 --pubkey-y 9876543
`
    )
    .action(
      async (opts: {
        rpc?: string;
        address?: string;
        pubkeyX?: string;
        pubkeyY?: string;
      }) => {
        const rpcUrl = opts.rpc ?? process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
        try {
          // Validate: if one pubkey coord is given, both must be given
          if ((opts.pubkeyX && !opts.pubkeyY) || (!opts.pubkeyX && opts.pubkeyY)) {
            log.error("Both --pubkey-x and --pubkey-y must be provided together.");
            process.exit(1);
          }

          const provider = getProvider(opts.rpc);
          const wallet = getWallet(provider);

          let pubKeyX: bigint;
          let pubKeyY: bigint;

          if (opts.pubkeyX && opts.pubkeyY) {
            pubKeyX = BigInt(opts.pubkeyX);
            pubKeyY = BigInt(opts.pubkeyY);
          } else {
            const keys = opts.address ? loadKeys(opts.address) : loadFirstKeys();
            pubKeyX = keys.viewingPubKey.x;
            pubKeyY = keys.viewingPubKey.y;
          }

          log.info("Registering viewing public key on StealthRegistry...");
          log.step(`pubKeyX: ${pubKeyX.toString()}`);
          log.step(`pubKeyY: ${pubKeyY.toString()}`);

          const registry = getStealthRegistry(wallet);
          const tx = await registry["registerViewingKey"](pubKeyX, pubKeyY);
          log.step(`Transaction sent: ${tx.hash}`);

          const receipt = await tx.wait();
          log.step(`Confirmed in block: ${receipt.blockNumber}`);
          log.success("Viewing key registered.");
        } catch (err) {
          const message = (err as Error).message;
          if (message.includes("PRIVATE_KEY") || message.includes("key file") || message.includes("No key files")) {
            log.error(message);
          } else {
            log.error(`Failed to connect to RPC at ${rpcUrl}: ${message}`);
          }
          process.exit(1);
        }
      }
    );
}
