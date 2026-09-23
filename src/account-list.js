import { providerOf, DEFAULT_PROVIDER } from './provider.js';

/** @typedef {Record<string, any>} Account */
/** @typedef {Record<string, any>} AccountProfile */
/**
 * @typedef {object} AccountProfileDependencies
 * @property {(expiresAt: any) => boolean} isTokenExpiringSoon
 * @property {(refreshToken: any) => Promise<{ accessToken: any, refreshToken: any, expiresAt: any }>} refreshAccessToken
 * @property {(accounts: Account[]) => Promise<void>} persistRefreshed
 * @property {(accessToken: any) => Promise<AccountProfile>} fetchProfile
 */

/**
 * Whether an account may use Anthropic's OAuth metadata endpoints.
 *
 * @param {Account|null|undefined} account
 * @returns {boolean}
 */
export function usesAnthropicAccountMetadata(account) {
  const declaredProvider = account?.provider;
  const isDeclaredAnthropic = declaredProvider == null || declaredProvider === DEFAULT_PROVIDER;
  return account?.type === 'oauth'
    && isDeclaredAnthropic
    && providerOf(account) === DEFAULT_PROVIDER
    && !account.upstream;
}

/**
 * Refresh and load profiles only for first-party Anthropic OAuth accounts.
 *
 * @param {Account[]} accounts
 * @param {AccountProfileDependencies} dependencies
 * @returns {Promise<{ profiles: Array<AccountProfile|null>, refreshed: Account[] }>}
 */
export async function loadAccountProfiles(accounts, {
  isTokenExpiringSoon,
  refreshAccessToken,
  persistRefreshed,
  fetchProfile,
}) {
  /** @type {Account[]} */
  const refreshed = [];

  await Promise.all(accounts.map(async account => {
    if (!usesAnthropicAccountMetadata(account)) return;
    if (account.refreshToken && isTokenExpiringSoon(account.expiresAt)) {
      try {
        const tokens = await refreshAccessToken(account.refreshToken);
        account.accessToken = tokens.accessToken;
        account.refreshToken = tokens.refreshToken;
        account.expiresAt = tokens.expiresAt;
        refreshed.push(account);
      } catch {
        // The profile request below reports the current credential state.
      }
    }
  }));

  await persistRefreshed(refreshed);

  const profiles = await Promise.all(accounts.map(account =>
    usesAnthropicAccountMetadata(account) && account.accessToken
      ? fetchProfile(account.accessToken)
      : null
  ));

  return { profiles, refreshed };
}

/**
 * Format the public, credential-free summary for one configured account.
 *
 * @param {Account} account
 * @param {AccountProfile|null} profile
 * @param {number} index
 * @returns {string[]}
 */
export function formatAccountSummary(account, profile, index) {
  if (account.type === 'apikey') return [`  [${index + 1}] ${account.name} (apikey)`];

  const source = account.source ? `, ${account.source}` : '';
  if (account.provider === 'codex') {
    return [`  [${index + 1}] ${account.name} (Codex subscription${source})`];
  }
  if (!usesAnthropicAccountMetadata(account)) {
    return [`  [${index + 1}] ${account.name} (custom upstream OAuth${source})`];
  }

  const hasProfile = profile && !profile.error;
  const tier = hasProfile
    ? (profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : 'subscription')
    : null;
  const status = hasProfile ? `Claude ${tier}` : `unknown (${profile?.error || 'no token'})`;
  const lines = [`  [${index + 1}] ${account.name} (${status}${source})`];
  if (hasProfile && profile.email && profile.email !== account.name) lines.push(`       Email: ${profile.email}`);
  if (hasProfile && profile.orgName) lines.push(`       Org:   ${profile.orgName}`);
  return lines;
}
