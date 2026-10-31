// Signs the update information so Dogfile only trusts releases made by you.
//
//   node build/sign-update.mjs keygen <private-key-file>            make a key pair (once)
//   node build/sign-update.mjs sign <private-key-file> <latest.json>  writes <latest.json>.sig
//
// Keep the private key file OUT of this repository and back it up (if it is lost, installed copies can no longer
// be updated). Set DOGFILE_SIGN_PASSPHRASE to protect it with a passphrase. Publish latest.json and latest.json.sig
// side by side. The public key printed by keygen goes in UPDATE_PUBKEYS in backend/src/update.rs.
import crypto from 'node:crypto';
import fs from 'node:fs';

const [cmd, keyFile, jsonFile] = process.argv.slice(2);
const passphrase = process.env.DOGFILE_SIGN_PASSPHRASE || undefined;
const rawPublic = (pub) => crypto.createPublicKey(pub).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const fail = (m) => { console.error(m); process.exit(1); };

if (cmd === 'keygen' && keyFile) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) });
  try { fs.writeFileSync(keyFile, pem, { flag: 'wx', mode: 0o600 }); } catch (e) { fail(`Not written: ${e.message}`); }
  console.log(`Private key saved to ${keyFile} (keep it safe, and not in the repository).`);
  console.log(`Public key for UPDATE_PUBKEYS:\n  "${rawPublic(privateKey)}"`);
} else if (cmd === 'sign' && keyFile && jsonFile) {
  const key = crypto.createPrivateKey({ key: fs.readFileSync(keyFile), format: 'pem', passphrase });
  const data = fs.readFileSync(jsonFile);
  try { JSON.parse(data.toString('utf8')); } catch { fail(`${jsonFile} is not valid JSON`); }
  const sig = crypto.sign(null, data, key);
  if (!crypto.verify(null, data, crypto.createPublicKey(key), sig)) fail('The signature did not verify');
  fs.writeFileSync(`${jsonFile}.sig`, sig.toString('base64') + '\n');
  console.log(`Wrote ${jsonFile}.sig (signed with public key ${rawPublic(key)})`);
} else {
  fail('Usage:\n  node build/sign-update.mjs keygen <private-key-file>\n  node build/sign-update.mjs sign <private-key-file> <latest.json>');
}
