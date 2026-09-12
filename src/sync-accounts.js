import { importCredentials } from './oauth.js';
import { sameAccountEntry } from './identity.js';
import { ensureAccountIds } from './account-id.js';
import { resolveAccounts } from './resolve-accounts.js';
import { credentialFile, normalizeAccountSources, importedCodexTuple } from './account-source.js';
import { providerOf } from './provider.js';

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
export async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  normalizeAccountSources(diskConfig.accounts);
  normalizeAccountSources(memConfig.accounts);
  // Greedy 1:1 pairing of disk entries to in-memory accounts, account+org aware.
  // Each disk entry claims at most one unclaimed manager account, so multiple
  // same-person/different-org entries pair correctly instead of all matching the
  // first one with that accountUuid.
  const claimed = new Set();
  const claim = (diskAcct) => {
    for (let i = 0; i < accountManager.accounts.length; i++) {
      if (!claimed.has(i) && sameAccountEntry(accountManager.accounts[i], diskAcct)) {
        claimed.add(i);
        return i;
      }
    }
    return -1;
  };

  // The memConfig list needs the same greedy 1:1 pairing, for the same reason
  // and then some: it is not index-aligned with the manager (resolveAccounts
  // drops credential-less entries at startup, shifting every later index), and
  // its entries never receive the org backfill below, so a first-match scan
  // pairs an unorged entry with whichever same-uuid disk entry comes first.
  const cfgClaimed = new Set();
  const claimConfig = (diskAcct) => {
    for (let i = 0; i < memConfig.accounts.length; i++) {
      if (!cfgClaimed.has(i) && sameAccountEntry(memConfig.accounts[i], diskAcct)) {
        cfgClaimed.add(i);
        return memConfig.accounts[i];
      }
    }
    return null;
  };

  for (const diskAcct of diskConfig.accounts) {
    const isCodex = providerOf(diskAcct) === 'codex';
    const resolved = isCodex ? (await resolveAccounts({ accounts: [diskAcct] }))[0] : diskAcct;
    const mgrIdx = claim(diskAcct);
    // Claimed once per disk entry and reused below. Calling claimConfig twice
    // for one entry would consume two different config rows.
    const cfgAcct = claimConfig(diskAcct);

    if (mgrIdx < 0) {
      // No manager account — which is NOT the same as "not yet known".
      // resolveAccounts drops every entry without a usable credential (an oauth
      // entry with no token, or an importFrom whose file has gone away — what
      // logging out of Claude Code produces), so such an entry has no account
      // for the life of the process. Pushing a config row for it on every pass
      // grew the list without bound: the save carried the duplicate to disk, the
      // next reload found another unclaimable row, and the pair compounded
      // (#200, #235).
      //
      // The account is still added, so an entry whose credential reappears heals
      // on the next reload rather than needing a restart. Only the duplicate
      // config row is suppressed.
      if (!cfgAcct) {
        // Genuinely new. Both lists take the same object, so the account is
        // built carrying its entry's id and the two pair from the moment they
        // exist. ensureAccountIds runs between the two: a hand-copied section
        // arrives holding an id this list already uses, and re-minting it before
        // the account is built keeps the pair correct.
        memConfig.accounts.push(diskAcct);
        ensureAccountIds(memConfig.accounts);
        cfgClaimed.add(memConfig.accounts.length - 1);
      }
      if (!resolved) continue;
      accountManager.addAccount(isCodex ? { ...resolved, id: cfgAcct?.id || diskAcct.id } : diskAcct);
      claimed.add(accountManager.accounts.length - 1);
      added++;
      console.log(cfgAcct
        ? `[TeamClaude] Re-admitting known account "${diskAcct.name}" from config`
        : `[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    const mgr = accountManager.accounts[mgrIdx];

    // Backfill org identity and pick up renames/priority onto the running
    // account (e.g. after disk-side org disambiguation or a `priority` change).
    if (diskAcct.orgUuid && !mgr.orgUuid) mgr.orgUuid = diskAcct.orgUuid;
    if (diskAcct.orgName && !mgr.orgName) mgr.orgName = diskAcct.orgName;
    for (const field of ['organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro']) {
      if (diskAcct[field] != null) mgr[field] = diskAcct[field];
    }
    if (diskAcct.name && mgr.name !== diskAcct.name) mgr.name = diskAcct.name;
    if (diskAcct.priority != null && mgr.priority !== diskAcct.priority) mgr.priority = diskAcct.priority;
    // A cap edit applies live for the same reason priority does: it is an
    // operator decision about a running fleet, and waiting for a restart to
    // honour a budget defeats the budget.
    mgr.maxUsage = diskAcct.maxUsage ?? null;
    // Third-party-backend bindings are read per request off this object
    // (`account.upstream || upstream`, `account.modelMap` in server.js), so a
    // disk edit must land here to take effect on reload. `|| null` mirrors the
    // constructor's normalization, letting a removal on disk revert the account
    // to the fleet default instead of sticking on the old value.
    mgr.upstream = diskAcct.upstream || null;
    mgr.modelMap = diskAcct.modelMap || null;
    // The deprecated ownership claim decides which accounts may serve a model,
    // and selection reads it off this object. Without picking up the edit,
    // migrating an account to a route needed a restart to take effect — and the
    // force control, which refuses while any claim is live, stayed refused.
    mgr.models = diskAcct.models?.length ? diskAcct.models : null;
    // Mirror onto the memConfig entry: the TUI save stencil rebuilds
    // diskConfig.accounts from config.accounts as `{ ...diskAcct, ...live }`,
    // so a stale key there would win the spread and silently overwrite this
    // disk edit on the next save — and the following reload would then revert
    // the running account too. Delete-on-absence keeps the saved JSON clean,
    // the same shape a hand edit produces.
    if (cfgAcct) {
      if (isCodex && diskAcct.name) cfgAcct.name = diskAcct.name;
      if (diskAcct.upstream) cfgAcct.upstream = diskAcct.upstream; else delete cfgAcct.upstream;
      if (diskAcct.modelMap) cfgAcct.modelMap = diskAcct.modelMap; else delete cfgAcct.modelMap;
      if (diskAcct.maxUsage != null) cfgAcct.maxUsage = diskAcct.maxUsage; else delete cfgAcct.maxUsage;
      if (diskAcct.models?.length) cfgAcct.models = diskAcct.models; else delete cfgAcct.models;
    }
    // Pick up enable/disable toggles; re-enabling clears a stuck error state.
    const wantDisabled = !!diskAcct.disabled;
    if (mgr.disabled !== wantDisabled) accountManager.setDisabled(mgr.index, wantDisabled);

    if (isCodex) {
      if (!resolved) continue;
      const sourceChanged = credentialFile(mgr) !== credentialFile(diskAcct);
      const identityChanged = mgr.accountId !== (resolved.accountId ?? null);
      const tuple = importedCodexTuple(resolved);
      const unchangedFile = tuple && mgr._importedCodexTuple
        && tuple.every((value, i) => value === mgr._importedCodexTuple[i]);
      const diskIsStaler = !sourceChanged && !identityChanged && resolved.expiresAt && mgr.expiresAt
        && resolved.expiresAt < mgr.expiresAt;
      if (diskIsStaler || (unchangedFile && !sourceChanged && !identityChanged)) continue;

      mgr.importFrom = credentialFile(diskAcct);
      mgr.source = diskAcct.source || null;
      mgr._importedCodexTuple = tuple;
      if (cfgAcct) {
        const source = mgr.importFrom ? diskAcct : resolved;
        for (const key of ['source', 'importFrom', 'accountId', 'accessToken', 'refreshToken', 'expiresAt']) {
          if (Object.hasOwn(source, key)) cfgAcct[key] = source[key];
          else delete cfgAcct[key];
        }
      }
      if (diskAcct.type === 'oauth' && (sourceChanged || identityChanged
          || mgr.credential !== resolved.accessToken || mgr.refreshToken !== (resolved.refreshToken ?? null)
          || mgr.expiresAt !== (resolved.expiresAt ?? null))) {
        accountManager.updateAccountTokens(mgr.index, resolved);
      } else if (diskAcct.type === 'apikey') {
        mgr.credential = resolved.apiKey;
      }
      continue;
    }

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (err) {
        console.error(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }

    if (!freshCred) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken;
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}
