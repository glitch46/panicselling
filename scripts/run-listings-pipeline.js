const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function readKeyFromEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  const raw = fs.readFileSync(envPath, 'utf-8');
  const match = raw.match(/RENTCAST_API_KEY\s*=\s*([^\r\n]+)/);
  if (!match) throw new Error('RENTCAST_API_KEY not found in .env');
  return match[1].trim().replace(/^['\"]|['\"]$/g, '');
}

function runNodeScript(scriptPath, env) {
  cp.execFileSync(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
}

function main() {
  const key = readKeyFromEnvFile();
  const env = { ...process.env, RENTCAST_API_KEY: key };

  console.log('Running listings fetch (single RentCast API call)...');
  runNodeScript(path.join('scripts', 'fetch-listings.js'), env);

  console.log('Running secondary verifier (no RentCast API calls)...');
  runNodeScript(path.join('scripts', 'verify-listings.js'), env);

  console.log('Done. Outputs updated: data/listings.json and data/listings-verification.json');
}

try {
  main();
} catch (err) {
  console.error('Fatal:', err.message || err);
  process.exit(1);
}
