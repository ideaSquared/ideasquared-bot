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

	describe('deployments', () => {
		const deploy = (state: string) => ({
			...base,
			action: 'created',
			deployment: { sha: 'abcdef1234', environment: 'production' },
			deployment_status: { state, environment: 'production', log_url: 'https://logs' },
		});
		const build = (action: string, slug: string, conclusion: string | null = 'success') => ({
			...base,
			action,
			check_run: { name: 'Workers Builds: site', head_sha: 'abcdef1234', conclusion, details_url: 'https://dash', app: { slug } },
		});
		const embed = () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).embeds[0];

		it('posts finished deployment_status to the github channel, green on success', async () => {
			expect((await send('/ads', 'deployment_status', deploy('success'))).status).toBe(200);
			expect(postedChannels()).toEqual(['ads-github-id']);
			expect(embed().color).toBe(0x2eb67d);
		});

		it('posts failed deployments in red', async () => {
			await send('/ads', 'deployment_status', deploy('failure'));
			expect(embed().color).toBe(0xe01e5a);
		});

		describe('described statuses (e.g. adopt-dont-shop deploy.yml after an auto-rollback)', () => {
			const described = (id: number, state: string, description?: string) => ({
				...base,
				action: 'created',
				deployment: { id, sha: 'abcdef1234', environment: 'staging' },
				deployment_status: { state, environment: 'staging', log_url: 'https://logs', ...(description ? { description } : {}) },
			});
			const fakeKv = () => {
				const store = new Map<string, string>();
				return {
					get: async (key: string) => store.get(key) ?? null,
					put: async (key: string, value: string) => {
						store.set(key, value);
					},
				};
			};
			const withKv = () => ({ ...env, DEPLOY_STATUS: fakeKv() }) as unknown as Record<string, string>;

			it('shows the description as the result', async () => {
				await send('/ads', 'deployment_status', described(7, 'failure', 'Health check failed; rolled back to f0e1d2c, which is healthy.'));
				expect(embed().fields).toContainEqual({ name: 'Result', value: 'Health check failed; rolled back to f0e1d2c, which is healthy.' });
			});

			it("skips GitHub's own undescribed status once the deployment was reported with a description", async () => {
				const e = withKv();
				await send('/ads', 'deployment_status', described(7, 'failure', 'Health check failed; rolled back to f0e1d2c, which is healthy.'), SECRET, e);
				const res = await send('/ads', 'deployment_status', described(7, 'failure'), SECRET, e);
				expect(res.status).toBe(200);
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});

			it('still posts an undescribed status when nothing was reported for that deployment', async () => {
				const e = withKv();
				await send('/ads', 'deployment_status', described(7, 'success', 'Deployed abcdef1; health checks passed.'), SECRET, e);
				await send('/ads', 'deployment_status', described(8, 'failure'), SECRET, e);
				expect(fetchMock).toHaveBeenCalledTimes(2);
			});

			it('posts both when the DEPLOY_STATUS KV binding is missing', async () => {
				await send('/ads', 'deployment_status', described(7, 'failure', 'Deploy failed before the health check. See the logs.'));
				await send('/ads', 'deployment_status', described(7, 'failure'));
				expect(fetchMock).toHaveBeenCalledTimes(2);
			});
		});

		it('ignores in-progress deployment states', async () => {
			for (const state of ['pending', 'queued', 'in_progress']) await send('/ads', 'deployment_status', deploy(state));
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('posts completed Cloudflare Workers Builds check runs', async () => {
			await send('/ads', 'check_run', build('completed', 'cloudflare-workers-and-pages', 'failure'));
			expect(postedChannels()).toEqual(['ads-github-id']);
			expect(embed().color).toBe(0xe01e5a);
		});

		it('ignores other check runs and unfinished builds', async () => {
			await send('/ads', 'check_run', build('completed', 'github-actions'));
			await send('/ads', 'check_run', build('created', 'cloudflare-workers-and-pages', null));
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	it('500 when the project has no channel configured', async () => {
		const { DISCORD_CHANNEL_ADS_GITHUB: _omit, ...partial } = env;
		expect((await send('/ads', 'pull_request', pr, SECRET, partial)).status).toBe(500);
	});
});
