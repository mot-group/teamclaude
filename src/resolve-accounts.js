import { importCredentials } from './oauth.js';
import { importCodexCredentials, validateCodexCredentials } from './codex-auth.js';
import { providerOf } from './provider.js';
import { credentialFile } from './account-source.js';

/**
 * Turn configured accounts into the objects the AccountManager is built from:
 * `importFrom` entries have their credentials read from disk, and entries with
 * no usable credential are dropped with a message.
 *
 * Config fields are carried through verbatim — the import supplies ONLY the
 * credential fields. Rebuilding an imported account as `{ name, type, ...creds }`
 * used to discard everything else on it (`disabled`, `priority`, `upstream`,
 * `modelMap`, `models`), so an account disabled on disk silently rejoined
 * rotation on every restart and a third-party backend lost its upstream.
 */
export async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      const isCodex = providerOf(acct) === 'codex';
      const from = credentialFile(acct);
      if (from) {
        try {
          const creds = isCodex ? await importCodexCredentials(from) : await importCredentials(from);
          // A readable file with no token is as unusable as a missing one; the
          // non-import branch below already refuses that case, and pushing it
          // anyway would send `Bearer undefined` upstream on every request.
          if (!creds.accessToken || (isCodex && (typeof creds.accessToken !== 'string' || !creds.accessToken.trim()))) {
            console.error(`No token in ${from} for "${acct.name}", skipping`);
            continue;
          }
          accounts.push({ ...acct, importFrom: from, ...creds });
          console.log(`Imported "${acct.name}" from ${from}`);
        } catch (err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
        }
      } else if (acct.accessToken && (!isCodex || (typeof acct.accessToken === 'string' && acct.accessToken.trim()))) {
        try {
          accounts.push(isCodex ? validateCodexCredentials(acct) : acct);
        } catch (err) {
          console.error(`Invalid credentials for "${acct.name}": ${err.message}`);
        }
      } else {
        console.error(`No token for "${acct.name}", skipping${isCodex ? '; re-enroll with teamclaude login --codex' : ''}`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    }
  }
  return accounts;
}
