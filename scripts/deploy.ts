import { ethers } from "hardhat";
// @ts-ignore
import { poseidonContract } from "circomlibjs";
import fs from "fs";

const MERKLE_TREE_HEIGHT = 20;

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with:", deployer.address);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  // 1. Deploy Poseidon hasher
  console.log("\nDeploying Poseidon hasher...");
  const HasherFactory = new ethers.ContractFactory(
    poseidonContract.generateABI(2),
    poseidonContract.createCode(2),
    deployer
  );
  const hasherContract = await HasherFactory.deploy();
  await hasherContract.waitForDeployment();
  const hasherAddress = await hasherContract.getAddress();
  console.log("Hasher deployed to:", hasherAddress);

  // 2. Deploy Verifiers
  console.log("\nDeploying TransferVerifier...");
  const TransferVerifier = await ethers.getContractFactory("TransferVerifier");
  const transferVerifier = await TransferVerifier.deploy();
  await transferVerifier.waitForDeployment();
  console.log("TransferVerifier deployed to:", await transferVerifier.getAddress());

  console.log("\nDeploying WithdrawVerifier...");
  const WithdrawVerifier = await ethers.getContractFactory("WithdrawVerifier");
  const withdrawVerifier = await WithdrawVerifier.deploy();
  await withdrawVerifier.waitForDeployment();
  console.log("WithdrawVerifier deployed to:", await withdrawVerifier.getAddress());

  // 3. Deploy StealthRegistry
  console.log("\nDeploying StealthRegistry...");
  const StealthRegistry = await ethers.getContractFactory("StealthRegistry");
  const stealthRegistry = await StealthRegistry.deploy();
  await stealthRegistry.waitForDeployment();
  console.log("StealthRegistry deployed to:", await stealthRegistry.getAddress());

  // 4. Deploy ConfidentialPool
  console.log("\nDeploying ConfidentialPool...");
  const ConfidentialPool = await ethers.getContractFactory("ConfidentialPool");
  const pool = await ConfidentialPool.deploy(
    await transferVerifier.getAddress(),
    await withdrawVerifier.getAddress(),
    MERKLE_TREE_HEIGHT,
    hasherAddress
  );
  await pool.waitForDeployment();
  console.log("ConfidentialPool deployed to:", await pool.getAddress());

  // 5. Configure default denominations
  console.log("\nConfiguring default denominations...");
  const denominations = [
    ethers.parseEther("0.01"),
    ethers.parseEther("0.1"),
    ethers.parseEther("1"),
    ethers.parseEther("10"),
  ];
  for (const d of denominations) {
    await pool.addDenomination(d);
    console.log(`  Added denomination: ${ethers.formatEther(d)} ETH`);
  }

  // Save addresses
  const addresses = {
    hasher: hasherAddress,
    transferVerifier: await transferVerifier.getAddress(),
    withdrawVerifier: await withdrawVerifier.getAddress(),
    stealthRegistry: await stealthRegistry.getAddress(),
    confidentialPool: await pool.getAddress(),
    network: (await ethers.provider.getNetwork()).name,
    deployer: deployer.address,
    merkleTreeHeight: MERKLE_TREE_HEIGHT,
  };

  fs.writeFileSync("deployment.json", JSON.stringify(addresses, null, 2));
  console.log("\nDeployment addresses saved to deployment.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
