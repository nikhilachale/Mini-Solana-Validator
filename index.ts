const express = require('express');
const { dispatchMethod, RpcError } = require('./rpc.ts');

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSVAR_RENT_PUBKEY = 'SysvarRent111111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const app = express();

/**
 * FUNCTION: buildErrorResponse
 * PURPOSE: Build a JSON-RPC error response envelope.
 * PARAMS: id (any), code (number), message (string), data (optional any).
 * RETURNS: JSON-RPC response object.
 * THROWS: never.
 * EDGE CASES: 1) missing id represented as null.
 */
function buildErrorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

/**
 * FUNCTION: isPlainObject
 * PURPOSE: Determine if a value is a non-null object and not an array.
 * PARAMS: value (any) candidate.
 * RETURNS: boolean.
 * THROWS: never.
 * EDGE CASES: 1) arrays return false.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * FUNCTION: handleSingleRequest
 * PURPOSE: Validate and process one JSON-RPC request object.
 * PARAMS: requestBody (any) raw JSON-RPC object.
 * RETURNS: JSON-RPC success or error object.
 * THROWS: never, all errors converted to JSON-RPC response.
 * EDGE CASES: 1) invalid object/jsonrpc/method handled with -32600.
 */
function handleSingleRequest(requestBody) {
  try {
    if (!isPlainObject(requestBody)) {
      throw new RpcError(-32600, 'Invalid Request');
    }

    const id = Object.prototype.hasOwnProperty.call(requestBody, 'id') ? requestBody.id : null;
    if (requestBody.jsonrpc !== '2.0') {
      throw new RpcError(-32600, 'Invalid Request');
    }
    if (typeof requestBody.method !== 'string') {
      throw new RpcError(-32600, 'Invalid Request');
    }

    const result = dispatchMethod(requestBody.method, requestBody.params, id);
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    const id = isPlainObject(requestBody) && Object.prototype.hasOwnProperty.call(requestBody, 'id')
      ? requestBody.id
      : null;
    if (err instanceof RpcError) {
      return buildErrorResponse(id, err.code, err.message, err.data);
    }
    return buildErrorResponse(id, -32003, err.message || 'Internal error');
  }
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).json({ jsonrpc: '2.0', id: null, result: 'ok' });
    return;
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    res.status(200).json(buildErrorResponse(null, -32600, 'Parse error'));
    return;
  }
  next(err);
});

app.post('/', (req, res) => {
  try {
    const body = req.body;
    if (Array.isArray(body)) {
      if (body.length === 0) {
        res.status(200).json([buildErrorResponse(null, -32600, 'Invalid Request')]);
        return;
      }
      const results = body.map((item) => handleSingleRequest(item));
      res.status(200).json(results);
      return;
    }

    const response = handleSingleRequest(body);
    res.status(200).json(response);
  } catch (err) {
    res.status(200).json(buildErrorResponse(null, -32600, err.message || 'Invalid Request'));
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  // Startup confirmation expected by task requirements.
  // eslint-disable-next-line no-console
  console.log(`Mini Solana Validator running on port ${PORT}`);
});
