// The routing table's shape, in one place.
//
// Routes arrive from three writers (the CLI, the TUI editor and a hand edit)
// and are read by selection, by status and — with an `override` — by the force
// control. A bad field on any of them used to be whatever the reader made of
// it, so the same table could mean one thing to selection and another to the
// page. Normalising once, at the door, is what lets every reader trust the
// object it is handed: `normalizeRoutes` is total, never throws, and says in
// `warnings` what it had to drop.

// The weekly buckets a route may meter against. Anything else is a typo: the
// three are what upstream reports and what the TUI's picker offers.
export const ROUTE_BUCKETS = ['unified7d', 'unified7dFable', 'unified7dSonnet'];

// What an override does once the forced account can no longer serve: hand the
// route back to the normal walk, or refuse every other account.
export const WHEN_SPENT = ['fallback', 'hold'];

/** Pin id for a configured route, by name. */
export function configuredPinId(name) { return `configured:${name}`; }

/** Pin id for an auto-detected family row (fable, sonnet). */
export function autoPinId(family) { return `auto:${family}`; }

/**
 * The pin id for a getRoutes() row or a stored route. Auto rows and configured
 * routes are separate namespaces: a configured route named `fable` with an
 * unrelated glob used to share one pin with the auto Fable row.
 */
export function pinId(route) {
  return route?.autocreated ? autoPinId(route.name) : configuredPinId(route?.name);
}

/** Split a pin id back into { kind, name }, or null when it is not one. */
export function parsePinId(id) {
  if (typeof id !== 'string') return null;
  const at = id.indexOf(':');
  if (at < 1) return null;
  const kind = id.slice(0, at);
  const name = id.slice(at + 1);
  if (!name || (kind !== 'configured' && kind !== 'auto')) return null;
  return { kind, name };
}

/**
 * The accounts a route may use: the ones its `accounts` list names (by name or
 * index string, the list's own convention), or all of them when it lists none.
 *
 * Membership only — no model lookup and no first-match resolution, so an
 * override can be validated against the route it is written on rather than
 * against whichever route a sample model happens to resolve to.
 */
export function routeMembers(route, accounts = []) {
  const list = Array.isArray(route?.accounts) ? route.accounts.map(String) : [];
  if (!list.length) return [...accounts];
  return accounts.filter(a => list.includes(a.name) || list.includes(String(a.index)));
}

/**
 * Normalize a configured routing table. Total: every rejection is a warning and
 * a dropped field (or, for a route with no glob at all, a dropped route), never
 * a throw. Unknown fields are carried through untouched — the table is the
 * operator's file, not ours.
 *
 * @returns {{ routes: object[], warnings: string[] }}
 */
export function normalizeRoutes(routes, accounts = []) {
  const warnings = [];
  const out = [];
  const seen = new Set();
  const list = Array.isArray(routes) ? routes : [];

  list.forEach((raw, i) => {
    const r = raw && typeof raw === 'object' ? raw : {};
    const name = typeof r.name === 'string' && r.name ? r.name : `route-${i + 1}`;
    const match = (Array.isArray(r.match) ? r.match : [r.match]).filter(g => typeof g === 'string' && g);
    if (!match.length) {
      warnings.push(`route "${name}" has no model glob — ignored`);
      return;
    }
    // Kept-first, and nothing is rewritten: a disk row still maps to its
    // normalised row by name, which is what the endpoint's precondition needs.
    if (seen.has(name)) {
      warnings.push(`duplicate route name "${name}" — keeping the first`);
      return;
    }
    seen.add(name);

    const route = {
      ...r,
      name,
      match,
      accounts: Array.isArray(r.accounts) ? r.accounts.map(String) : [],
      bucket: r.bucket || null,
      color: r.color || null,
    };
    // Kept, not dropped: a third-party backend can meter against a window
    // upstream names itself, and the router reads whatever key the route gives
    // it. The warning is for the far likelier case, a typo.
    if (typeof route.bucket === 'string' && !ROUTE_BUCKETS.includes(route.bucket)) {
      warnings.push(`route "${name}": bucket "${route.bucket}" is not one of ${ROUTE_BUCKETS.join(', ')}`);
    } else if (route.bucket != null && typeof route.bucket !== 'string') {
      warnings.push(`route "${name}": bucket is not a string — metering by model family instead`);
      route.bucket = null;
    }

    const problem = overrideProblem(r.override, route, accounts);
    if (problem) {
      warnings.push(`route "${name}": ${problem} — override ignored`);
      delete route.override;
    } else if (r.override) {
      route.override = {
        account: r.override.account,
        whenSpent: r.override.whenSpent,
        ...(Number.isFinite(r.override.since) && { since: r.override.since }),
      };
    }
    out.push(route);
  });

  return { routes: out, warnings };
}

/** Why this override cannot be honoured, or null when it can. Absent is fine. */
function overrideProblem(override, route, accounts) {
  if (override == null) return null;
  if (typeof override !== 'object') return 'override is not an object';
  const { account, whenSpent, since } = override;
  if (typeof account !== 'string' || !account) return 'override names no account';
  const target = accounts.find(a => a.name === account);
  if (!target) return `no account named "${account}"`;
  if (!routeMembers(route, accounts).some(a => a.name === account)) {
    return `"${account}" is not a member of this route`;
  }
  if (!WHEN_SPENT.includes(whenSpent)) return `whenSpent must be ${WHEN_SPENT.join(' or ')}`;
  if (since != null && !Number.isFinite(since)) return 'since is not a number';
  return null;
}
