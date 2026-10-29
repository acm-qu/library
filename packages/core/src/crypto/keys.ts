// Per-asset keys wrapped under MASTER_KEY with crypto_secretbox_easy: stored as nonce (24) | box.
import sodium from 'sodium-native';

export const MASTER_KEY_BYTES = sodium.crypto_secretbox_KEYBYTES; // 32
const NONCE = sodium.crypto_secretbox_NONCEBYTES;
const MAC = sodium.crypto_secretbox_MACBYTES;

export function randomKey(bytes: number): Buffer {
  const k = Buffer.alloc(bytes);
  sodium.randombytes_buf(k);
  return k;
}

export function parseMasterKey(b64: string): Buffer {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== MASTER_KEY_BYTES) throw new Error(`MASTER_KEY must decode to ${MASTER_KEY_BYTES} bytes`);
  return k;
}

export function wrapKey(key: Buffer, master: Buffer): Buffer {
  const nonce = randomKey(NONCE);
  const box = Buffer.alloc(key.length + MAC);
  sodium.crypto_secretbox_easy(box, key, nonce, master);
  return Buffer.concat([nonce, box]);
}

export function unwrapKey(wrapped: Buffer, master: Buffer): Buffer {
  if (wrapped.length <= NONCE + MAC) throw new Error('wrapped key too short');
  const key = Buffer.alloc(wrapped.length - NONCE - MAC);
  if (!sodium.crypto_secretbox_open_easy(key, wrapped.subarray(NONCE), wrapped.subarray(0, NONCE), master)) {
    throw new Error('wrapped key failed authentication (wrong MASTER_KEY?)');
  }
  return key;
}
