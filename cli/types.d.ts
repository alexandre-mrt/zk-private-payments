declare module "circomlibjs" {
  export interface BabyJub {
    F: {
      e(v: string | number | bigint): unknown;
      toObject(v: unknown): bigint;
      isZero(v: unknown): boolean;
      eq(a: unknown, b: unknown): boolean;
      one: unknown;
      zero: unknown;
    };
    Base8: [unknown, unknown];
    Generator: [unknown, unknown];
    order: bigint;
    subOrder: bigint;
    addPoint(a: [unknown, unknown], b: [unknown, unknown]): [unknown, unknown];
    mulPointEscalar(base: [unknown, unknown], scalar: bigint | Uint8Array | Buffer): [unknown, unknown];
    inSubgroup(P: [unknown, unknown]): boolean;
    inCurve(P: [unknown, unknown]): boolean;
    packPoint(P: [unknown, unknown]): Uint8Array;
    unpackPoint(buff: Uint8Array): [unknown, unknown] | null;
  }

  export type PoseidonFn = {
    (inputs: (bigint | string | number | unknown)[]): unknown;
    F: {
      e(v: string | number | bigint): unknown;
      toObject(v: unknown): bigint;
    };
  };

  export function buildBabyjub(): Promise<BabyJub>;
  export function buildPoseidon(): Promise<PoseidonFn>;
  export const poseidonContract: {
    generateABI(n: number): unknown[];
    createCode(n: number): string;
  };
}

declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  export interface FullProveResult {
    proof: Groth16Proof;
    publicSignals: string[];
  }

  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: string,
      zkeyFile: string
    ): Promise<FullProveResult>;
    verify(
      vk: unknown,
      publicSignals: string[],
      proof: Groth16Proof
    ): Promise<boolean>;
    exportSolidityCallData(
      proof: Groth16Proof,
      pub: string[]
    ): Promise<string>;
  };
}
