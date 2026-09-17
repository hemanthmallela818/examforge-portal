import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

let cached;

export const fixturesFor = projectName => {
  cached ||= JSON.parse(readFileSync('e2e/.state/fixtures.json', 'utf8'));
  const credentials = cached.credentials[projectName];
  if (!credentials) throw new Error(`No E2E fixture exists for project ${projectName}.`);
  return { ...cached, credentials };
};

const decodeBase32 = value => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid TOTP secret.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
};

export const generateTotp = (secret, now = Date.now()) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, '0');
};
