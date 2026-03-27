const crypto = require('crypto');
const bs58 = require('bs58');
const {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  accounts,
  getAccount,
  setAccount,
  deleteAccount,
  creditLamports,
  getCurrentSlot,
  getBlockHeight,
  incrementSlot,
  recordTransaction,
  getTransactionStatus,
  getRentExemptMinimum,
} = require('./ledger.ts');
const { issueBlockhash, isValidBlockhash } = require('./blockhash.ts');
const { deserializeTransaction, verifySignatures } = require('./transaction.ts');
const { executeSystemInstruction } = require('./systemProgram.ts');
const {
  parseMintData,
  parseTokenAccountData,
  isTokenAccount,
  isMint,
  executeTokenInstruction,
} = require('./tokenProgram.ts');
const { executeAtaInstruction } = require('./ataProgram.ts');

/**
 * FUNCTION: RpcError
 * PURPOSE: Represent JSON-RPC errors with stable code/message pairs.
 * PARAMS: code (number), message (string), data (optional any).
 * RETURNS: RpcError instance.
 * THROWS: never.
 * EDGE CASES: 1) optional data field preserved.
 */
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * FUNCTION: isValidBase58Pubkey
 * PURPOSE: Validate a base58 public key string as 32-byte Solana key.
 * PARAMS: value (any) candidate key.
 * RETURNS: boolean.
 * THROWS: never.
 * EDGE CASES: 1) catches bs58 decode throws; 2) rejects invalid alphabet chars.
 */
function isValidBase58Pubkey(value) {
  if (typeof value !== 'string') {
    return false;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    return false;
  }
  try {
    return Buffer.from(bs58.decode(value)).length === 32;
  } catch (err) {
    return false;
  }
}

/**
 * FUNCTION: normalizeParams
 * PURPOSE: Normalize JSON-RPC params to an array form.
 * PARAMS: params (any) raw params field from request.
 * RETURNS: normalized params array.
 * THROWS: RpcError -32602 if params is not array/null/undefined.
 * EDGE CASES: 1) null becomes []; 2) absent becomes [].
 */
function normalizeParams(params) {
  if (params === null || params === undefined) {
    return [];
  }
  if (!Array.isArray(params)) {
    throw new RpcError(-32602, 'Invalid params');
  }
  return params;
}

/**
 * FUNCTION: cloneAccount
 * PURPOSE: Deep clone a ledger account object for snapshot/rollback.
 * PARAMS: account (object|null) source account.
 * RETURNS: cloned account or null.
 * THROWS: never.
 * EDGE CASES: 1) null returns null.
 */
function cloneAccount(account) {
  if (!account) {
    return null;
  }
  return {
    pubkey: account.pubkey,
    lamports: BigInt(account.lamports),
    owner: account.owner,
    data: Buffer.from(account.data || Buffer.alloc(0)),
    executable: Boolean(account.executable),
    rentEpoch: Number(account.rentEpoch || 0),
  };
}

/**
 * FUNCTION: snapshotAccounts
 * PURPOSE: Snapshot a set of accounts before transaction execution.
 * PARAMS: accountKeys (string[]) keys referenced by the transaction.
 * RETURNS: Map<string, account|null> snapshot.
 * THROWS: never.
 * EDGE CASES: 1) duplicate keys deduplicated.
 */
function snapshotAccounts(accountKeys) {
  const snapshot = new Map();
  for (const key of new Set(accountKeys)) {
    snapshot.set(key, cloneAccount(getAccount(key)));
  }
  return snapshot;
}

/**
 * FUNCTION: restoreAccounts
 * PURPOSE: Restore accounts from snapshot on transaction failure.
 * PARAMS: snapshot (Map<string, account|null>) prior state.
 * RETURNS: void.
 * THROWS: never.
 * EDGE CASES: 1) null snapshot entries delete accounts.
 */
function restoreAccounts(snapshot) {
  for (const [key, account] of snapshot.entries()) {
    if (!account) {
      deleteAccount(key);
    } else {
      setAccount(key, account);
    }
  }
}

/**
 * FUNCTION: buildSigners
 * PURPOSE: Build signer set from first N required signer keys.
 * PARAMS: accountKeys (string[]), header (object with numRequiredSignatures).
 * RETURNS: Set<string> of signer pubkeys.
 * THROWS: Error when header signer count exceeds available account keys.
 * EDGE CASES: 1) zero required signers returns empty set.
 */
function buildSigners(accountKeys, header) {
  const signers = new Set();
  const required = header.numRequiredSignatures || 0;
  if (required > accountKeys.length) {
    throw new Error('invalid signer configuration');
  }
  for (let i = 0; i < required; i += 1) {
    signers.add(accountKeys[i]);
  }
  return signers;
}

/**
 * FUNCTION: createAccountInfo
 * PURPOSE: Convert internal account shape into Solana-compatible RPC AccountInfo.
 * PARAMS: account (object) internal ledger account.
 * RETURNS: account info object for RPC response.
 * THROWS: never.
 * EDGE CASES: 1) preserves base64 data encoding.
 */
function createAccountInfo(account) {
  return {
    data: [Buffer.from(account.data).toString('base64'), 'base64'],
    executable: Boolean(account.executable),
    lamports: Number(account.lamports),
    owner: account.owner,
    rentEpoch: Number(account.rentEpoch || 0),
  };
}

/**
 * FUNCTION: getVersion
 * PURPOSE: Return static validator version metadata.
 * PARAMS: none.
 * RETURNS: object containing solana-core and feature-set.
 * THROWS: never.
 * EDGE CASES: 1) ignores incoming params.
 */
function getVersion() {
  return { 'solana-core': '1.18.0', 'feature-set': 3241752014 };
}

/**
 * FUNCTION: getSlot
 * PURPOSE: Return current slot from in-memory ledger.
 * PARAMS: none.
 * RETURNS: number slot.
 * THROWS: never.
 * EDGE CASES: 1) ignores commitment params.
 */
function getSlot() {
  return getCurrentSlot();
}

/**
 * FUNCTION: getBlockHeightRpc
 * PURPOSE: Return current block height from in-memory ledger.
 * PARAMS: none.
 * RETURNS: number block height.
 * THROWS: never.
 * EDGE CASES: none.
 */
function getBlockHeightRpc() {
  return getBlockHeight();
}

/**
 * FUNCTION: getHealth
 * PURPOSE: Return validator health status.
 * PARAMS: none.
 * RETURNS: string "ok".
 * THROWS: never.
 * EDGE CASES: always healthy in this in-memory implementation.
 */
function getHealth() {
  return 'ok';
}

/**
 * FUNCTION: getLatestBlockhashRpc
 * PURPOSE: Issue and return a new recent blockhash.
 * PARAMS: none.
 * RETURNS: object with context.slot and value blockhash metadata.
 * THROWS: never.
 * EDGE CASES: 1) every call returns a unique hash.
 */
function getLatestBlockhashRpc() {
  const currentSlot = getCurrentSlot();
  const currentHeight = getBlockHeight();
  const { blockhash, lastValidBlockHeight } = issueBlockhash(currentSlot, currentHeight);
  return {
    context: { slot: currentSlot },
    value: { blockhash, lastValidBlockHeight },
  };
}

/**
 * FUNCTION: getBalanceRpc
 * PURPOSE: Return SOL balance for an account.
 * PARAMS: params (array) expected [pubkey, optionalConfig].
 * RETURNS: object { context, value }.
 * THROWS: RpcError -32602 when pubkey is missing/invalid.
 * EDGE CASES: 1) missing account returns 0.
 */
function getBalanceRpc(params) {
  const pubkey = params[0];
  if (!isValidBase58Pubkey(pubkey)) {
    throw new RpcError(-32602, 'Invalid params: invalid pubkey');
  }
  const account = getAccount(pubkey);
  return {
    context: { slot: getCurrentSlot() },
    value: account ? Number(account.lamports) : 0,
  };
}

/**
 * FUNCTION: getAccountInfoRpc
 * PURPOSE: Return account metadata and data payload for a pubkey.
 * PARAMS: params (array) expected [pubkey, optionalConfig].
 * RETURNS: object with context and account value/null.
 * THROWS: RpcError -32602 for invalid pubkey.
 * EDGE CASES: 1) unsupported encoding still returns base64.
 */
function getAccountInfoRpc(params) {
  const pubkey = params[0];
  if (!isValidBase58Pubkey(pubkey)) {
    throw new RpcError(-32602, 'Invalid params: invalid pubkey');
  }
  const account = getAccount(pubkey);
  return {
    context: { slot: getCurrentSlot() },
    value: account ? createAccountInfo(account) : null,
  };
}

/**
 * FUNCTION: getMinimumBalanceForRentExemptionRpc
 * PURPOSE: Return rent-exempt minimum lamports for given data size.
 * PARAMS: params (array) expected [dataSize].
 * RETURNS: number lamports.
 * THROWS: RpcError -32602 for invalid size.
 * EDGE CASES: 1) rejects NaN/Infinity/negative values.
 */
function getMinimumBalanceForRentExemptionRpc(params) {
  const dataSize = params[0];
  if (
    typeof dataSize !== 'number'
    || Number.isNaN(dataSize)
    || !Number.isFinite(dataSize)
    || dataSize < 0
  ) {
    throw new RpcError(-32602, 'Invalid params: invalid data size');
  }
  return Number(getRentExemptMinimum(dataSize));
}

/**
 * FUNCTION: getTokenAccountBalanceRpc
 * PURPOSE: Return SPL token balance metadata for a token account.
 * PARAMS: params (array) expected [tokenAccountPubkey].
 * RETURNS: object with context and amount/decimals/uiAmount info.
 * THROWS: RpcError -32602 when account is missing/invalid token account.
 * EDGE CASES: 1) invalid/missing mint returns decimals 0 and uiAmount null.
 */
function getTokenAccountBalanceRpc(params) {
  const pubkey = params[0];
  if (!isValidBase58Pubkey(pubkey)) {
    throw new RpcError(-32602, 'Invalid params: invalid pubkey');
  }

  const account = getAccount(pubkey);
  if (!account) {
    throw new RpcError(-32602, 'could not find account');
  }
  if (!isTokenAccount(account)) {
    throw new RpcError(-32602, 'invalid token account');
  }

  let tokenData;
  try {
    tokenData = parseTokenAccountData(Buffer.from(account.data));
  } catch (err) {
    throw new RpcError(-32602, 'invalid token account');
  }

  let decimals = 0;
  let uiAmount = null;
  const mintAccount = getAccount(tokenData.mint);
  if (mintAccount && isMint(mintAccount)) {
    try {
      const mintData = parseMintData(Buffer.from(mintAccount.data));
      decimals = mintData.decimals;
      uiAmount = Number(tokenData.amount) / (10 ** decimals);
    } catch (err) {
      decimals = 0;
      uiAmount = null;
    }
  }

  return {
    context: { slot: getCurrentSlot() },
    value: {
      amount: tokenData.amount.toString(),
      decimals,
      uiAmount,
    },
  };
}

/**
 * FUNCTION: getTokenAccountsByOwnerRpc
 * PURPOSE: Enumerate token accounts owned by wallet with mint/program filters.
 * PARAMS: params (array) [ownerPubkey, filter, optionalConfig].
 * RETURNS: object with context and filtered token account list.
 * THROWS: RpcError -32602 for invalid owner/filter structures.
 * EDGE CASES: 1) missing mint/program filter rejected; 2) unknown mint/program returns empty list.
 */
function getTokenAccountsByOwnerRpc(params) {
  const ownerBase58 = params[0];
  const filter = params[1];

  if (!isValidBase58Pubkey(ownerBase58)) {
    throw new RpcError(-32602, 'Invalid params: invalid owner');
  }
  if (!filter || typeof filter !== 'object') {
    throw new RpcError(-32602, 'Invalid params: missing filter');
  }

  const hasMint = Object.prototype.hasOwnProperty.call(filter, 'mint');
  const hasProgramId = Object.prototype.hasOwnProperty.call(filter, 'programId');
  if ((hasMint && hasProgramId) || (!hasMint && !hasProgramId)) {
    throw new RpcError(-32602, 'Invalid params: ambiguous filter');
  }

  if (hasMint && !isValidBase58Pubkey(filter.mint)) {
    throw new RpcError(-32602, 'Invalid params: invalid mint');
  }
  if (hasProgramId && !isValidBase58Pubkey(filter.programId)) {
    throw new RpcError(-32602, 'Invalid params: invalid programId');
  }

  if (hasProgramId && filter.programId !== TOKEN_PROGRAM_ID) {
    return { context: { slot: getCurrentSlot() }, value: [] };
  }
  if (hasMint && !getAccount(filter.mint)) {
    return { context: { slot: getCurrentSlot() }, value: [] };
  }

  const value = [];
  for (const [pubkey, account] of accounts.entries()) {
    if (account.owner !== TOKEN_PROGRAM_ID || account.data.length !== 165) {
      continue;
    }
    let parsed;
    try {
      parsed = parseTokenAccountData(Buffer.from(account.data));
    } catch (err) {
      continue;
    }
    if (parsed.owner !== ownerBase58) {
      continue;
    }
    if (hasMint && parsed.mint !== filter.mint) {
      continue;
    }
    value.push({ pubkey, account: createAccountInfo(account) });
  }

  return { context: { slot: getCurrentSlot() }, value };
}

/**
 * FUNCTION: requestAirdropRpc
 * PURPOSE: Credit lamports to an account and return synthetic transaction signature.
 * PARAMS: params (array) [pubkey, lamports].
 * RETURNS: base58 signature string.
 * THROWS: RpcError -32602 for invalid inputs.
 * EDGE CASES: 1) lamports floored to integer; 2) missing account auto-created.
 */
function requestAirdropRpc(params) {
  const pubkey = params[0];
  const lamportsRaw = params[1];
  if (!isValidBase58Pubkey(pubkey)) {
    throw new RpcError(-32602, 'Invalid params: invalid pubkey');
  }
  if (typeof lamportsRaw !== 'number' || Number.isNaN(lamportsRaw) || !Number.isFinite(lamportsRaw)) {
    throw new RpcError(-32602, 'Invalid params: invalid lamports');
  }

  const lamports = BigInt(Math.floor(lamportsRaw));
  if (lamports <= 0n) {
    throw new RpcError(-32602, 'Invalid params: lamports must be positive');
  }

  if (!getAccount(pubkey)) {
    setAccount(pubkey, {
      pubkey,
      lamports: 0n,
      owner: SYSTEM_PROGRAM_ID,
      data: Buffer.alloc(0),
      executable: false,
      rentEpoch: 0,
    });
  }
  creditLamports(pubkey, lamports);

  const signature = bs58.encode(crypto.randomBytes(64));
  recordTransaction(signature, getCurrentSlot(), null);
  return signature;
}

/**
 * FUNCTION: executeInstruction
 * PURPOSE: Route one parsed instruction to the corresponding program handler.
 * PARAMS: instruction (object), accountKeys (string[]), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error when target program is unsupported or handler fails.
 * EDGE CASES: 1) only system/token/ATA programs are supported.
 */
function executeInstruction(instruction, accountKeys, signers) {
  const programId = accountKeys[instruction.programIdIndex];
  if (programId === SYSTEM_PROGRAM_ID) {
    executeSystemInstruction(instruction, accountKeys, accounts, signers);
    return;
  }
  if (programId === TOKEN_PROGRAM_ID) {
    executeTokenInstruction(instruction, accountKeys, accounts, signers);
    return;
  }
  if (programId === ATA_PROGRAM_ID) {
    executeAtaInstruction(instruction, accountKeys, accounts, signers);
    return;
  }
  throw new Error('program not found');
}

/**
 * FUNCTION: sendTransactionRpc
 * PURPOSE: Deserialize, verify, execute, and record a transaction atomically.
 * PARAMS: params (array) [encodedTx, options].
 * RETURNS: base58 first signature string.
 * THROWS: RpcError -32602 for malformed inputs; RpcError -32003 for tx execution failures.
 * EDGE CASES: 1) duplicate signature replay rejected; 2) rollback on any instruction failure.
 */
function sendTransactionRpc(params) {
  const encodedTx = params[0];
  const options = params[1] || {};
  if (typeof encodedTx !== 'string') {
    throw new RpcError(-32602, 'Invalid params: encodedTx must be base64 string');
  }

  const encoding = options && typeof options === 'object' && options.encoding ? options.encoding : 'base64';
  if (encoding !== 'base64') {
    throw new RpcError(-32602, 'Invalid params: only base64 encoding is supported');
  }

  let tx;
  try {
    tx = deserializeTransaction(encodedTx);
  } catch (err) {
    throw new RpcError(-32602, err.message || 'transaction deserialization failed');
  }

  const bhValidation = isValidBlockhash(tx.recentBlockhash, getBlockHeight());
  if (!bhValidation.valid) {
    throw new RpcError(-32003, bhValidation.reason || 'blockhash not found');
  }

  const verify = verifySignatures(
    tx.signatures,
    tx.messageBytes,
    tx.accountKeys,
    tx.header,
    tx.accountKeyBuffers,
  );
  if (!verify.valid) {
    throw new RpcError(-32003, verify.reason || 'signature verification failed');
  }

  const firstSig = bs58.encode(tx.signatures[0]);
  if (getTransactionStatus(firstSig)) {
    throw new RpcError(-32003, 'already processed');
  }

  const signers = buildSigners(tx.accountKeys, tx.header);
  const snapshot = snapshotAccounts(tx.accountKeys);
  try {
    for (const instruction of tx.instructions) {
      executeInstruction(instruction, tx.accountKeys, signers);
    }
  } catch (err) {
    restoreAccounts(snapshot);
    throw new RpcError(-32003, err.message || 'transaction failed');
  }

  incrementSlot();
  recordTransaction(firstSig, getCurrentSlot(), null);
  return firstSig;
}

/**
 * FUNCTION: getSignatureStatusesRpc
 * PURPOSE: Return execution statuses for provided transaction signatures.
 * PARAMS: params (array) expected [[sig1, sig2, ...]].
 * RETURNS: object with context and status array.
 * THROWS: RpcError -32602 when first param is not an array.
 * EDGE CASES: 1) null/non-string signatures yield null entries.
 */
function getSignatureStatusesRpc(params) {
  const signatures = params[0];
  if (!Array.isArray(signatures)) {
    throw new RpcError(-32602, 'Invalid params: expected array of signatures');
  }

  const value = signatures.map((sig) => {
    if (typeof sig !== 'string') {
      return null;
    }
    const status = getTransactionStatus(sig);
    if (!status) {
      return null;
    }
    return {
      slot: status.slot,
      confirmations: null,
      err: status.err,
      confirmationStatus: 'confirmed',
    };
  });

  return { context: { slot: getCurrentSlot() }, value };
}

/**
 * FUNCTION: dispatchMethod
 * PURPOSE: Dispatch JSON-RPC method calls to concrete implementation functions.
 * PARAMS: method (any), params (any), id (any).
 * RETURNS: method-specific JSON-compatible result payload.
 * THROWS: RpcError for invalid request/method/params or execution failure.
 * EDGE CASES: 1) null params normalized to []; 2) unknown methods return -32601.
 */
function dispatchMethod(method, params, id) {
  if (typeof method !== 'string') {
    throw new RpcError(-32600, 'Invalid Request');
  }

  const normalizedParams = normalizeParams(params);
  if (method === 'getVersion') {
    return getVersion(normalizedParams);
  }
  if (method === 'getSlot') {
    return getSlot(normalizedParams);
  }
  if (method === 'getBlockHeight') {
    return getBlockHeightRpc(normalizedParams);
  }
  if (method === 'getHealth') {
    return getHealth(normalizedParams);
  }
  if (method === 'getLatestBlockhash') {
    return getLatestBlockhashRpc(normalizedParams);
  }
  if (method === 'getBalance') {
    return getBalanceRpc(normalizedParams);
  }
  if (method === 'getAccountInfo') {
    return getAccountInfoRpc(normalizedParams);
  }
  if (method === 'getMinimumBalanceForRentExemption') {
    return getMinimumBalanceForRentExemptionRpc(normalizedParams);
  }
  if (method === 'getTokenAccountBalance') {
    return getTokenAccountBalanceRpc(normalizedParams);
  }
  if (method === 'getTokenAccountsByOwner') {
    return getTokenAccountsByOwnerRpc(normalizedParams);
  }
  if (method === 'requestAirdrop') {
    return requestAirdropRpc(normalizedParams);
  }
  if (method === 'sendTransaction') {
    return sendTransactionRpc(normalizedParams);
  }
  if (method === 'getSignatureStatuses') {
    return getSignatureStatusesRpc(normalizedParams);
  }

  throw new RpcError(-32601, 'Method not found');
}

module.exports = {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  RpcError,
  dispatchMethod,
  snapshotAccounts,
  restoreAccounts,
};
