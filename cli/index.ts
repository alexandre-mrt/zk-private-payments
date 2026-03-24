import "dotenv/config";
import { Command } from "commander";
import { registerKeygen } from "./keygen.js";
import { registerRegister } from "./register.js";
import { registerDeposit } from "./deposit.js";
import { registerScan } from "./scan.js";
import { registerTransfer } from "./transfer.js";
import { registerWithdraw } from "./withdraw.js";
import { registerBalance } from "./balance.js";

const program = new Command();

program
  .name("zk-pay")
  .description("ZK Private Payments CLI — stealth addresses + confidential amounts")
  .version("0.1.0")
  .option("-v, --verbose", "Show detailed output (tx hashes, gas, note details)");

registerKeygen(program);
registerRegister(program);
registerDeposit(program);
registerScan(program);
registerTransfer(program);
registerWithdraw(program);
registerBalance(program);

program.parseAsync(process.argv).catch((err: Error) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
