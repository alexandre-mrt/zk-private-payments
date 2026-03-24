import { Command } from "commander";
import { deriveSharedSecret } from "./crypto.js";
import { buildPoseidon, buildBabyjub } from "circomlibjs";
import {
  getProvider,
  getStealthRegistry,
  getConfidentialPool,
  loadFirstKeys,
  loadAllNotes,
  saveNote,
  log,
} from "./utils.js";

export function registerScan(program: Command): void {
  program
    .command("scan")
    .description("Scan chain for notes and stealth payments belonging to you")
    .option("--from-block <n>", "Start block number", "0")
    .option("--rpc <url>", "RPC URL")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay scan
  $ zk-pay scan --from-block 1000
  $ zk-pay scan --rpc http://localhost:8545
`
    )
    .action(async (opts: { fromBlock?: string; rpc?: string }) => {
      const rpcUrl = opts.rpc ?? process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
      try {
        // Validate from-block
        const fromBlockNum = Number(opts.fromBlock ?? 0);
        if (Number.isNaN(fromBlockNum) || fromBlockNum < 0) {
          log.error(`Invalid --from-block value: "${opts.fromBlock}". Must be a non-negative integer.`);
          process.exit(1);
        }

        const provider = getProvider(opts.rpc);
        const keys = loadFirstKeys();

        log.info(`Scanning from block ${fromBlockNum}...`);
        log.step(`Using viewing key for: ${keys.address}`);

        const registry = getStealthRegistry(provider);
        const pool = getConfidentialPool(provider);

        // 1. Fetch StealthPayment events
        const stealthFilter = registry.filters["StealthPayment"]();
        const stealthEvents = await registry.queryFilter(stealthFilter, fromBlockNum);
        log.step(`Found ${stealthEvents.length} StealthPayment event(s)`);

        const poseidon = await buildPoseidon();
        const pF = poseidon.F;
        const babyjub = await buildBabyjub();
        const bjF = babyjub.F;

        let stealthFound = 0;
        for (const event of stealthEvents) {
          const txLog = registry.interface.parseLog(event);
          if (!txLog) continue;

          const ephPubKeyX = BigInt(txLog.args["ephemeralPubKeyX"].toString());
          const ephPubKeyY = BigInt(txLog.args["ephemeralPubKeyY"].toString());
          const stealthPubKeyX = BigInt(txLog.args["stealthPubKeyX"].toString());
          const commitment = BigInt(txLog.args["commitment"].toString());

          // Full stealth address derivation:
          // 1. sharedSecret = viewingKey * ephemeralPubKey
          const shared = await deriveSharedSecret(keys.viewingKey, ephPubKeyX, ephPubKeyY);
          // 2. stealthScalar = Poseidon(sharedSecret.x)
          const stealthScalar = pF.toObject(poseidon([shared.x]));
          // 3. stealthPoint = stealthScalar * G + spendingPubKey
          const scalarG = babyjub.mulPointEscalar(babyjub.Base8, stealthScalar);
          const spendPoint: [unknown, unknown] = [
            bjF.e(keys.spendingPubKey.x),
            bjF.e(keys.spendingPubKey.y),
          ];
          const derivedStealth = babyjub.addPoint(scalarG, spendPoint);
          const derivedX = bjF.toObject(derivedStealth[0]);

          // Compare derived stealth X with announced stealth X
          if (derivedX === stealthPubKeyX) {
            log.success(`Found matching stealth payment, commitment: ${commitment}`);
            stealthFound++;
          }
        }

        // 2. Fetch Deposit events and match to our known notes
        const depositFilter = pool.filters["Deposit"]();
        const depositEvents = await pool.queryFilter(depositFilter, fromBlockNum);
        log.step(`Found ${depositEvents.length} Deposit event(s)`);

        const existingNotes = loadAllNotes();
        const knownCommitments = new Set(existingNotes.map((n) => n.commitment.toString()));

        let notesFound = 0;
        for (const event of depositEvents) {
          const txLog = pool.interface.parseLog(event);
          if (!txLog) continue;

          const commitment = BigInt(txLog.args["commitment"].toString());
          const leafIndex = Number(txLog.args["leafIndex"].toString());

          if (knownCommitments.has(commitment.toString())) {
            // Update leafIndex if missing
            const existing = existingNotes.find((n) => n.commitment === commitment);
            if (existing && existing.leafIndex === undefined) {
              saveNote({ ...existing, leafIndex, spent: existing.spent ?? false });
              log.step(`Updated leaf index for commitment ${commitment} -> index ${leafIndex}`);
            }
            notesFound++;
          }
        }

        log.success("Scan complete.");
        log.step(`Stealth payments matched:   ${stealthFound}`);
        log.step(`Known notes found on-chain: ${notesFound}`);
        log.step(`Total local notes:          ${existingNotes.length}`);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("No key files") || message.includes("deployment.json")) {
          log.error(message);
        } else {
          log.error(`Failed to connect to RPC at ${rpcUrl}: ${message}`);
        }
        process.exit(1);
      }
    });
}
