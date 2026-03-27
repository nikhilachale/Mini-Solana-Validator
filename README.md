# Mini-Solana-Validator

A lightweight TypeScript implementation of a Solana validator node that provides JSON-RPC endpoints for interacting with Solana's blockchain. This validator simulates core Solana functionality including account management, transaction processing, and program execution.

## Overview

Mini-Solana-Validator is an educational and development-focused implementation that demonstrates:
- JSON-RPC 2.0 compliant API endpoints
- Solana program interactions (System Program, Token Program, Associated Token Account Program)
- Transaction deserialization and signature verification
- Blockhash validation and management
- Account state management and ledger operations
- Rent-exempt calculations

## Features

- **JSON-RPC Server**: Express-based HTTP server implementing Solana's JSON-RPC API
- **Account Management**: Create, read, and manage Solana accounts with lamport balances
- **Transaction Processing**: Deserialize and verify transaction signatures
- **Program Support**:
  - System Program (11111111111111111111111111111111)
  - Token Program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
  - Associated Token Account Program (ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL)
- **Blockhash Management**: Issue and validate blockhashes for transaction security
- **Slot and Block Height Tracking**: Maintain blockchain consensus state

## Installation

### Prerequisites
- Node.js 18+
- npm or yarn

### Setup

```bash
npm install
```

## Usage

Start the validator server:

```bash
npm start
```

The server will start and listen for JSON-RPC requests. You can send requests to the appropriate endpoints using tools like `curl`, Postman, or any Solana web3 library configured to use your local validator.

### Example Request

```bash
curl -X POST http://localhost:8899 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getSlot",
    "params": []
  }'
```

## Project Structure

```
├── index.ts              # Main Express server and request handler
├── rpc.ts               # JSON-RPC method dispatcher and implementations
├── transaction.ts       # Transaction deserialization and signature verification
├── ledger.ts            # Account and blockchain state management
├── blockhash.ts         # Blockhash generation and validation
├── systemProgram.ts     # System Program instruction execution
├── tokenProgram.ts      # Token Program and SPL Token handling
├── ataProgram.ts        # Associated Token Account Program support
├── src/                 # Additional source modules
└── package.json         # Project dependencies

```

## Dependencies

### Runtime
- **@solana/web3.js** - Solana JavaScript SDK
- **express** - Web server framework
- **bs58** - Base58 encoding/decoding
- **tweetnacl** - Cryptographic signing

### Development
- **TypeScript** - Type-safe JavaScript
- **tsx** - TypeScript execution
- **@types/node**, **@types/express** - Type definitions

## Supported RPC Methods

The validator implements core Solana RPC methods including:
- Account queries (`getAccount`, `getBalance`, etc.)
- Slot and block information (`getSlot`, `getBlockHeight`, etc.)
- Blockhash operations (`getLatestBlockhash`, `isBlockhashValid`, etc.)
- Transaction submission and status tracking

## Architecture

The validator follows a modular architecture:

1. **index.ts**: HTTP request handler and JSON-RPC envelope processing
2. **rpc.ts**: Maps JSON-RPC method names to implementation functions
3. **ledger.ts**: In-memory state management for accounts and blockchain
4. **transaction.ts**: Binary serialization/deserialization of Solana transactions
5. **Programs**: Separate modules for System, Token, and ATA program instruction handling

## Development

To develop locally:

```bash
npm run start  # Start the development server
```

This uses `tsx` for live TypeScript compilation.

## Notes

- This is a simplified validator implementation for educational purposes
- State is kept in-memory and will be lost on restart
- Not intended for production use
- Designed to work with development/testing workflows

## License

MIT
