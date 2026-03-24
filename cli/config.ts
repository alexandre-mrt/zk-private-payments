import fs from "fs";
import path from "path";

export const DEFAULT_RPC_URL = "http://127.0.0.1:8545";
export const MERKLE_TREE_HEIGHT = 20;

export const CONFIDENTIAL_POOL_ABI = [
  "function deposit(uint256 _commitment) payable",
  "function transfer(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256 _root, uint256 _nullifier, uint256 _outputCommitment1, uint256 _outputCommitment2)",
  "function withdraw(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256 _root, uint256 _nullifier, uint256 _amount, address _recipient, uint256 _changeCommitment)",
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "function nullifiers(uint256) view returns (bool)",
  "function commitments(uint256) view returns (bool)",
  "event Deposit(uint256 indexed commitment, uint32 leafIndex, uint256 amount, uint256 timestamp)",
  "event Transfer(uint256 nullifier, uint256 outputCommitment1, uint256 outputCommitment2)",
  "event Withdrawal(uint256 nullifier, uint256 amount, address recipient, uint256 changeCommitment)",
] as const;

export const STEALTH_REGISTRY_ABI = [
  "function registerViewingKey(uint256 _pubKeyX, uint256 _pubKeyY)",
  "function getViewingKey(address _owner) view returns (uint256 pubKeyX, uint256 pubKeyY)",
  "function announceStealthPayment(uint256 _commitment, uint256 _ephemeralPubKeyX, uint256 _ephemeralPubKeyY, uint256 _stealthPubKeyX, uint256 _stealthPubKeyY)",
  "event StealthPayment(uint256 indexed commitment, uint256 ephemeralPubKeyX, uint256 ephemeralPubKeyY, uint256 stealthPubKeyX, uint256 stealthPubKeyY)",
  "event ViewingKeyRegistered(address owner, uint256 pubKeyX, uint256 pubKeyY)",
] as const;

export interface DeploymentAddresses {
  confidentialPool: string;
  stealthRegistry: string;
  hasher?: string;
  transferVerifier?: string;
  withdrawVerifier?: string;
  network?: string;
}

export function loadDeployment(deploymentPath?: string): DeploymentAddresses {
  const filePath = deploymentPath ?? path.join(process.cwd(), "deployment.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `deployment.json not found at ${filePath}. Run 'npx hardhat run scripts/deploy.ts --network localhost' first.`
    );
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as DeploymentAddresses;
  if (!parsed.confidentialPool || !parsed.stealthRegistry) {
    throw new Error("deployment.json is missing required addresses: confidentialPool, stealthRegistry");
  }
  return parsed;
}

export const CLI_DIRS = {
  keys: path.join(process.cwd(), "keys"),
  notes: path.join(process.cwd(), "notes"),
  circuits: path.join(process.cwd(), "build", "circuits"),
} as const;
