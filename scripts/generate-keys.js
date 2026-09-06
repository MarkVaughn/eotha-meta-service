import { writeFileSync, mkdirSync } from 'fs';
import { generateKeyPair } from 'crypto';
import { join } from 'path';

mkdirSync('./keys', { recursive: true });

generateKeyPair('ed25519', {
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' }
}, (err, publicKey, privateKey) => {
  if (err) {
    console.error("Failed to generate keys:", err);
    process.exit(1);
  }
  writeFileSync(join('./keys', 'private.pem'), privateKey);
  writeFileSync(join('./keys', 'public.pem'), publicKey);
  console.log("🚀 Cryptographic asymmetric key pair successfully generated inside ./keys/");
});
