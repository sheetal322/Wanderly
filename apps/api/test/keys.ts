import { generateKeyPairSync } from 'node:crypto';

export interface TestKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  /** Base64-encoded, the form the environment variables take. */
  privateKeyBase64: string;
  publicKeyBase64: string;
}

export function generateTestKeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    privateKeyBase64: Buffer.from(privateKey).toString('base64'),
    publicKeyBase64: Buffer.from(publicKey).toString('base64'),
  };
}
