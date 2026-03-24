import * as snarkjs from "snarkjs";

export type ProofForContract = {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
};

// Matches confidential_transfer.circom signal names exactly
export type TransferProofInput = {
  // Public
  root: bigint;
  nullifier: bigint;
  outputCommitment1: bigint;
  outputCommitment2: bigint;
  // Private — input note
  amountIn: bigint;
  blindingIn: bigint;
  ownerPubKeyXIn: bigint;
  spendingKey: bigint;
  pathElements: bigint[];
  pathIndices: number[];
  // Private — output note 1
  amountOut1: bigint;
  blindingOut1: bigint;
  ownerPubKeyXOut1: bigint;
  // Private — output note 2 (change)
  amountOut2: bigint;
  blindingOut2: bigint;
  ownerPubKeyXOut2: bigint;
};

// Matches withdraw.circom signal names exactly
export type WithdrawProofInput = {
  // Public
  root: bigint;
  nullifier: bigint;
  amount: bigint;
  recipient: bigint;
  changeCommitment: bigint;
  // Private — input note
  amountIn: bigint;
  blindingIn: bigint;
  ownerPubKeyXIn: bigint;
  spendingKey: bigint;
  pathElements: bigint[];
  pathIndices: number[];
  // Private — change note
  changeAmount: bigint;
  changeBlinding: bigint;
  changeOwnerPubKeyX: bigint;
};

type SnarkProof = {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
};

function formatProofForContract(proof: SnarkProof): ProofForContract {
  return {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  };
}

function toStringInput(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "bigint") {
      result[key] = value.toString();
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) => (typeof v === "bigint" ? v.toString() : v));
    } else {
      result[key] = value;
    }
  }
  return result;
}

// Circuit artifacts: build/circuits/<name>/<name>_js/<name>.wasm
// For frontend: place in public/circuits/
export async function generateTransferProof(
  input: TransferProofInput,
): Promise<ProofForContract> {
  const wasmPath = "/circuits/confidential_transfer/confidential_transfer_js/confidential_transfer.wasm";
  const zkeyPath = "/circuits/confidential_transfer/confidential_transfer_final.zkey";

  const circuitInput = toStringInput({
    root: input.root,
    nullifier: input.nullifier,
    outputCommitment1: input.outputCommitment1,
    outputCommitment2: input.outputCommitment2,
    amountIn: input.amountIn,
    blindingIn: input.blindingIn,
    ownerPubKeyXIn: input.ownerPubKeyXIn,
    spendingKey: input.spendingKey,
    pathElements: input.pathElements,
    pathIndices: input.pathIndices,
    amountOut1: input.amountOut1,
    blindingOut1: input.blindingOut1,
    ownerPubKeyXOut1: input.ownerPubKeyXOut1,
    amountOut2: input.amountOut2,
    blindingOut2: input.blindingOut2,
    ownerPubKeyXOut2: input.ownerPubKeyXOut2,
  });

  const result = await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
  return formatProofForContract(result.proof);
}

export async function generateWithdrawProof(
  input: WithdrawProofInput,
): Promise<ProofForContract> {
  const wasmPath = "/circuits/withdraw/withdraw_js/withdraw.wasm";
  const zkeyPath = "/circuits/withdraw/withdraw_final.zkey";

  const circuitInput = toStringInput({
    root: input.root,
    nullifier: input.nullifier,
    amount: input.amount,
    recipient: input.recipient,
    changeCommitment: input.changeCommitment,
    amountIn: input.amountIn,
    blindingIn: input.blindingIn,
    ownerPubKeyXIn: input.ownerPubKeyXIn,
    spendingKey: input.spendingKey,
    pathElements: input.pathElements,
    pathIndices: input.pathIndices,
    changeAmount: input.changeAmount,
    changeBlinding: input.changeBlinding,
    changeOwnerPubKeyX: input.changeOwnerPubKeyX,
  });

  const result = await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
  return formatProofForContract(result.proof);
}
