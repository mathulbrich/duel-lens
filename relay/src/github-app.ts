// The relay's GitHub identity: a GitHub App installed on the one repository, with Issues read and write and nothing
// else. Its private key (a Worker secret) signs a 10-minute JWT; GitHub trades that for an installation token
// (1 hour, cut down here to Issues on that repository alone), kept while it lasts. GitHub's API reference:
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app

const API = 'https://api.github.com';
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'duel-lens-reports' };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/**
 * A PEM private key as PKCS#8 DER, what WebCrypto imports. GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"),
 * which is wrapped here: SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption, NULL }, OCTET STRING { the PKCS#1 key } }.
 */
export function pkcs8Der(pem: string): Uint8Array<ArrayBuffer> {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----/.exec(pem);
  if (!m) throw new Error('GITHUB_APP_PRIVATE_KEY is not a PEM private key');
  const der = Uint8Array.from(atob(m[2].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  if (!m[1]) return der;
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(der.length), ...der];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  return Uint8Array.from([0x30, ...derLength(inner.length), ...inner]);
}

/** A JWT for the App (RS256), valid from a minute ago (clock drift) for 9 minutes. */
export async function appJwt(appId: string, privateKeyPem: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pkcs8Der(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(utf8(JSON.stringify({ iat: nowS - 60, exp: nowS + 540, iss: appId })));
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${head}.${claims}`)));
  return `${head}.${claims}.${b64url(signature)}`;
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  /** "owner/name". */
  repo: string;
}

let cached: { token: string; expiresAt: number; repo: string } | null = null;

/** Forgets the cached installation token (tests). */
export function resetTokenCache(): void {
  cached = null;
}

/** A GitHub API call that failed; `status` tells its limits (403, 429) from the rest. */
export class GitHubError extends Error {
  constructor(
    what: string,
    readonly status: number,
  ) {
    super(`GitHub ${what}: HTTP ${status}`);
  }
}

async function call<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new GitHubError(what, res.status);
  return (await res.json()) as T;
}

/** An installation token for Issues on the configured repository, reused until 5 minutes before it expires. */
export async function installationToken(cfg: GitHubAppConfig, now = Date.now()): Promise<string> {
  if (cached && cached.repo === cfg.repo && cached.expiresAt - 5 * 60_000 > now) return cached.token;
  const jwt = await appJwt(cfg.appId, cfg.privateKey, Math.floor(now / 1000));
  const auth = { ...HEADERS, Authorization: `Bearer ${jwt}` };
  const { id } = await call<{ id: number }>(`${API}/repos/${cfg.repo}/installation`, { headers: auth }, 'installation');
  const name = cfg.repo.split('/')[1];
  const { token, expires_at } = await call<{ token: string; expires_at: string }>(
    `${API}/app/installations/${id}/access_tokens`,
    { method: 'POST', headers: auth, body: JSON.stringify({ repositories: [name], permissions: { issues: 'write' } }) },
    'access token',
  );
  cached = { token, expiresAt: Date.parse(expires_at), repo: cfg.repo };
  return token;
}

/** Opens the issue; its number and web address. */
export async function createIssue(cfg: GitHubAppConfig, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
  const token = await installationToken(cfg);
  const created = await call<{ number: number; html_url: string }>(
    `${API}/repos/${cfg.repo}/issues`,
    { method: 'POST', headers: { ...HEADERS, Authorization: `Bearer ${token}` }, body: JSON.stringify(issue) },
    'issue',
  );
  return { number: created.number, url: created.html_url };
}
