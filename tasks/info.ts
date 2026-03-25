import { task } from "hardhat/config";
import fs from "fs";

const DEPLOYMENT_FILE = "deployment.json";

task("info", "Display deployed contract information and pool status").setAction(
  async (_, hre) => {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
      console.log("No deployment.json found. Run deploy first.");
      return;
    }

    const addresses = JSON.parse(
      fs.readFileSync(DEPLOYMENT_FILE, "utf-8")
    ) as {
      confidentialPool: string;
      transferVerifier: string;
      withdrawVerifier: string;
      stealthRegistry?: string;
      hasher?: string;
      network?: string;
      deployer?: string;
      merkleTreeHeight?: number;
    };

    if (!addresses.confidentialPool) {
      console.log("deployment.json is missing 'confidentialPool' address.");
      return;
    }

    const pool = await hre.ethers.getContractAt(
      "ConfidentialPool",
      addresses.confidentialPool
    );

    const [
      totalDeposited,
      totalWithdrawn,
      totalTransfers,
      depositCount,
      withdrawalCount,
      uniqueDepositors,
      poolBalance,
    ] = await pool.getPoolStats();

    const root = await pool.getLastRoot();
    const paused = await pool.paused();
    const maxWithdrawAmount = await pool.maxWithdrawAmount();
    const minDepositAge = await pool.minDepositAge();
    const allowlistEnabled = await pool.allowlistEnabled();

    const denominations = await pool.getDenominations();
    const activeDenominations: bigint[] = [];
    for (const d of denominations) {
      const allowed = await pool.allowedDenominations(d);
      if (allowed) {
        activeDenominations.push(d);
      }
    }

    console.log("\n  ZK Private Payments — Confidential Pool Status");
    console.log("  " + "=".repeat(50));
    console.log(`  Pool:              ${addresses.confidentialPool}`);
    console.log(`  TransferVerifier:  ${addresses.transferVerifier}`);
    console.log(`  WithdrawVerifier:  ${addresses.withdrawVerifier}`);
    if (addresses.stealthRegistry) {
      console.log(`  StealthRegistry:   ${addresses.stealthRegistry}`);
    }
    console.log(`  Network:           ${addresses.network ?? hre.network.name}`);
    console.log(`  Deposits:          ${depositCount}`);
    console.log(`  Withdrawals:       ${withdrawalCount}`);
    console.log(`  Transfers:         ${totalTransfers}`);
    console.log(`  Unique Depositors: ${uniqueDepositors}`);
    console.log(
      `  Total Deposited:   ${hre.ethers.formatEther(totalDeposited)} ETH`
    );
    console.log(
      `  Total Withdrawn:   ${hre.ethers.formatEther(totalWithdrawn)} ETH`
    );
    console.log(
      `  Pool Balance:      ${hre.ethers.formatEther(poolBalance)} ETH`
    );
    console.log(
      `  Merkle Root:       0x${root.toString(16).substring(0, 16)}...`
    );
    console.log(`  Paused:            ${paused}`);
    console.log(`  Allowlist Active:  ${allowlistEnabled}`);
    console.log(
      `  Min Deposit Age:   ${minDepositAge > 0n ? `${minDepositAge} blocks` : "disabled"}`
    );
    console.log(
      `  Max Withdraw:      ${maxWithdrawAmount > 0n ? `${hre.ethers.formatEther(maxWithdrawAmount)} ETH` : "no limit"}`
    );
    if (activeDenominations.length > 0) {
      const formattedDenoms = activeDenominations
        .map((d) => `${hre.ethers.formatEther(d)} ETH`)
        .join(", ");
      console.log(`  Denominations:     ${formattedDenoms}`);
    } else {
      console.log("  Denominations:     any amount");
    }
    console.log("  " + "=".repeat(50) + "\n");
  }
);
