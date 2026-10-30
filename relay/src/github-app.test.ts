import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appJwt, createIssue, installationToken, pkcs8Der, resetTokenCache } from './github-app';

// GitHub hands out an App's private key as PKCS#1 PEM.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CFG = { appId: '123456', privateKey, repo: 'mathulbrich/duel-lens' };

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

describe('appJwt', () => {
  it("signs an RS256 JWT with GitHub's PKCS#1 key, issued by the App, from a minute ago for 9 minutes", async () => {
    const jwt = await appJwt('123456', privateKey, 1_800_000_000);
    const [head, claims, sig] = jwt.split('.');
    expect(JSON.parse(fromB64url(head).toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(fromB64url(claims).toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: '123456' });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), publicKey, fromB64url(sig))).toBe(true);
  });

  it('takes a PKCS#8 key as it is, and refuses what is not a PEM key', () => {
    const { privateKey: pkcs8 } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(pkcs8Der(pkcs8)[0]).toBe(0x30);
    expect(() => pkcs8Der('ghp_notakey')).toThrow(/not a PEM private key/);
  });
});

describe('installationToken and createIssue', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  beforeEach(() => {
    resetTokenCache();
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/installation')) return Response.json({ id: 42 });
        if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
        if (url.endsWith('/issues')) return Response.json({ number: 7, html_url: 'https://github.com/mathulbrich/duel-lens/issues/7' }, { status: 201 });
        return new Response('nope', { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for a token cut down to Issues on the one repository, and reuses it while it lasts', async () => {
    await installationToken(CFG);
    await installationToken(CFG);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/mathulbrich/duel-lens/installation',
      'https://api.github.com/app/installations/42/access_tokens',
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ repositories: ['duel-lens'], permissions: { issues: 'write' } });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('opens the issue with the installation token, and says which call failed otherwise', async () => {
    expect(await createIssue(CFG, { title: 't', body: 'b', labels: ['card-report'] })).toEqual({ number: 7, url: 'https://github.com/mathulbrich/duel-lens/issues/7' });
    const post = calls.at(-1)!;
    expect(post.url).toBe('https://api.github.com/repos/mathulbrich/duel-lens/issues');
    expect((post.init?.headers as Record<string, string>).Authorization).toBe('Bearer ghs_installation');
    resetTokenCache();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(createIssue(CFG, { title: 't', body: 'b', labels: [] })).rejects.toThrow('GitHub installation: HTTP 404');
  });
});
