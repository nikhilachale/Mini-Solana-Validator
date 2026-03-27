const bs58 = require('bs58');
const {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  U64_MAX,
  getAccount,
  setAccount,
  deleteAccount,
  creditLamports,
} = require('./ledger.ts');

/**
 * FUNCTION: isAllZeroBuffer
 * PURPOSE: Check whether a buffer contains only zero bytes.
 * PARAMS: buffer (Buffer) input bytes.
 * RETURNS: boolean.
 * THROWS: never.
 * EDGE CASES: 1) empty buffer returns true.
 */
function isAllZeroBuffer(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * FUNCTION: safeAddU64
 * PURPOSE: Add two BigInt values with u64 overflow protection.
 * PARAMS: a (BigInt), b (BigInt), label (string) context label.
 * RETURNS: BigInt summed value.
 * THROWS: Error when result exceeds u64 max.
 * EDGE CASES: 1) zero add accepted.
 */
function safeAddU64(a, b, label) {
  const sum = a + b;
  if (sum > U64_MAX) {
    throw new Error(`${label} overflow`);
  }
  return sum;
}

/**
 * FUNCTION: parseMintData
 * PURPOSE: Parse SPL mint account bytes into logical fields.
 * PARAMS: buffer (Buffer) raw mint account data.
 * RETURNS: object with mint fields.
 * THROWS: Error when buffer is smaller than mint layout.
 * EDGE CASES: 1) uninitialized mint is returned with isInitialized=false.
 */
function parseMintData(buffer) {
  if (buffer.length < 82) {
    throw new Error('invalid mint account data');
  }

  const mintAuthorityOption = buffer.readUInt32LE(0);
  const mintAuthority = bs58.encode(buffer.slice(4, 36));
  const supply = buffer.readBigUInt64LE(36);
  const decimals = buffer.readUInt8(44);
  const isInitialized = buffer.readUInt8(45) === 1;
  const freezeAuthorityOption = buffer.readUInt32LE(46);
  const freezeAuthority = bs58.encode(buffer.slice(50, 82));

  return {
    mintAuthorityOption,
    mintAuthority,
    supply,
    decimals,
    isInitialized,
    freezeAuthorityOption,
    freezeAuthority,
  };
}

/**
 * FUNCTION: parseTokenAccountData
 * PURPOSE: Parse SPL token account bytes into logical fields.
 * PARAMS: buffer (Buffer) raw token account data.
 * RETURNS: object with token account fields.
 * THROWS: Error when layout is invalid or account is not initialized.
 * EDGE CASES: 1) frozen/uninitialized states rejected for callers expecting initialized accounts.
 */
function parseTokenAccountData(buffer) {
  if (buffer.length < 165) {
    throw new Error('invalid token account data');
  }

  const mint = bs58.encode(buffer.slice(0, 32));
  const owner = bs58.encode(buffer.slice(32, 64));
  const amount = buffer.readBigUInt64LE(64);
  const delegateOption = buffer.readUInt32LE(72);
  const delegate = bs58.encode(buffer.slice(76, 108));
  const state = buffer.readUInt8(108);
  const delegatedAmount = buffer.readBigUInt64LE(121);
  const closeAuthorityOption = buffer.readUInt32LE(129);
  const closeAuthority = bs58.encode(buffer.slice(133, 165));

  if (state !== 1) {
    throw new Error('account is not initialized');
  }

  return {
    mint,
    owner,
    amount,
    state,
    delegateOption,
    delegate,
    delegatedAmount,
    closeAuthorityOption,
    closeAuthority,
  };
}

/**
 * FUNCTION: writeMintData
 * PURPOSE: Serialize mint logical fields into a canonical 82-byte layout.
 * PARAMS: fields (object) mint fields.
 * RETURNS: Buffer of length 82.
 * THROWS: Error when provided pubkeys are invalid base58.
 * EDGE CASES: 1) optional authorities are represented by option flags.
 */
function writeMintData(fields) {
  const out = Buffer.alloc(82);
  out.writeUInt32LE(fields.mintAuthorityOption ? 1 : 0, 0);
  const mintAuthorityBytes = fields.mintAuthorityOption
    ? Buffer.from(bs58.decode(fields.mintAuthority))
    : Buffer.alloc(32);
  mintAuthorityBytes.copy(out, 4);
  out.writeBigUInt64LE(BigInt(fields.supply || 0n), 36);
  out.writeUInt8(fields.decimals || 0, 44);
  out.writeUInt8(fields.isInitialized ? 1 : 0, 45);
  out.writeUInt32LE(fields.freezeAuthorityOption ? 1 : 0, 46);
  const freezeAuthorityBytes = fields.freezeAuthorityOption
    ? Buffer.from(bs58.decode(fields.freezeAuthority))
    : Buffer.alloc(32);
  freezeAuthorityBytes.copy(out, 50);
  return out;
}

/**
 * FUNCTION: writeTokenAccountData
 * PURPOSE: Serialize token account logical fields into a canonical 165-byte layout.
 * PARAMS: fields (object) token account fields.
 * RETURNS: Buffer of length 165.
 * THROWS: Error when base58 keys are invalid.
 * EDGE CASES: 1) optional delegate/close authority encoded as none by default.
 */
function writeTokenAccountData(fields) {
  const out = Buffer.alloc(165);
  Buffer.from(bs58.decode(fields.mint)).copy(out, 0);
  Buffer.from(bs58.decode(fields.owner)).copy(out, 32);
  out.writeBigUInt64LE(BigInt(fields.amount || 0n), 64);
  out.writeUInt32LE(fields.delegateOption ? 1 : 0, 72);
  if (fields.delegateOption) {
    Buffer.from(bs58.decode(fields.delegate)).copy(out, 76);
  }
  out.writeUInt8(fields.state ?? 1, 108);
  out.writeUInt32LE(0, 109); // isNativeOption
  out.writeBigUInt64LE(0n, 113); // isNative
  out.writeBigUInt64LE(BigInt(fields.delegatedAmount || 0n), 121);
  out.writeUInt32LE(fields.closeAuthorityOption ? 1 : 0, 129);
  if (fields.closeAuthorityOption) {
    Buffer.from(bs58.decode(fields.closeAuthority)).copy(out, 133);
  }
  return out;
}

/**
 * FUNCTION: isMint
 * PURPOSE: Determine whether a ledger account has mint layout semantics.
 * PARAMS: account (object|null) ledger account.
 * RETURNS: boolean.
 * THROWS: never.
 * EDGE CASES: 1) null account returns false.
 */
function isMint(account) {
  return Boolean(account && account.owner === TOKEN_PROGRAM_ID && account.data.length === 82);
}

/**
 * FUNCTION: isTokenAccount
 * PURPOSE: Determine whether a ledger account has token-account layout semantics.
 * PARAMS: account (object|null) ledger account.
 * RETURNS: boolean.
 * THROWS: never.
 * EDGE CASES: 1) null account returns false.
 */
function isTokenAccount(account) {
  return Boolean(account && account.owner === TOKEN_PROGRAM_ID && account.data.length === 165);
}

/**
 * FUNCTION: assertAccountIndex
 * PURPOSE: Resolve and validate an instruction account index against tx keys.
 * PARAMS: ixIndex (number), accountKeys (string[]), label (string).
 * RETURNS: base58 pubkey string.
 * THROWS: Error when index is out of bounds.
 * EDGE CASES: 1) undefined index rejected.
 */
function assertAccountIndex(ixIndex, accountKeys, label) {
  if (!Number.isInteger(ixIndex) || ixIndex < 0 || ixIndex >= accountKeys.length) {
    throw new Error(`${label} account index out of bounds`);
  }
  return accountKeys[ixIndex];
}

/**
 * FUNCTION: executeInitializeMint2
 * PURPOSE: Initialize a mint account with authority metadata.
 * PARAMS: instruction (object), accountKeys (string[]).
 * RETURNS: void.
 * THROWS: Error for invalid data, wrong account size, or already initialized mint.
 * EDGE CASES: 1) creates missing mint account with 82-byte data.
 */
function executeInitializeMint2(instruction, accountKeys) {
  if (instruction.data.length < 67) {
    throw new Error('invalid InitializeMint2 data');
  }

  const mintPubkey = assertAccountIndex(instruction.accounts[0], accountKeys, 'mint');
  let mintAccount = getAccount(mintPubkey);

  if (!mintAccount) {
    mintAccount = {
      pubkey: mintPubkey,
      lamports: 0n,
      owner: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(82),
      executable: false,
      rentEpoch: 0,
    };
    setAccount(mintPubkey, mintAccount);
  }

  if (mintAccount.data.length !== 82) {
    throw new Error('account data wrong size for mint');
  }

  const existingRaw = parseMintData(Buffer.from(mintAccount.data));
  if (existingRaw.isInitialized) {
    throw new Error('mint already initialized');
  }

  const decimals = instruction.data.readUInt8(1);
  const mintAuthorityBytes = Buffer.from(instruction.data.slice(2, 34));
  const hasFreezeAuth = instruction.data.readUInt8(34);
  const freezeAuthorityBytes = Buffer.from(instruction.data.slice(35, 67));

  const mintFields = {
    mintAuthorityOption: 1,
    mintAuthority: bs58.encode(mintAuthorityBytes),
    supply: 0n,
    decimals,
    isInitialized: true,
    freezeAuthorityOption: hasFreezeAuth === 1 ? 1 : 0,
    freezeAuthority: hasFreezeAuth === 1 ? bs58.encode(freezeAuthorityBytes) : bs58.encode(Buffer.alloc(32)),
  };

  setAccount(mintPubkey, {
    ...mintAccount,
    owner: TOKEN_PROGRAM_ID,
    data: writeMintData(mintFields),
  });
}

/**
 * FUNCTION: executeInitializeAccount3
 * PURPOSE: Initialize a token account against an existing initialized mint.
 * PARAMS: instruction (object), accountKeys (string[]).
 * RETURNS: void.
 * THROWS: Error for invalid mint/token account preconditions.
 * EDGE CASES: 1) creates missing token account with 165-byte data owned by token program.
 */
function executeInitializeAccount3(instruction, accountKeys) {
  if (instruction.data.length < 33) {
    throw new Error('invalid InitializeAccount3 data');
  }

  const tokenPubkey = assertAccountIndex(instruction.accounts[0], accountKeys, 'token account');
  const mintPubkey = assertAccountIndex(instruction.accounts[1], accountKeys, 'mint');
  const ownerPubkey = bs58.encode(instruction.data.slice(1, 33));

  const mintAccount = getAccount(mintPubkey);
  if (!mintAccount) {
    throw new Error('mint account not found');
  }
  if (!isMint(mintAccount)) {
    throw new Error('invalid mint');
  }
  const mintData = parseMintData(Buffer.from(mintAccount.data));
  if (!mintData.isInitialized) {
    throw new Error('invalid mint');
  }

  let tokenAccount = getAccount(tokenPubkey);
  if (!tokenAccount) {
    tokenAccount = {
      pubkey: tokenPubkey,
      lamports: 0n,
      owner: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(165),
      executable: false,
      rentEpoch: 0,
    };
    setAccount(tokenPubkey, tokenAccount);
  }

  if (tokenAccount.data.length !== 165) {
    throw new Error('account wrong size for token account');
  }

  const state = tokenAccount.data.readUInt8(108);
  if (state === 1) {
    throw new Error('account already initialized');
  }

  setAccount(tokenPubkey, {
    ...tokenAccount,
    owner: TOKEN_PROGRAM_ID,
    data: writeTokenAccountData({
      mint: mintPubkey,
      owner: ownerPubkey,
      amount: 0n,
      state: 1,
      delegateOption: 0,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
    }),
  });
}

/**
 * FUNCTION: executeMintTo
 * PURPOSE: Mint new tokens from a mint into a destination token account.
 * PARAMS: instruction (object), accountKeys (string[]), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for authority, initialization, mismatch, or overflow violations.
 * EDGE CASES: 1) amount 0 is a no-op after precondition checks.
 */
function executeMintTo(instruction, accountKeys, signers) {
  if (instruction.data.length < 9) {
    throw new Error('invalid MintTo data');
  }

  const mintPubkey = assertAccountIndex(instruction.accounts[0], accountKeys, 'mint');
  const destinationPubkey = assertAccountIndex(instruction.accounts[1], accountKeys, 'destination');
  const authorityPubkey = assertAccountIndex(instruction.accounts[2], accountKeys, 'authority');
  const amount = instruction.data.readBigUInt64LE(1);

  const mintAccount = getAccount(mintPubkey);
  if (!mintAccount) {
    throw new Error('mint not found');
  }
  if (!isMint(mintAccount)) {
    throw new Error('mint not initialized');
  }
  const mintData = parseMintData(Buffer.from(mintAccount.data));
  if (!mintData.isInitialized) {
    throw new Error('mint not initialized');
  }

  const destinationAccount = getAccount(destinationPubkey);
  if (!destinationAccount) {
    throw new Error('destination account not found');
  }
  if (!isTokenAccount(destinationAccount)) {
    throw new Error('invalid token account');
  }
  const destinationData = parseTokenAccountData(Buffer.from(destinationAccount.data));
  if (destinationData.mint !== mintPubkey) {
    throw new Error('token account mint mismatch');
  }

  if (mintData.mintAuthorityOption === 0) {
    throw new Error('mint authority disabled');
  }
  if (authorityPubkey !== mintData.mintAuthority) {
    throw new Error('invalid mint authority');
  }
  if (!signers.has(authorityPubkey)) {
    throw new Error('missing required signature');
  }

  if (amount === 0n) {
    return;
  }

  const nextSupply = safeAddU64(mintData.supply, amount, 'supply');
  const nextAmount = safeAddU64(destinationData.amount, amount, 'amount');

  setAccount(mintPubkey, {
    ...mintAccount,
    data: writeMintData({
      ...mintData,
      supply: nextSupply,
      isInitialized: true,
    }),
  });
  setAccount(destinationPubkey, {
    ...destinationAccount,
    data: writeTokenAccountData({
      ...destinationData,
      amount: nextAmount,
      state: 1,
    }),
  });
}

/**
 * FUNCTION: executeTransferLike
 * PURPOSE: Shared transfer logic for SPL Transfer and TransferChecked operations.
 * PARAMS: sourcePubkey, destinationPubkey, ownerPubkey, amount, signers, expectedMint (nullable), expectedDecimals (nullable).
 * RETURNS: void.
 * THROWS: Error for account mismatch, ownership, frozen state, or balance/overflow failures.
 * EDGE CASES: 1) self-transfer allowed; 2) zero amount is no-op after validation.
 */
function executeTransferLike(
  sourcePubkey,
  destinationPubkey,
  ownerPubkey,
  amount,
  signers,
  expectedMint,
  expectedDecimals,
) {
  const sourceAccount = getAccount(sourcePubkey);
  if (!sourceAccount) {
    throw new Error('source account not found');
  }
  if (!isTokenAccount(sourceAccount)) {
    throw new Error('invalid token account');
  }
  const sourceData = parseTokenAccountData(Buffer.from(sourceAccount.data));

  const destinationAccount = getAccount(destinationPubkey);
  if (!destinationAccount) {
    throw new Error('destination account not found');
  }
  if (!isTokenAccount(destinationAccount)) {
    throw new Error('destination account is frozen');
  }
  const destinationData = parseTokenAccountData(Buffer.from(destinationAccount.data));

  if (sourceData.state !== 1) {
    throw new Error('account is frozen');
  }
  if (destinationData.state !== 1) {
    throw new Error('destination account is frozen');
  }
  if (sourceData.mint !== destinationData.mint) {
    throw new Error('mint mismatch between source and destination');
  }

  if (expectedMint && (sourceData.mint !== expectedMint || destinationData.mint !== expectedMint)) {
    throw new Error('mint mismatch between source and destination');
  }

  if (ownerPubkey !== sourceData.owner) {
    throw new Error('incorrect token account owner');
  }
  if (!signers.has(ownerPubkey)) {
    throw new Error('missing required signature');
  }

  if (expectedMint && expectedDecimals !== null && expectedDecimals !== undefined) {
    const mintAccount = getAccount(expectedMint);
    if (!mintAccount || !isMint(mintAccount)) {
      throw new Error('invalid mint');
    }
    const mintData = parseMintData(Buffer.from(mintAccount.data));
    if (!mintData.isInitialized) {
      throw new Error('invalid mint');
    }
    if (mintData.decimals !== expectedDecimals) {
      throw new Error('decimals mismatch');
    }
  }

  if (amount === 0n || sourcePubkey === destinationPubkey) {
    return;
  }

  if (sourceData.amount < amount) {
    throw new Error('insufficient token balance');
  }
  const nextDestinationAmount = safeAddU64(destinationData.amount, amount, 'amount');
  const nextSourceAmount = sourceData.amount - amount;

  setAccount(sourcePubkey, {
    ...sourceAccount,
    data: writeTokenAccountData({
      ...sourceData,
      amount: nextSourceAmount,
      state: 1,
    }),
  });
  setAccount(destinationPubkey, {
    ...destinationAccount,
    data: writeTokenAccountData({
      ...destinationData,
      amount: nextDestinationAmount,
      state: 1,
    }),
  });
}

/**
 * FUNCTION: executeTransfer
 * PURPOSE: Handle SPL Token Transfer instruction.
 * PARAMS: instruction (object), accountKeys (string[]), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for invalid data and transfer precondition failures.
 * EDGE CASES: 1) amount 0 allowed.
 */
function executeTransfer(instruction, accountKeys, signers) {
  if (instruction.data.length < 9) {
    throw new Error('invalid Transfer data');
  }
  const source = assertAccountIndex(instruction.accounts[0], accountKeys, 'source');
  const destination = assertAccountIndex(instruction.accounts[1], accountKeys, 'destination');
  const owner = assertAccountIndex(instruction.accounts[2], accountKeys, 'owner');
  const amount = instruction.data.readBigUInt64LE(1);
  executeTransferLike(source, destination, owner, amount, signers, null, null);
}

/**
 * FUNCTION: executeTransferChecked
 * PURPOSE: Handle SPL Token TransferChecked instruction with decimals and mint assertions.
 * PARAMS: instruction (object), accountKeys (string[]), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for invalid data, mint mismatch, decimals mismatch, or transfer failures.
 * EDGE CASES: 1) amount 0 allowed.
 */
function executeTransferChecked(instruction, accountKeys, signers) {
  if (instruction.data.length < 10) {
    throw new Error('invalid TransferChecked data');
  }
  const source = assertAccountIndex(instruction.accounts[0], accountKeys, 'source');
  const mint = assertAccountIndex(instruction.accounts[1], accountKeys, 'mint');
  const destination = assertAccountIndex(instruction.accounts[2], accountKeys, 'destination');
  const owner = assertAccountIndex(instruction.accounts[3], accountKeys, 'owner');
  const amount = instruction.data.readBigUInt64LE(1);
  const decimals = instruction.data.readUInt8(9);
  executeTransferLike(source, destination, owner, amount, signers, mint, decimals);
}

/**
 * FUNCTION: executeBurn
 * PURPOSE: Burn tokens from a token account and decrement mint supply.
 * PARAMS: instruction (object), accountKeys (string[]), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for account ownership/state mismatches or insufficient balances.
 * EDGE CASES: 1) zero burn allowed.
 */
function executeBurn(instruction, accountKeys, signers) {
  if (instruction.data.length < 9) {
    throw new Error('invalid Burn data');
  }
  const tokenPubkey = assertAccountIndex(instruction.accounts[0], accountKeys, 'token account');
  const mintPubkey = assertAccountIndex(instruction.accounts[1], accountKeys, 'mint');
  const ownerPubkey = assertAccountIndex(instruction.accounts[2], accountKeys, 'owner');
  const amount = instruction.data.readBigUInt64LE(1);

  const tokenAccount = getAccount(tokenPubkey);
  if (!tokenAccount) {
    throw new Error('token account not found');
  }
  if (!isTokenAccount(tokenAccount)) {
    throw new Error('invalid token account');
  }
  const tokenData = parseTokenAccountData(Buffer.from(tokenAccount.data));

  const mintAccount = getAccount(mintPubkey);
  if (!mintAccount) {
    throw new Error('mint not found');
  }
  if (!isMint(mintAccount)) {
    throw new Error('mint not initialized');
  }
  const mintData = parseMintData(Buffer.from(mintAccount.data));
  if (!mintData.isInitialized) {
    throw new Error('mint not initialized');
  }

  if (tokenData.mint !== mintPubkey) {
    throw new Error('token account mint mismatch');
  }
  if (ownerPubkey !== tokenData.owner) {
    throw new Error('incorrect owner');
  }
  if (!signers.has(ownerPubkey)) {
    throw new Error('missing signature');
  }

  if (amount === 0n) {
    return;
  }
  if (tokenData.amount < amount) {
    throw new Error('insufficient token balance');
  }
  if (mintData.supply < amount) {
    throw new Error('burn exceeds mint supply');
  }

  setAccount(tokenPubkey, {
    ...tokenAccount,
    data: writeTokenAccountData({
      ...tokenData,
      amount: tokenData.amount - amount,
      state: 1,
    }),
  });
  setAccount(mintPubkey, {
    ...mintAccount,
    data: writeMintData({
      ...mintData,
      supply: mintData.supply - amount,
      isInitialized: true,
    }),
  });
}

/**
 * FUNCTION: executeCloseAccount
 * PURPOSE: Close an SPL token account and drain lamports to destination.
 * PARAMS: instruction (object), accountKeys (string[]), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for non-zero token balance, bad owner, or invalid destination.
 * EDGE CASES: 1) destination missing account is auto-created.
 */
function executeCloseAccount(instruction, accountKeys, signers) {
  const accountToClosePubkey = assertAccountIndex(instruction.accounts[0], accountKeys, 'account');
  const destinationPubkey = assertAccountIndex(instruction.accounts[1], accountKeys, 'destination');
  const ownerPubkey = assertAccountIndex(instruction.accounts[2], accountKeys, 'owner');

  if (accountToClosePubkey === destinationPubkey) {
    throw new Error('cannot close to self');
  }

  const accountToClose = getAccount(accountToClosePubkey);
  if (!accountToClose) {
    throw new Error('account not found');
  }
  if (!isTokenAccount(accountToClose)) {
    throw new Error('not a token account');
  }
  const tokenData = parseTokenAccountData(Buffer.from(accountToClose.data));
  if (tokenData.amount !== 0n) {
    throw new Error('cannot close account with non-zero token balance');
  }
  if (ownerPubkey !== tokenData.owner) {
    throw new Error('incorrect owner');
  }
  if (!signers.has(ownerPubkey)) {
    throw new Error('missing required signature');
  }

  if (!getAccount(destinationPubkey)) {
    setAccount(destinationPubkey, {
      pubkey: destinationPubkey,
      lamports: 0n,
      owner: SYSTEM_PROGRAM_ID,
      data: Buffer.alloc(0),
      executable: false,
      rentEpoch: 0,
    });
  }

  creditLamports(destinationPubkey, accountToClose.lamports);
  deleteAccount(accountToClosePubkey);
}

/**
 * FUNCTION: executeTokenInstruction
 * PURPOSE: Dispatch and execute SPL Token instructions by u8 discriminator.
 * PARAMS: instruction (object), accountKeys (string[]), accounts (unused), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error for invalid/unsupported instruction discriminators.
 * EDGE CASES: 1) requires at least one data byte for discriminator.
 */
function executeTokenInstruction(instruction, accountKeys, accounts, signers) {
  if (!instruction.data || instruction.data.length < 1) {
    throw new Error('invalid token instruction data');
  }

  const discriminator = instruction.data.readUInt8(0);
  if (discriminator === 20) {
    executeInitializeMint2(instruction, accountKeys);
    return;
  }
  if (discriminator === 18) {
    executeInitializeAccount3(instruction, accountKeys);
    return;
  }
  if (discriminator === 7) {
    executeMintTo(instruction, accountKeys, signers);
    return;
  }
  if (discriminator === 3) {
    executeTransfer(instruction, accountKeys, signers);
    return;
  }
  if (discriminator === 12) {
    executeTransferChecked(instruction, accountKeys, signers);
    return;
  }
  if (discriminator === 8) {
    executeBurn(instruction, accountKeys, signers);
    return;
  }
  if (discriminator === 9) {
    executeCloseAccount(instruction, accountKeys, signers);
    return;
  }
  throw new Error('unknown token instruction');
}

module.exports = {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  parseMintData,
  parseTokenAccountData,
  writeMintData,
  writeTokenAccountData,
  isMint,
  isTokenAccount,
  executeTokenInstruction,
};
