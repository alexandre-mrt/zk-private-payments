#!/bin/bash
set -e

echo "========================================="
echo "ZK Private Payments — Local Development Setup"
echo "========================================="

command -v npx >/dev/null 2>&1 || { echo "npx not found. Install Node.js first."; exit 1; }

if ! curl -s http://127.0.0.1:8545 > /dev/null 2>&1; then
    echo "Starting Hardhat node..."
    npx hardhat node &
    NODE_PID=$!
    sleep 3
    echo "Hardhat node started (PID: $NODE_PID)"
else
    echo "Hardhat node already running"
fi

echo ""
echo "Deploying contracts..."
npx hardhat run scripts/deploy.ts --network localhost

echo ""
echo "========================================="
echo "Setup complete!"
echo "========================================="
echo ""
echo "Deployment addresses saved to deployment.json"
echo ""
echo "Quick commands:"
echo "  npx hardhat test                              # Run tests"
echo "  bun run cli/index.ts keygen                   # Generate keypair"
echo "  bun run cli/index.ts deposit --amount 1       # Deposit 1 ETH"
echo "  bun run cli/index.ts balance                  # Check balance"
echo "  cd frontend && bun dev                        # Start frontend"
echo ""
if [ -n "$NODE_PID" ]; then
    echo "Hardhat node running (PID: $NODE_PID). Kill with: kill $NODE_PID"
fi
