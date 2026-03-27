const { PublicKey } = require('@solana/web3.js');
const {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  getAccount,
  setAccount,
  debitLamports,
  getRentExemptMinimum,
} = require('./ledger.ts');
const {
  parseMintData,
  parseTokenAccountData,
  writeTokenAccountData,
  isMint,
  isTokenAccount,
} = require('./tokenProgram.ts');

/**
 * FUNCTION: findAssociatedTokenAddress
 * PURPOSE: Deterministically derive ATA PDA for owner+mint under ATA program.
 * PARAMS: ownerBase58 (string), mintBase58 (string).
 * RETURNS: base58 ATA address.
 * THROWS: Error when owner/mint/program IDs are invalid pubkeys.
 * EDGE CASES: 1) deterministic output for identical inputs.
 */
function findAssociatedTokenAddress(ownerBase58, mintBase58) {
  const owner = new PublicKey(ownerBase58);
  const mint = new PublicKey(mintBase58);
  const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
  const ataProgram = new PublicKey(ATA_PROGRAM_ID);

  const [pda] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ataProgram,
  );
  return pda.toBase58();
}

/**
 * FUNCTION: assertAccountIndex
 * PURPOSE: Resolve and validate account index for ATA instruction accounts.
 * PARAMS: ixIndex (number), accountKeys (string[]), label (string).
 * RETURNS: base58 pubkey string.
 * THROWS: Error on out-of-bounds indices.
 * EDGE CASES: 1) undefined index rejected.
 */
function assertAccountIndex(ixIndex, accountKeys, label) {
  if (!Number.isInteger(ixIndex) || ixIndex < 0 || ixIndex >= accountKeys.length) {
    throw new Error(`${label} account index out of bounds`);
  }
  return accountKeys[ixIndex];
}

/**
 * FUNCTION: executeAtaInstruction
 * PURPOSE: Execute ATA Create/CreateIdempotent account creation flows.
 * PARAMS: instruction (object), accountKeys (string[]), accounts (unused), signers (Set<string>).
 * RETURNS: void.
 * THROWS: Error when account wiring, signatures, mint validity, or funding checks fail.
 * EDGE CASES: 1) data empty treated as Create; 2) idempotent variant succeeds when ATA already initialized.
 */
function executeAtaInstruction(instruction, accountKeys, accounts, signers) {
  const variant = instruction.data.length === 0 ? 0 : instruction.data.readUInt8(0);
  const isIdempotent = variant === 1;
  const isCreate = variant === 0;
  if (!isCreate && !isIdempotent) {
    throw new Error('unknown ATA instruction');
  }

  const payer = assertAccountIndex(instruction.accounts[0], accountKeys, 'payer');
  const ata = assertAccountIndex(instruction.accounts[1], accountKeys, 'ata');
  const owner = assertAccountIndex(instruction.accounts[2], accountKeys, 'owner');
  const mint = assertAccountIndex(instruction.accounts[3], accountKeys, 'mint');
  const systemProgram = assertAccountIndex(instruction.accounts[4], accountKeys, 'system program');
  const tokenProgram = assertAccountIndex(instruction.accounts[5], accountKeys, 'token program');

  if (systemProgram !== SYSTEM_PROGRAM_ID) {
    throw new Error('invalid system program');
  }
  if (tokenProgram !== TOKEN_PROGRAM_ID) {
    throw new Error('invalid token program');
  }

  const expectedAta = findAssociatedTokenAddress(owner, mint);
  if (ata !== expectedAta) {
    throw new Error('invalid ATA address');
  }

  if (!signers.has(payer)) {
    throw new Error('missing required signature');
  }

  const mintAccount = getAccount(mint);
  if (!mintAccount || !isMint(mintAccount)) {
    throw new Error('invalid mint');
  }
  const mintData = parseMintData(Buffer.from(mintAccount.data));
  if (!mintData.isInitialized) {
    throw new Error('invalid mint');
  }

  const existingAta = getAccount(ata);
  if (existingAta && isTokenAccount(existingAta)) {
    let parsed;
    try {
      parsed = parseTokenAccountData(Buffer.from(existingAta.data));
    } catch (err) {
      parsed = null;
    }
    if (parsed && parsed.state === 1) {
      if (isIdempotent) {
        return;
      }
      throw new Error('associated token account already exists');
    }
  }

  const rentLamports = getRentExemptMinimum(165);
  const debitResult = debitLamports(payer, rentLamports);
  if (!debitResult.success) {
    throw new Error('insufficient funds for ATA creation');
  }

  setAccount(ata, {
    pubkey: ata,
    lamports: rentLamports,
    owner: TOKEN_PROGRAM_ID,
    data: writeTokenAccountData({
      mint,
      owner,
      amount: 0n,
      state: 1,
      delegateOption: 0,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
    }),
    executable: false,
    rentEpoch: 0,
  });
}

module.exports = {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  MEMO_PROGRAM_ID,
  findAssociatedTokenAddress,
  executeAtaInstruction,
};
