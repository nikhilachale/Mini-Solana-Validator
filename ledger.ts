const U64_MAX = 18446744073709551615n;
const U32_MAX = 4294967295;

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSVAR_RENT_PUBKEY = 'SysvarRent111111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// All accounts keyed by base58 pubkey string.
const accounts = new Map();
let currentSlot = 1;
let blockHeight = 1;
const processedTxs = new Map();

/**
 * FUNCTION: cloneAccount
 * PURPOSE: Create a safe deep clone of an account object.
 * PARAMS: account (object|null) source account to clone.
 * RETURNS: cloned account object or null when input is nullish.
 * THROWS: never.
 * EDGE CASES: 1) null/undefined input returns null.
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
 * FUNCTION: getAccount
 * PURPOSE: Fetch an account by pubkey without creating defaults.
 * PARAMS: pubkeyBase58 (string) account key in base58 form.
 * RETURNS: cloned account object or null if not found.
 * THROWS: never.
 * EDGE CASES: 1) missing account returns null.
 */
function getAccount(pubkeyBase58) {
  const account = accounts.get(pubkeyBase58);
  return cloneAccount(account);
}

/**
 * FUNCTION: setAccount
 * PURPOSE: Merge fields into an account or create it if missing.
 * PARAMS: pubkeyBase58 (string) key; fields (object) partial account updates.
 * RETURNS: void.
 * THROWS: Error when lamports underflow, lamports overflow, or data exceeds u32 max.
 * EDGE CASES: 1) new account creation; 2) no-op merges; 3) data Buffer cloning.
 */
function setAccount(pubkeyBase58, fields) {
  const current = accounts.get(pubkeyBase58);
  const next = current
    ? cloneAccount(current)
    : {
        pubkey: pubkeyBase58,
        lamports: 0n,
        owner: SYSTEM_PROGRAM_ID,
        data: Buffer.alloc(0),
        executable: false,
        rentEpoch: 0,
      };

  if (Object.prototype.hasOwnProperty.call(fields, 'lamports')) {
    const lamports = BigInt(fields.lamports);
    if (lamports < 0n) {
      throw new Error('lamports cannot be negative');
    }
    if (lamports > U64_MAX) {
      throw new Error('lamports overflow');
    }
    next.lamports = lamports;
  }

  if (Object.prototype.hasOwnProperty.call(fields, 'owner')) {
    next.owner = String(fields.owner);
  }

  if (Object.prototype.hasOwnProperty.call(fields, 'data')) {
    const dataBuffer = Buffer.from(fields.data || Buffer.alloc(0));
    if (dataBuffer.length > U32_MAX) {
      throw new Error('account data exceeds maximum size');
    }
    next.data = dataBuffer;
  }

  if (Object.prototype.hasOwnProperty.call(fields, 'executable')) {
    next.executable = Boolean(fields.executable);
  }

  if (Object.prototype.hasOwnProperty.call(fields, 'rentEpoch')) {
    next.rentEpoch = Number(fields.rentEpoch);
  }

  accounts.set(pubkeyBase58, next);
}

/**
 * FUNCTION: deleteAccount
 * PURPOSE: Remove an account from the in-memory ledger map.
 * PARAMS: pubkeyBase58 (string) key to remove.
 * RETURNS: void.
 * THROWS: never.
 * EDGE CASES: 1) deleting missing account is a no-op.
 */
function deleteAccount(pubkeyBase58) {
  accounts.delete(pubkeyBase58);
}

/**
 * FUNCTION: creditLamports
 * PURPOSE: Add lamports to an account with u64 overflow checks.
 * PARAMS: pubkeyBase58 (string) target key; amount (BigInt|number|string) lamports to add.
 * RETURNS: void.
 * THROWS: Error for negative amount or overflow.
 * EDGE CASES: 1) missing account is auto-created; 2) zero amount is allowed.
 */
function creditLamports(pubkeyBase58, amount) {
  const addAmount = BigInt(amount);
  if (addAmount < 0n) {
    throw new Error('credit amount cannot be negative');
  }

  const account = getAccount(pubkeyBase58) || {
    pubkey: pubkeyBase58,
    lamports: 0n,
    owner: SYSTEM_PROGRAM_ID,
    data: Buffer.alloc(0),
    executable: false,
    rentEpoch: 0,
  };

  const next = account.lamports + addAmount;
  if (next > U64_MAX) {
    throw new Error('lamports overflow');
  }

  setAccount(pubkeyBase58, { ...account, lamports: next });
}

/**
 * FUNCTION: debitLamports
 * PURPOSE: Subtract lamports safely from an account.
 * PARAMS: pubkeyBase58 (string) source key; amount (BigInt|number|string) lamports to subtract.
 * RETURNS: object with { success: boolean, reason?: string }.
 * THROWS: Error for negative debit amount.
 * EDGE CASES: 1) zero debit is valid no-op; 2) missing account returns insufficient funds.
 */
function debitLamports(pubkeyBase58, amount) {
  const subAmount = BigInt(amount);
  if (subAmount < 0n) {
    throw new Error('debit amount cannot be negative');
  }
  if (subAmount === 0n) {
    return { success: true };
  }

  const account = getAccount(pubkeyBase58);
  if (!account || account.lamports < subAmount) {
    return { success: false, reason: 'insufficient funds' };
  }

  const next = account.lamports - subAmount;
  if (next < 0n) {
    return { success: false, reason: 'insufficient funds' };
  }

  setAccount(pubkeyBase58, { ...account, lamports: next });
  return { success: true };
}

/**
 * FUNCTION: incrementSlot
 * PURPOSE: Increment slot and blockheight after a successful transaction.
 * PARAMS: none.
 * RETURNS: void.
 * THROWS: never.
 * EDGE CASES: 1) monotonically increases both counters together.
 */
function incrementSlot() {
  currentSlot += 1;
  blockHeight += 1;
}

/**
 * FUNCTION: getCurrentSlot
 * PURPOSE: Return current slot value.
 * PARAMS: none.
 * RETURNS: number slot.
 * THROWS: never.
 * EDGE CASES: 1) always >= 1 from bootstrapped state.
 */
function getCurrentSlot() {
  return currentSlot;
}

/**
 * FUNCTION: getBlockHeight
 * PURPOSE: Return current block height value.
 * PARAMS: none.
 * RETURNS: number block height.
 * THROWS: never.
 * EDGE CASES: 1) always >= 1 from bootstrapped state.
 */
function getBlockHeight() {
  return blockHeight;
}

/**
 * FUNCTION: recordTransaction
 * PURPOSE: Persist transaction execution status for signature lookups.
 * PARAMS: sig (string), slotAtExecution (number), err (any|null).
 * RETURNS: void.
 * THROWS: never.
 * EDGE CASES: 1) duplicate signatures overwrite prior status.
 */
function recordTransaction(sig, slotAtExecution, err) {
  processedTxs.set(sig, { slot: slotAtExecution, err: err || null });
}

/**
 * FUNCTION: getTransactionStatus
 * PURPOSE: Retrieve a processed transaction status.
 * PARAMS: sig (string) transaction signature.
 * RETURNS: status object or null if unknown.
 * THROWS: never.
 * EDGE CASES: 1) missing signature returns null.
 */
function getTransactionStatus(sig) {
  return processedTxs.get(sig) || null;
}

/**
 * FUNCTION: getRentExemptMinimum
 * PURPOSE: Compute deterministic rent-exempt lamports for a data size.
 * PARAMS: dataSize (number) account data length in bytes.
 * RETURNS: BigInt lamports minimum.
 * THROWS: Error if size is not finite or is negative.
 * EDGE CASES: 1) size is floored; 2) consistent deterministic output.
 */
function getRentExemptMinimum(dataSize) {
  if (!Number.isFinite(dataSize) || dataSize < 0) {
    throw new Error('invalid data size');
  }
  const normalized = Math.floor(dataSize);
  return BigInt(Math.ceil((normalized + 128) * 6960 * 2));
}

/**
 * FUNCTION: cloneProcessedTxs
 * PURPOSE: Create a deep snapshot of processed transaction statuses.
 * PARAMS: none.
 * RETURNS: Map clone containing status records.
 * THROWS: never.
 * EDGE CASES: 1) empty map returns empty clone.
 */
function cloneProcessedTxs() {
  const clone = new Map();
  for (const [sig, value] of processedTxs.entries()) {
    clone.set(sig, { slot: value.slot, err: value.err });
  }
  return clone;
}

/**
 * FUNCTION: restoreProcessedTxs
 * PURPOSE: Restore processed transaction statuses from snapshot.
 * PARAMS: snapshot (Map) map generated by cloneProcessedTxs.
 * RETURNS: void.
 * THROWS: never.
 * EDGE CASES: 1) clears current map before restoring.
 */
function restoreProcessedTxs(snapshot) {
  processedTxs.clear();
  for (const [sig, value] of snapshot.entries()) {
    processedTxs.set(sig, { slot: value.slot, err: value.err });
  }
}

module.exports = {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  U64_MAX,
  accounts,
  processedTxs,
  getAccount,
  setAccount,
  deleteAccount,
  creditLamports,
  debitLamports,
  incrementSlot,
  getCurrentSlot,
  getBlockHeight,
  recordTransaction,
  getTransactionStatus,
  getRentExemptMinimum,
  cloneProcessedTxs,
  restoreProcessedTxs,
};
