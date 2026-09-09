import { DEFAULT_CODEX_CREDENTIALS_PATH } from './codex-auth.js';
import { providerOf } from './provider.js';

export function credentialFile(account) {
  if (account?.type !== 'oauth') return null;
  if (account.importFrom) return account.importFrom;
  // Older saves copied native tokens into unmarked rows, but never accountId.
  // Token presence alone cannot distinguish those rows from a direct login.
  if (providerOf(account) === 'codex' && !account.source && !Object.hasOwn(account, 'accountId')) {
    return DEFAULT_CODEX_CREDENTIALS_PATH;
  }
  return null;
}

export function normalizeAccountSources(accounts) {
  for (const account of accounts || []) {
    const file = credentialFile(account);
    if (file) account.importFrom = file;
  }
}

export function ownsInlineToken(account) {
  return account?.type === 'oauth' && !credentialFile(account);
}

export function importedCodexTuple(account) {
  if (providerOf(account) !== 'codex' || !credentialFile(account)) return null;
  return [credentialFile(account), account.accessToken, account.refreshToken ?? null, account.accountId ?? null];
}
