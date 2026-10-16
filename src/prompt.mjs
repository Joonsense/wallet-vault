import { createInterface } from 'node:readline';

export function hiddenPrompt(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Non interactive: read one line from stdin (piped passphrase)
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', d => { data += d; });
      process.stdin.on('end', () => resolve(data.split('\n')[0]));
      process.stdin.on('error', reject);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const origWrite = rl._writeToOutput;
    process.stderr.write(question);
    rl._writeToOutput = () => {};
    rl.question('', answer => {
      rl._writeToOutput = origWrite;
      process.stderr.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

export function visiblePrompt(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, a => { rl.close(); resolve(a.trim()); });
  });
}

/** Passphrase: env WV_PASSPHRASE (for bots, keep it in .env) or hidden prompt. */
export async function getPassphrase({ confirm = false, label = 'Vault passphrase' } = {}) {
  if (process.env.WV_PASSPHRASE) return process.env.WV_PASSPHRASE;
  const p = await hiddenPrompt(`${label}: `);
  if (confirm) {
    const again = await hiddenPrompt('Confirm passphrase: ');
    if (p !== again) throw new Error('passphrases do not match');
  }
  return p;
}
