import { Command } from "commander";
import { getProvider, getWallet, getStealthRegistry, loadFirstKeys, loadKeys } from "./utils.js";

export function registerRegister(program: Command): void {
  program
    .command("register")
    .description("Register your viewing public key on-chain via StealthRegistry")
    .option("--rpc <url>", "RPC URL")
    .option("--address <addr>", "Use keys for this ETH address (defaults to PRIVATE_KEY address)")
    .option("--pubkey-x <x>", "Viewing pubkey X (skips key file lookup)")
    .option("--pubkey-y <y>", "Viewing pubkey Y (skips key file lookup)")
    .action(
      async (opts: {
        rpc?: string;
        address?: string;
        pubkeyX?: string;
        pubkeyY?: string;
      }) => {
        try {
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

          console.log("Registering viewing public key on StealthRegistry...");
          console.log("  pubKeyX:", pubKeyX.toString());
          console.log("  pubKeyY:", pubKeyY.toString());

          const registry = getStealthRegistry(wallet);
          const tx = await registry["registerViewingKey"](pubKeyX, pubKeyY);
          console.log("Transaction sent:", tx.hash);

          const receipt = await tx.wait();
          console.log("Confirmed in block:", receipt.blockNumber);
          console.log("Viewing key registered successfully.");
        } catch (err) {
          console.error("register failed:", (err as Error).message);
          process.exit(1);
        }
      }
    );
}
