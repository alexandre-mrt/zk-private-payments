import "dotenv/config";
import { Command } from "commander";
import { ethers } from "ethers";
import { getProvider, getConfidentialPool, getStealthRegistry, log } from "./utils.js";

const EVENT_COLORS: Record<string, string> = {
  DEPOSIT: "\x1b[32m",
  TRANSFER: "\x1b[34m",
  WITHDRAWAL: "\x1b[33m",
  STEALTH: "\x1b[35m",
};

const RESET = "\x1b[0m";

type EventType = "deposit" | "transfer" | "withdrawal" | "stealth" | "all";

interface ParsedEvent {
  type: string;
  block: number;
  logIndex: number;
  data: string;
}

function colorType(type: string): string {
  const color = EVENT_COLORS[type] ?? "";
  return `${color}[${type}]${RESET}`;
}

async function collectDepositEvents(
  pool: ethers.Contract,
  fromBlock: number
): Promise<ParsedEvent[]> {
  const logs = await pool.queryFilter(pool.filters["Deposit"](), fromBlock);
  const results: ParsedEvent[] = [];
  for (const e of logs) {
    const parsed = pool.interface.parseLog(e);
    if (!parsed) continue;
    results.push({
      type: "DEPOSIT",
      block: e.blockNumber,
      logIndex: e.index,
      data: `Amount: ${ethers.formatEther(parsed.args["amount"])} ETH | Leaf: ${parsed.args["leafIndex"]} | Commitment: ${parsed.args["commitment"].toString(16).substring(0, 16)}...`,
    });
  }
  return results;
}

async function collectTransferEvents(
  pool: ethers.Contract,
  fromBlock: number
): Promise<ParsedEvent[]> {
  const logs = await pool.queryFilter(pool.filters["Transfer"](), fromBlock);
  const results: ParsedEvent[] = [];
  for (const e of logs) {
    const parsed = pool.interface.parseLog(e);
    if (!parsed) continue;
    results.push({
      type: "TRANSFER",
      block: e.blockNumber,
      logIndex: e.index,
      data: `Nullifier: ${parsed.args["nullifier"].toString(16).substring(0, 16)}... | Out1: ${parsed.args["outputCommitment1"].toString(16).substring(0, 12)}... | Out2: ${parsed.args["outputCommitment2"].toString(16).substring(0, 12)}...`,
    });
  }
  return results;
}

async function collectWithdrawalEvents(
  pool: ethers.Contract,
  fromBlock: number
): Promise<ParsedEvent[]> {
  const logs = await pool.queryFilter(pool.filters["Withdrawal"](), fromBlock);
  const results: ParsedEvent[] = [];
  for (const e of logs) {
    const parsed = pool.interface.parseLog(e);
    if (!parsed) continue;
    results.push({
      type: "WITHDRAWAL",
      block: e.blockNumber,
      logIndex: e.index,
      data: `Amount: ${ethers.formatEther(parsed.args["amount"])} ETH | Recipient: ${parsed.args["recipient"]} | Nullifier: ${parsed.args["nullifier"].toString(16).substring(0, 16)}...`,
    });
  }
  return results;
}

async function collectStealthEvents(
  registry: ethers.Contract,
  fromBlock: number
): Promise<ParsedEvent[]> {
  const logs = await registry.queryFilter(registry.filters["StealthPayment"](), fromBlock);
  const results: ParsedEvent[] = [];
  for (const e of logs) {
    const parsed = registry.interface.parseLog(e);
    if (!parsed) continue;
    results.push({
      type: "STEALTH",
      block: e.blockNumber,
      logIndex: e.index,
      data: `Commitment: ${parsed.args["commitment"].toString(16).substring(0, 16)}... | EphKey: ${parsed.args["ephemeralPubKeyX"].toString(16).substring(0, 12)}...`,
    });
  }
  return results;
}

export function registerEvents(program: Command): void {
  program
    .command("events")
    .description("Query and display contract events with filtering")
    .option(
      "--type <type>",
      "Event type: deposit, transfer, withdrawal, stealth, all",
      "all"
    )
    .option("--from-block <n>", "Start block", "0")
    .option("--limit <n>", "Max events to show", "50")
    .option("--rpc <url>", "RPC URL")
    .addHelpText(
      "after",
      `
Examples:
  $ zk-pay events
  $ zk-pay events --type deposit --limit 10
  $ zk-pay events --type stealth --from-block 1000
`
    )
    .action(async (opts: { type?: string; fromBlock?: string; limit?: string; rpc?: string }) => {
      try {
        const provider = getProvider(opts.rpc);
        const pool = getConfidentialPool(provider);
        const registry = getStealthRegistry(provider);
        const fromBlock = Number(opts.fromBlock ?? "0");
        const limit = Number(opts.limit ?? "50");
        const type = (opts.type ?? "all") as EventType;

        const collectors: Array<Promise<ParsedEvent[]>> = [];

        if (type === "all" || type === "deposit") {
          collectors.push(collectDepositEvents(pool, fromBlock));
        }
        if (type === "all" || type === "transfer") {
          collectors.push(collectTransferEvents(pool, fromBlock));
        }
        if (type === "all" || type === "withdrawal") {
          collectors.push(collectWithdrawalEvents(pool, fromBlock));
        }
        if (type === "all" || type === "stealth") {
          collectors.push(collectStealthEvents(registry, fromBlock));
        }

        const batches = await Promise.all(collectors);
        const events = batches
          .flat()
          .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

        const displayed = events.slice(0, limit);

        log.info(
          `Showing ${displayed.length} of ${events.length} events (from block ${fromBlock})\n`
        );

        for (const e of displayed) {
          console.log(`  ${colorType(e.type)} Block ${e.block} | ${e.data}`);
        }

        if (events.length > limit) {
          log.step(`... and ${events.length - limit} more. Use --limit to show more.`);
        }
      } catch (err) {
        log.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
