import { run } from "hardhat";
import fs from "fs";

interface DeploymentAddresses {
  hasher: string;
  transferVerifier: string;
  withdrawVerifier: string;
  stealthRegistry: string;
  confidentialPool: string;
  merkleTreeHeight: number;
}

async function main(): Promise<void> {
  if (!fs.existsSync("deployment.json")) {
    console.error("deployment.json not found. Run deploy script first.");
    process.exit(1);
  }

  const addresses: DeploymentAddresses = JSON.parse(
    fs.readFileSync("deployment.json", "utf-8")
  );

  console.log("Verifying contracts on Etherscan...\n");

  // Verify TransferVerifier (no constructor args)
  try {
    console.log("Verifying TransferVerifier...");
    await run("verify:verify", {
      address: addresses.transferVerifier,
      constructorArguments: [],
    });
    console.log("TransferVerifier verified!\n");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Already Verified")) {
      console.log("TransferVerifier already verified.\n");
    } else {
      console.error("TransferVerifier verification failed:", message, "\n");
    }
  }

  // Verify WithdrawVerifier (no constructor args)
  try {
    console.log("Verifying WithdrawVerifier...");
    await run("verify:verify", {
      address: addresses.withdrawVerifier,
      constructorArguments: [],
    });
    console.log("WithdrawVerifier verified!\n");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Already Verified")) {
      console.log("WithdrawVerifier already verified.\n");
    } else {
      console.error("WithdrawVerifier verification failed:", message, "\n");
    }
  }

  // Verify StealthRegistry (no constructor args)
  try {
    console.log("Verifying StealthRegistry...");
    await run("verify:verify", {
      address: addresses.stealthRegistry,
      constructorArguments: [],
    });
    console.log("StealthRegistry verified!\n");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Already Verified")) {
      console.log("StealthRegistry already verified.\n");
    } else {
      console.error("StealthRegistry verification failed:", message, "\n");
    }
  }

  // Verify ConfidentialPool (has constructor args)
  try {
    console.log("Verifying ConfidentialPool...");
    await run("verify:verify", {
      address: addresses.confidentialPool,
      constructorArguments: [
        addresses.transferVerifier,
        addresses.withdrawVerifier,
        addresses.merkleTreeHeight,
        addresses.hasher,
      ],
    });
    console.log("ConfidentialPool verified!\n");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Already Verified")) {
      console.log("ConfidentialPool already verified.\n");
    } else {
      console.error("ConfidentialPool verification failed:", message, "\n");
    }
  }

  console.log("Verification complete!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
