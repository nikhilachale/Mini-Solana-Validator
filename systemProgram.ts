const {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  U64_MAX,
  getAccount,
  setAccount,
  creditLamports,
  debitLamports,
} = require('./ledger.ts');

/**
 * FUNCTION: assertAccountIndex
 * PURPOSE: Validate that an instruction account index points to a valid transaction key.
 * PARAMS: ixIndex (number), accountKeys (string[]), label (string).
 * RETURNS: base58 pubkey string for requested index.
 * THROWS: Error when index is missing or out-of-bounds.
 * EDGE CASES: 1) undefined index rejected; 2) negative index rejected.
 */
function assertAccountIndex(ixIndex, accountKeys, label) {
  if (!Number.isInteger(ixIndex) || ixIndex < 0 || ixIndex >= accountKeys.length) {
    throw new Error(`${label} account index out of bounds`);
  }
  return accountKeys[ixIndex];
}

/**
 * FUNCTION: executeCreateAccount
 * PURPOSE: Execute SystemProgram createAccount instruction semantics.
 * PARAMS: instruction (object), accountKeys (string[]), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for malformed data, missing signatures, or funding/space failures.
 * EDGE CASES: 1) zero lamport create allowed; 2) account reuse allowed only for empty zero-lamport account.
 */
function executeCreateAccount(instruction, accountKeys, signers) {
  if (instruction.data.length < 52) {
    throw new Error('invalid createAccount data');
  }

  const payer = assertAccountIndex(instruction.accounts[0], accountKeys, 'payer');
  const newAccount = assertAccountIndex(instruction.accounts[1], accountKeys, 'new account');

  if (payer === newAccount) {
    throw new Error('payer and new account cannot be the same');
  }

  if (!signers.has(payer)) {
    throw new Error('missing required signature');
  }
  if (!signers.has(newAccount)) {
    throw new Error('missing required signature for new account');
  }

  const lamports = instruction.data.readBigUInt64LE(4);
  const space = instruction.data.readBigUInt64LE(12);
  const owner = require('bs58').encode(instruction.data.slice(20, 52));

  if (lamports > U64_MAX) {
    throw new Error('lamports overflow');
  }

  if (space > 10000000n) {
    throw new Error('requested space exceeds maximum');
  }

  const existing = getAccount(newAccount);
  if (existing && (existing.lamports > 0n || existing.data.length > 0)) {
    throw new Error('account already in use');
  }

  const debitResult = debitLamports(payer, lamports);
  if (!debitResult.success) {
    throw new Error('insufficient funds for account creation');
  }

  setAccount(newAccount, {
    pubkey: newAccount,
    lamports,
    owner,
    data: Buffer.alloc(Number(space)),
    executable: false,
    rentEpoch: 0,
  });
}

/**
 * FUNCTION: executeTransfer
 * PURPOSE: Execute SystemProgram transfer instruction semantics.
 * PARAMS: instruction (object), accountKeys (string[]), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for malformed data, missing signature, or insufficient funds.
 * EDGE CASES: 1) zero transfer is no-op; 2) self-transfer allowed; 3) missing destination auto-created.
 */
function executeTransfer(instruction, accountKeys, signers) {
  if (instruction.data.length < 12) {
    throw new Error('invalid transfer data');
  }

  const source = assertAccountIndex(instruction.accounts[0], accountKeys, 'source');
  const destination = assertAccountIndex(instruction.accounts[1], accountKeys, 'destination');

  if (!signers.has(source)) {
    throw new Error('missing required signature');
  }

  const lamports = instruction.data.readBigUInt64LE(4);
  if (lamports > U64_MAX) {
    throw new Error('amount overflow');
  }
  if (lamports === 0n) {
    return;
  }

  const debitResult = debitLamports(source, lamports);
  if (!debitResult.success) {
    throw new Error('insufficient funds for transfer');
  }

  if (!getAccount(destination)) {
    setAccount(destination, {
      pubkey: destination,
      lamports: 0n,
      owner: SYSTEM_PROGRAM_ID,
      data: Buffer.alloc(0),
      executable: false,
      rentEpoch: 0,
    });
  }
  creditLamports(destination, lamports);
}

/**
 * FUNCTION: executeSystemInstruction
 * PURPOSE: Dispatch and execute a System Program instruction by discriminator.
 * PARAMS: instruction (object), accountKeys (string[]), accounts (unused), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for invalid data length or unknown discriminator.
 * EDGE CASES: 1) rejects instruction data shorter than 4 bytes.
 */
function executeSystemInstruction(instruction, accountKeys, accounts, signers) {
  if (!instruction.data || instruction.data.length < 4) {
    throw new Error('invalid instruction data');
  }

  const discriminator = instruction.data.readUInt32LE(0);
  if (discriminator === 0) {
    executeCreateAccount(instruction, accountKeys, signers);
    return;
  }
  if (discriminator === 2) {
    executeTransfer(instruction, accountKeys, signers);
    return;
  }
  throw new Error('unknown system instruction');
}

module.exports = {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  executeSystemInstruction,
};
