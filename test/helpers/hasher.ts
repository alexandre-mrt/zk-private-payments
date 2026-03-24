import { ethers } from "hardhat";
import { poseidonContract } from "circomlibjs";

const POSEIDON_INPUTS = 2;

export async function deployHasher(): Promise<string> {
  const [signer] = await ethers.getSigners();
  const bytecode = poseidonContract.createCode(POSEIDON_INPUTS);
  const abi = poseidonContract.generateABI(POSEIDON_INPUTS);
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return contract.getAddress();
}
