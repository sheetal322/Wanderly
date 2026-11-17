// Generates an RS256 key pair for signing access tokens and writes it into .env
// as base64-encoded PEM. Local development only: deployed keys belong in a
// secrets manager, never in a file.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ENV_FILE = '.env';
const KEYS = ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'];

if (!existsSync(ENV_FILE)) {
  console.error('No .env found. Run `cp .env.example .env` first.');
  process.exit(1);
}

let contents = readFileSync(ENV_FILE, 'utf8');
const hasValue = (key) => new RegExp(`^${key}=.+$`, 'm').test(contents);

if (KEYS.every(hasValue) && !process.argv.includes('--force')) {
  console.log('JWT keys already present in .env (pass --force to replace them).');
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const values = {
  JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
  JWT_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
};

for (const [key, value] of Object.entries(values)) {
  const line = new RegExp(`^${key}=.*$`, 'm');
  contents = line.test(contents)
    ? contents.replace(line, `${key}=${value}`)
    : `${contents.trimEnd()}\n${key}=${value}\n`;
}

writeFileSync(ENV_FILE, contents);
console.log('Wrote a new RS256 key pair to .env. Existing access tokens are now invalid.');
