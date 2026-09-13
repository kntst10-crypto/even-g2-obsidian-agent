import { writeFile, readFile } from 'node:fs/promises';
const sdk = JSON.parse(await readFile('node_modules/@evenrealities/even_hub_sdk/package.json', 'utf8'));
const value = process.env.RELAY_ORIGIN || 'https://relay.example.invalid';
const origin = new URL(value);
if (origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`) throw new Error('RELAY_ORIGIN must be an exact HTTPS origin');
if (process.env.RELEASE === 'true' && origin.hostname.endsWith('.invalid')) throw new Error('Release blocked: configure a real RELAY_ORIGIN');
await writeFile('app.json', JSON.stringify({ package_id: 'com.kentasato.vaultlens', edition: '202601', name: 'Vault Lens', version: '0.2.0', min_app_version: sdk.minAppVersion, min_sdk_version: sdk.version, entrypoint: 'index.html', permissions: [{ name: 'network', desc: 'Connect to the fixed Vault Lens relay to search notes, prepare confirmed appends, and transcribe audio.', whitelist: [origin.origin] }, { name: 'g2-microphone', desc: 'Record up to 30 seconds only after a tap. Audio is sent for transcription only after confirmation.' }], supported_languages: ['ja'] }, null, 2) + '\n');
console.log(origin.hostname.endsWith('.invalid') ? 'DEVELOPMENT manifest — not for submission' : `Manifest fixed to ${origin.origin}`);
