import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const SECRET = 'ads-secret';

const env = {
	DISCORD_BOT_TOKEN: 'bot-token',
	GITHUB_WEBHOOK_SECRET_ADS: SECRET,
	GITHUB_WEBHOOK_SECRET_PAIRFLIX: 'pf-secret',
	DISCORD_CHANNEL_ADS_GITHUB: 'ads-github-id',
	DISCORD_CHANNEL_ADS_RELEASES: 'ads-releases-id',
	DISCORD_CHANNEL_ADS_PUBLIC: 'ads-public-id',
	DISCORD_CHANNEL_PAIRFLIX_GITHUB: 'pf-github-id',
	DISCORD_CHANNEL_BOT_LOGS: 'logs-id',
};

const sign = async (secret: string, body: string) => {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
	return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const send = async (path: string, event: string, payload: unknown, secret = SECRET, e: Record<string, string> = env) => {
	const body = JSON.stringify(payload);
	return worker.fetch(
		new Request(`http://example.com${path}`, {
			method: 'POST',
			body,
			headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': await sign(secret, body) },
		}),
		e
	);
};

const base = { repository: { name: 'repo' }, sender: { login: 'user' } };
const pr = { ...base, action: 'opened', pull_request: { number: 1, title: 'T', html_url: 'u', state: 'open' } };
const release = { ...base, action: 'published', release: { tag_name: 'v1', html_url: 'u' } };

let fetchMock: ReturnType<typeof vi.fn>;
const postedChannels = () => fetchMock.mock.calls.map(([url]) => String(url).split('/channels/')[1].split('/')[0]);

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('ideaSquared bot', () => {
	it('405 for non-POST', async () => {
		const res = await worker.fetch(new Request('http://example.com/ads', { method: 'GET' }), env);
		expect(res.status).toBe(405);
	});

	it('404 for unknown project', async () => {
		expect((await send('/nope', 'issues', pr)).status).toBe(404);
	});

	it('401 for bad signature, nothing posted', async () => {
		const res = await send('/ads', 'pull_request', pr, 'wrong-secret');
		expect(res.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("401 when signed with another project's secret", async () => {
		expect((await send('/ads', 'pull_request', pr, 'pf-secret')).status).toBe(401);
	});

	it('posts PRs to the private github channel only, as the bot', async () => {
		const res = await send('/ads', 'pull_request', pr);
		expect(res.status).toBe(200);
		expect(postedChannels()).toEqual(['ads-github-id']);
		const [, init] = fetchMock.mock.calls[0];
		expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bot bot-token' });
	});

	it('routes by project', async () => {
		await send('/pairflix', 'pull_request', pr, 'pf-secret');
		expect(postedChannels()).toEqual(['pf-github-id']);
	});

	it('posts published releases to releases + github, never public chat', async () => {
		await send('/ads', 'release', release);
		expect(postedChannels().sort()).toEqual(['ads-github-id', 'ads-releases-id']);
	});

	it('ignores non-published release actions', async () => {
		await send('/ads', 'release', { ...release, action: 'created' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('ignores disabled events', async () => {
		const res = await send('/ads', 'push', base);
		expect(res.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('accepts ping and announces in the github channel', async () => {
		const res = await send('/ads', 'ping', { zen: 'Keep it logically awesome.', hook_id: 1, ...base });
		expect(res.status).toBe(200);
		expect(postedChannels()).toEqual(['ads-github-id']);
	});

	it('accepts ping without a repository (org webhook)', async () => {
		expect((await send('/ads', 'ping', { zen: 'z', hook_id: 1 })).status).toBe(200);
		expect(postedChannels()).toEqual(['ads-github-id']);
	});

	it('401 for ping with bad signature', async () => {
		expect((await send('/ads', 'ping', { zen: 'z' }, 'wrong-secret')).status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('400 for invalid payload', async () => {
		expect((await send('/ads', 'issues', { invalid: 'data' })).status).toBe(400);
	});

	it('still succeeds if one channel fails, and reports to bot-logs', async () => {
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes('ads-releases-id') ? new Response('nope', { status: 403 }) : new Response('{}', { status: 200 })
		);
		const res = await send('/ads', 'release', release);
		expect(res.status).toBe(200);
		expect(postedChannels()).toContain('logs-id');
	});

	it('retries once after a 429, honouring retry_after', async () => {
		let calls = 0;
		fetchMock.mockImplementation(async () =>
			calls++ === 0 ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 }) : new Response('{}', { status: 200 })
		);
		const res = await send('/ads', 'pull_request', pr);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('delivers to configured channels and alerts bot-logs when one is missing', async () => {
		const { DISCORD_CHANNEL_ADS_RELEASES: _omit, ...partial } = env;
		const res = await send('/ads', 'release', release, SECRET, partial);
		expect(res.status).toBe(200);
		expect(postedChannels().sort()).toEqual(['ads-github-id', 'logs-id']);
	});

	it('502 when every channel fails', async () => {
		fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
		expect((await send('/ads', 'pull_request', pr)).status).toBe(502);
	});

	it('500 when the project has no channel configured', async () => {
		const { DISCORD_CHANNEL_ADS_GITHUB: _omit, ...partial } = env;
		expect((await send('/ads', 'pull_request', pr, SECRET, partial)).status).toBe(500);
	});
});
