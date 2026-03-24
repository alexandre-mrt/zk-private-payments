import { Command } from "commander";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { generateKeypair } from "./crypto.js";
import { saveKeys, getProvider, getWallet, ensureDirs } from "./utils.js";

export function registerKeygen(program: Command): void {
  program
    .command("keygen")
    .description("Generate a BabyJubjub spending and viewing keypair")
    .option("--rpc <url>", "RPC URL")
    .action(async (opts: { rpc?: string }) => {
      try {
        ensureDirs();
        const provider = getProvider(opts.rpc);
        const wallet = getWallet(provider);
        const address = wallet.address;

        console.log(`Generating keypair for address: ${address}`);
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

        console.log("\nKeypair generated and saved to keys/" + address + ".json");
        console.log("Also appended SPENDING_KEY and VIEWING_KEY to .env\n");

        console.log("Spending public key:");
        console.log("  x:", keys.spendingPubKey.x.toString());
        console.log("  y:", keys.spendingPubKey.y.toString());
        console.log("\nViewing public key:");
        console.log("  x:", keys.viewingPubKey.x.toString());
        console.log("  y:", keys.viewingPubKey.y.toString());
      } catch (err) {
        console.error("keygen failed:", (err as Error).message);
        process.exit(1);
      }
    });
}
