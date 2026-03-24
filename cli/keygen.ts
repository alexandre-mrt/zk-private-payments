import { Command } from "commander";
import fs from "fs";
import path from "path";
import { generateKeypair } from "./crypto.js";
import { saveKeys, getProvider, getWallet, ensureDirs, log } from "./utils.js";

export function registerKeygen(program: Command): void {
  program
    .command("keygen")
    .description("Generate a BabyJubjub spending and viewing keypair")
    .option("--rpc <url>", "RPC URL")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay keygen
  $ zk-pay keygen --rpc http://localhost:8545
`
    )
    .action(async (opts: { rpc?: string }) => {
      const rpcUrl = opts.rpc ?? process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
      try {
        ensureDirs();
        const provider = getProvider(opts.rpc);
        const wallet = getWallet(provider);
        const address = wallet.address;

        log.info(`Generating keypair for address: ${address}`);
        const keys = await generateKeypair();

        const stored = { ...keys, address };
        saveKeys(stored);

        // Persist keys to .env (append if not already set)
        const envPath = path.join(process.cwd(), ".env");
        const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
        const lines = envContent.split("\n");

        const updateEnv = (key: string, value: string): void => {
          const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
          if (idx >= 0) {
            lines[idx] = `${key}=${value}`;
          } else {
            lines.push(`${key}=${value}`);
          }
        };

        updateEnv("SPENDING_KEY", keys.spendingKey.toString());
        updateEnv("VIEWING_KEY", keys.viewingKey.toString());

        fs.writeFileSync(envPath, lines.filter((l) => l !== "").join("\n") + "\n");

        log.success(`Keypair saved to keys/${address}.json`);
        log.step("Also appended SPENDING_KEY and VIEWING_KEY to .env");

        log.step("Spending public key:");
        log.step(`  x: ${keys.spendingPubKey.x.toString()}`);
        log.step(`  y: ${keys.spendingPubKey.y.toString()}`);
        log.step("Viewing public key:");
        log.step(`  x: ${keys.viewingPubKey.x.toString()}`);
        log.step(`  y: ${keys.viewingPubKey.y.toString()}`);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("PRIVATE_KEY")) {
          log.error(message);
        } else {
          log.error(`Failed to connect to RPC at ${rpcUrl}: ${message}`);
        }
        process.exit(1);
      }
    });
}
