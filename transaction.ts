const bs58 = require('bs58');
const nacl = require('tweetnacl');

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSVAR_RENT_PUBKEY = 'SysvarRent111111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * FUNCTION: isAllZeroBuffer
 * PURPOSE: Check whether a buffer is entirely zero bytes.
 * PARAMS: buffer (Buffer) input bytes.
 * RETURNS: boolean true when all bytes are zero.
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
 * FUNCTION: readCompactU16
 * PURPOSE: Parse Solana compact-u16 encoded value from byte buffer.
 * PARAMS: buf (Buffer), offset (number) start index.
 * RETURNS: object { value, bytesRead }.
 * THROWS: Error on buffer underrun or malformed continuation bytes.
 * EDGE CASES: 1) supports 1/2/3-byte forms; 2) rejects truncated encodings.
 */
function readCompactU16(buf, offset) {
  if (offset >= buf.length) {
    throw new Error('parse error: compact-u16 buffer underrun');
  }

  const b0 = buf[offset];
  if (b0 < 0x80) {
    return { value: b0, bytesRead: 1 };
  }

  if (offset + 1 >= buf.length) {
    throw new Error('parse error: compact-u16 buffer underrun');
  }

  const b1 = buf[offset + 1];
  let value = (b0 & 0x7f) | ((b1 & 0x7f) << 7);

  if (b1 < 0x80) {
    return { value, bytesRead: 2 };
  }

  if (offset + 2 >= buf.length) {
    throw new Error('parse error: compact-u16 buffer underrun');
  }

  const b2 = buf[offset + 2];
  if (b2 >= 0x80) {
    throw new Error('parse error: compact-u16 exceeds supported range');
  }

  value |= (b2 & 0x7f) << 14;
  return { value, bytesRead: 3 };
}

/**
 * FUNCTION: deserializeTransaction
 * PURPOSE: Decode and parse a legacy Solana transaction from base64 wire bytes.
 * PARAMS: base64String (string) encoded transaction.
 * RETURNS: parsed transaction object with signatures, messageBytes, account keys and instructions.
 * THROWS: Error for malformed base64, truncation, invalid indices, or missing blockhash.
 * EDGE CASES: 1) num_signatures must be >0; 2) all-zero recent blockhash rejected.
 */
function deserializeTransaction(base64String) {
  if (typeof base64String !== 'string') {
    throw new Error('invalid base64 transaction: expected string');
  }

  let raw;
  try {
    raw = Buffer.from(base64String, 'base64');
  } catch (err) {
    throw new Error('invalid base64 transaction');
  }

  if (raw.length === 0 || Buffer.from(raw.toString('base64'), 'base64').length === 0) {
    throw new Error('invalid base64 transaction');
  }

  let offset = 0;
  const sigLenRes = readCompactU16(raw, offset);
  const numSignatures = sigLenRes.value;
  offset += sigLenRes.bytesRead;

  if (numSignatures === 0) {
    throw new Error('invalid transaction: missing signatures');
  }

  if (offset + (numSignatures * 64) > raw.length) {
    throw new Error('parse error: signature section truncated');
  }

  const signatures = [];
  for (let i = 0; i < numSignatures; i += 1) {
    signatures.push(Buffer.from(raw.slice(offset, offset + 64)));
    offset += 64;
  }

  const messageStart = offset;
  if (messageStart + 3 > raw.length) {
    throw new Error('parse error: buffer too short for message header');
  }

  const header = {
    numRequiredSignatures: raw[offset],
    numReadonlySignedAccounts: raw[offset + 1],
    numReadonlyUnsignedAccounts: raw[offset + 2],
  };
  offset += 3;

  const accountLenRes = readCompactU16(raw, offset);
  const numAccountKeys = accountLenRes.value;
  offset += accountLenRes.bytesRead;

  if (offset + (numAccountKeys * 32) > raw.length) {
    throw new Error('parse error: account keys truncated');
  }

  const accountKeyBuffers = [];
  const accountKeys = [];
  for (let i = 0; i < numAccountKeys; i += 1) {
    const keyBytes = Buffer.from(raw.slice(offset, offset + 32));
    accountKeyBuffers.push(keyBytes);
    accountKeys.push(bs58.encode(keyBytes));
    offset += 32;
  }

  if (offset + 32 > raw.length) {
    throw new Error('parse error: missing recent blockhash');
  }

  const recentBlockhashBytes = Buffer.from(raw.slice(offset, offset + 32));
  if (isAllZeroBuffer(recentBlockhashBytes)) {
    throw new Error('invalid transaction: recent blockhash missing');
  }
  const recentBlockhash = bs58.encode(recentBlockhashBytes);
  offset += 32;

  const ixLenRes = readCompactU16(raw, offset);
  const numInstructions = ixLenRes.value;
  offset += ixLenRes.bytesRead;

  const instructions = [];
  for (let i = 0; i < numInstructions; i += 1) {
    const pidRes = readCompactU16(raw, offset);
    const programIdIndex = pidRes.value;
    offset += pidRes.bytesRead;
    if (programIdIndex < 0 || programIdIndex >= numAccountKeys) {
      throw new Error('parse error: program id index out of bounds');
    }

    const acRes = readCompactU16(raw, offset);
    const numAccounts = acRes.value;
    offset += acRes.bytesRead;

    if (offset + numAccounts > raw.length) {
      throw new Error('parse error: instruction account list truncated');
    }

    const accounts = [];
    for (let a = 0; a < numAccounts; a += 1) {
      const accountIndex = raw[offset];
      offset += 1;
      if (accountIndex >= numAccountKeys) {
        throw new Error('parse error: instruction account index out of bounds');
      }
      accounts.push(accountIndex);
    }

    const dataLenRes = readCompactU16(raw, offset);
    const dataLength = dataLenRes.value;
    offset += dataLenRes.bytesRead;
    if (offset + dataLength > raw.length) {
      throw new Error('parse error: instruction data truncated');
    }

    const data = Buffer.from(raw.slice(offset, offset + dataLength));
    offset += dataLength;
    instructions.push({ programIdIndex, accounts, data });
  }

  const messageBytes = Buffer.from(raw.slice(messageStart, offset));
  return {
    signatures,
    messageBytes,
    accountKeys,
    accountKeyBuffers,
    recentBlockhash,
    instructions,
    header,
  };
}

/**
 * FUNCTION: verifySignatures
 * PURPOSE: Verify all required ed25519 signatures against the transaction message bytes.
 * PARAMS: signatures (Buffer[]), messageBytes (Buffer), accountKeys (string[]), header (object), accountKeyBuffers (Buffer[] optional).
 * RETURNS: object { valid, reason? }.
 * THROWS: never; internal verification errors return invalid result.
 * EDGE CASES: 1) rejects all-zero signatures and zeroed pubkeys; 2) enforces exact required signer count.
 */
function verifySignatures(signatures, messageBytes, accountKeys, header, accountKeyBuffers) {
  const required = header.numRequiredSignatures;
  if (signatures.length !== required) {
    return { valid: false, reason: 'signature count mismatch' };
  }

  if (accountKeys.length < required) {
    return { valid: false, reason: 'insufficient signer pubkeys' };
  }

  for (let i = 0; i < required; i += 1) {
    const sig = signatures[i];
    if (!Buffer.isBuffer(sig) || sig.length !== 64) {
      return { valid: false, reason: 'signature verification failed' };
    }
    if (isAllZeroBuffer(sig)) {
      return { valid: false, reason: 'missing signature' };
    }

    let pubkeyBytes;
    try {
      pubkeyBytes = accountKeyBuffers && accountKeyBuffers[i]
        ? Buffer.from(accountKeyBuffers[i])
        : Buffer.from(bs58.decode(accountKeys[i]));
    } catch (err) {
      return { valid: false, reason: 'signature verification failed' };
    }

    if (pubkeyBytes.length !== 32 || isAllZeroBuffer(pubkeyBytes)) {
      return { valid: false, reason: 'signature verification failed' };
    }

    try {
      const ok = nacl.sign.detached.verify(
        new Uint8Array(messageBytes),
        new Uint8Array(sig),
        new Uint8Array(pubkeyBytes),
      );
      if (!ok) {
        return { valid: false, reason: 'signature verification failed' };
      }
    } catch (err) {
      return { valid: false, reason: 'signature verification failed' };
    }
  }

  return { valid: true };
}

module.exports = {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  readCompactU16,
  deserializeTransaction,
  verifySignatures,
};
