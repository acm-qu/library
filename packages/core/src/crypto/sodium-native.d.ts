// The subset of sodium-native 4.3 we use (5.x prebuilds need a newer libstdc++ than the host has). @types/sodium-native tracks 2.x, so we declare our own.
declare module 'sodium-native' {
  const sodium: {
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
    crypto_aead_xchacha20poly1305_ietf_encrypt(c: Buffer, m: Buffer, ad: Buffer | null, nsec: null, npub: Buffer, k: Buffer): number;
    /** Throws when authentication fails. */
    crypto_aead_xchacha20poly1305_ietf_decrypt(m: Buffer, nsec: null, c: Buffer, ad: Buffer | null, npub: Buffer, k: Buffer): number;
    crypto_secretbox_KEYBYTES: number;
    crypto_secretbox_NONCEBYTES: number;
    crypto_secretbox_MACBYTES: number;
    crypto_secretbox_easy(c: Buffer, m: Buffer, n: Buffer, k: Buffer): void;
    crypto_secretbox_open_easy(m: Buffer, c: Buffer, n: Buffer, k: Buffer): boolean;
    randombytes_buf(buf: Buffer): void;
  };
  export default sodium;
}
