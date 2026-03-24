// ConfidentialPool ABI — minimal subset used by the frontend
export const POOL_ABI = [
  {
    type: "function",
    name: "deposit",
    inputs: [{ name: "commitment", type: "uint256" }],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "pA", type: "uint256[2]" },
      { name: "pB", type: "uint256[2][2]" },
      { name: "pC", type: "uint256[2]" },
      { name: "root", type: "uint256" },
      { name: "nullifier", type: "uint256" },
      { name: "outCommitment1", type: "uint256" },
      { name: "outCommitment2", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      { name: "pA", type: "uint256[2]" },
      { name: "pB", type: "uint256[2][2]" },
      { name: "pC", type: "uint256[2]" },
      { name: "root", type: "uint256" },
      { name: "nullifier", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "changeCommitment", type: "uint256" },
      { name: "relayer", type: "address" },
      { name: "fee", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "batchDeposit",
    inputs: [
      { name: "commitments", type: "uint256[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "getLastRoot",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextIndex",
    inputs: [],
    outputs: [{ type: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDepositCount",
    inputs: [],
    outputs: [{ type: "uint32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPoolBalance",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDenominations",
    inputs: [],
    outputs: [{ type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "minDepositAge",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowlistEnabled",
    inputs: [],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "maxWithdrawAmount",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "commitment", type: "uint256", indexed: true },
      { name: "leafIndex", type: "uint32", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "nullifier", type: "uint256", indexed: true },
      { name: "outCommitment1", type: "uint256", indexed: false },
      { name: "outCommitment2", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawal",
    inputs: [
      { name: "nullifier", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "recipient", type: "address", indexed: false },
      { name: "changeCommitment", type: "uint256", indexed: false },
      { name: "relayer", type: "address", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
] as const;

// StealthRegistry ABI — minimal subset
export const REGISTRY_ABI = [
  {
    type: "function",
    name: "registerViewingKey",
    inputs: [
      { name: "viewingKeyX", type: "uint256" },
      { name: "viewingKeyY", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "announceStealthPayment",
    inputs: [
      { name: "ephemeralX", type: "uint256" },
      { name: "ephemeralY", type: "uint256" },
      { name: "stealthX", type: "uint256" },
      { name: "stealthY", type: "uint256" },
      { name: "viewTag", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "StealthPayment",
    inputs: [
      { name: "ephemeralX", type: "uint256", indexed: false },
      { name: "ephemeralY", type: "uint256", indexed: false },
      { name: "stealthX", type: "uint256", indexed: false },
      { name: "stealthY", type: "uint256", indexed: false },
      { name: "viewTag", type: "uint256", indexed: false },
    ],
  },
] as const;

// Placeholder — update after deployment
// NIGHT-SHIFT-REVIEW: replace with actual deployed address after running deploy script
const POOL_ADDRESS_RAW =
  "0x0000000000000000000000000000000000000000" as `0x${string}`;

// NIGHT-SHIFT-REVIEW: replace with actual deployed address after running deploy script
const REGISTRY_ADDRESS_RAW =
  "0x0000000000000000000000000000000000000000" as `0x${string}`;

export function getPoolAddress(): `0x${string}` {
  if (POOL_ADDRESS_RAW === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      "POOL_ADDRESS is not configured. Deploy ConfidentialPool and update POOL_ADDRESS_RAW in frontend/src/lib/constants.ts",
    );
  }
  return POOL_ADDRESS_RAW;
}

export function getRegistryAddress(): `0x${string}` {
  if (REGISTRY_ADDRESS_RAW === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      "REGISTRY_ADDRESS is not configured. Deploy StealthRegistry and update REGISTRY_ADDRESS_RAW in frontend/src/lib/constants.ts",
    );
  }
  return REGISTRY_ADDRESS_RAW;
}

export const MERKLE_TREE_DEPTH = 20;

export const ZERO_VALUE = 0n;

// Update after deployment to reduce event scanning range
export const DEPLOY_BLOCK = 0n;

// BN254 scalar field size
export const FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);
