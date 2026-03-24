import * as snarkjs from "snarkjs";

export type ProofForContract = {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
};

export type TransferProofInput = {
  root: bigint;
  nullifier: bigint;
  outCommitment1: bigint;
  outCommitment2: bigint;
  amount: bigint;
  blinding: bigint;
  spendingKey: bigint;
  outAmount1: bigint;
  outBlinding1: bigint;
  outRecipientPubX: bigint;
  outRecipientPubY: bigint;
  outAmount2: bigint;
  outBlinding2: bigint;
  outChangePubX: bigint;
  outChangePubY: bigint;
  pathElements: bigint[];
  pathIndices: number[];
};

export type WithdrawProofInput = {
  root: bigint;
  nullifier: bigint;
  amount: bigint;
  recipient: bigint;
  changeCommitment: bigint;
  blinding: bigint;
  spendingKey: bigint;
  changeAmount: bigint;
  changeBlinding: bigint;
  changePubX: bigint;
  changePubY: bigint;
  pathElements: bigint[];
  pathIndices: number[];
};

type SnarkProof = {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
};

function formatProofForContract(proof: SnarkProof): ProofForContract {
  // pB is transposed for EVM — groth16 spec
  return {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  };
}

// NIGHT-SHIFT-REVIEW: WASM and zkey files must be placed in frontend/public/circuits/ after circuit compilation
export async function generateTransferProof(
  input: TransferProofInput,
): Promise<ProofForContract> {
  const wasmPath = "/circuits/transfer.wasm";
  const zkeyPath = "/circuits/transfer_final.zkey";

  const circuitInput = {
    root: input.root.toString(),
    nullifier: input.nullifier.toString(),
    outCommitment1: input.outCommitment1.toString(),
    outCommitment2: input.outCommitment2.toString(),
    amount: input.amount.toString(),
    blinding: input.blinding.toString(),
    spendingKey: input.spendingKey.toString(),
    outAmount1: input.outAmount1.toString(),
    outBlinding1: input.outBlinding1.toString(),
    outRecipientPubX: input.outRecipientPubX.toString(),
    outRecipientPubY: input.outRecipientPubY.toString(),
    outAmount2: input.outAmount2.toString(),
    outBlinding2: input.outBlinding2.toString(),
    outChangePubX: input.outChangePubX.toString(),
    outChangePubY: input.outChangePubY.toString(),
    pathElements: input.pathElements.map((e) => e.toString()),
    pathIndices: input.pathIndices,
  };

  const result = await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
  return formatProofForContract(result.proof);
}

// NIGHT-SHIFT-REVIEW: WASM and zkey files must be placed in frontend/public/circuits/ after circuit compilation
export async function generateWithdrawProof(
  input: WithdrawProofInput,
): Promise<ProofForContract> {
  const wasmPath = "/circuits/withdraw.wasm";
  const zkeyPath = "/circuits/withdraw_final.zkey";

  const circuitInput = {
    root: input.root.toString(),
    nullifier: input.nullifier.toString(),
    amount: input.amount.toString(),
    recipient: input.recipient.toString(),
    changeCommitment: input.changeCommitment.toString(),
    blinding: input.blinding.toString(),
    spendingKey: input.spendingKey.toString(),
    changeAmount: input.changeAmount.toString(),
    changeBlinding: input.changeBlinding.toString(),
    changePubX: input.changePubX.toString(),
    changePubY: input.changePubY.toString(),
    pathElements: input.pathElements.map((e) => e.toString()),
    pathIndices: input.pathIndices,
  };

  const result = await snarkjs.groth16.fullProve(circuitInput, wasmPath, zkeyPath);
  return formatProofForContract(result.proof);
}
