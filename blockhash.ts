const crypto = require('crypto');
const bs58 = require('bs58');

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSVAR_RENT_PUBKEY = 'SysvarRent111111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const issuedBlockhashes = new Map();

/**
 * FUNCTION: issueBlockhash
 * PURPOSE: Generate and persist a fresh recent blockhash with expiry window.
 * PARAMS: currentSlot (number), currentBlockHeight (number).
 * RETURNS: object { blockhash, lastValidBlockHeight }.
 * THROWS: never.
 * EDGE CASES: 1) always returns unique random value; 2) expiry uses +150 window.
 */
function issueBlockhash(currentSlot, currentBlockHeight) {
  let blockhash = '';
  do {
    blockhash = bs58.encode(crypto.randomBytes(32));
  } while (issuedBlockhashes.has(blockhash));

  const lastValidBlockHeight = currentBlockHeight + 150;
  issuedBlockhashes.set(blockhash, {
    issuedAtSlot: currentSlot,
    issuedAtBlockHeight: currentBlockHeight,
    lastValidBlockHeight,
  });

  return { blockhash, lastValidBlockHeight };
}

/**
 * FUNCTION: isValidBlockhash
 * PURPOSE: Validate whether a blockhash belongs to this server and is not expired.
 * PARAMS: blockhash (string), currentBlockHeight (number).
 * RETURNS: object { valid, reason? }.
 * THROWS: never.
 * EDGE CASES: 1) empty input rejects; 2) base58-decodable but unknown hash rejects.
 */
function isValidBlockhash(blockhash, currentBlockHeight) {
  if (typeof blockhash !== 'string' || blockhash.length === 0) {
    return { valid: false, reason: 'blockhash not found' };
  }

  const entry = issuedBlockhashes.get(blockhash);
  if (!entry) {
    return { valid: false, reason: 'blockhash not found' };
  }

  if (currentBlockHeight > entry.lastValidBlockHeight) {
    return { valid: false, reason: 'blockhash expired' };
  }

  return { valid: true };
}

module.exports = {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  issuedBlockhashes,
  issueBlockhash,
  isValidBlockhash,
};
