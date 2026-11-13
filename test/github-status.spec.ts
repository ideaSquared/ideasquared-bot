import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkGitHubStatus, type Incident } from '../src/github-status';

const env = { DISCORD_BOT_TOKEN: 'bot-token', DISCORD_CHANNEL_GITHUB_STATUS: 'status-id', DISCORD_CHANNEL_BOT_LOGS: 'logs-id' };

const fakeKv = () => {
	const store = new Map<string, string>();
	return {
		store,
		get: async (k: string, type?: string) => {
			const v = store.get(k);
			return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
		},
		put: async (k: string, v: string) => void store.set(k, v),
	} as unknown as KVNamespace & { store: Map<string, string> };
};

const incident = (id: string, updates: { id: string; status: string }[], resolved = false): Incident => ({
	id,
	name: `Incident ${id}`,
	status: updates[0]?.status ?? 'investigating',
	impact: 'major',
	shortlink: `https://stspg.io/${id}`,
	resolved_at: resolved ? '2026-11-13T21:00:00Z' : null,
	incident_updates: updates.map((u) => ({
		...u,
		body: `Update ${u.id}<br />We are on it &amp; investigating.`,
		created_at: '2026-11-13T20:00:00Z',
		affected_components: [{ name: 'Actions', new_status: 'degraded_performance' }],
	})),
});

let feed: Incident[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	feed = [];
	fetchMock = vi.fn(async (url: string) =>
		url.includes('githubstatus.com') ? Response.json({ incidents: feed }) : new Response(JSON.stringify({ id: 'm' }), { status: 200 })
	);
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

type Embed = { title: string; description: string; color: number; fields: { name: string; value: string }[] };
const posts = () =>
	fetchMock.mock.calls
		.filter(([url]) => String(url).includes('discord.com'))
		.map(([url, init]) => ({ url: String(url), embed: (JSON.parse(String((init as RequestInit).body)) as { embeds?: Embed[] }).embeds?.[0], body: String((init as RequestInit).body) }));

describe('checkGitHubStatus', () => {
	it('on the first run posts only incidents still open', async () => {
		const kv = fakeKv();
		feed = [incident('open', [{ id: 'u1', status: 'investigating' }]), incident('old', [{ id: 'u0', status: 'resolved' }], true)];
		await checkGitHubStatus(env, { BOT_STATE: kv });
		expect(posts().map((p) => p.embed?.title)).toEqual(['🔍 GitHub: Incident open']);
		const embed = posts()[0]?.embed;
		expect(embed?.description).toBe('Update u1\nWe are on it & investigating.');
		expect(embed?.fields).toContainEqual({ name: 'Affected', value: 'Actions' });
		expect(posts()[0]?.url).toBe('https://discord.com/api/v10/channels/status-id/messages');
	});

	it('posts each new update once, and new incidents', async () => {
		const kv = fakeKv();
		feed = [incident('a', [{ id: 'u1', status: 'investigating' }])];
		await checkGitHubStatus(env, { BOT_STATE: kv });

		fetchMock.mockClear();
		await checkGitHubStatus(env, { BOT_STATE: kv });
		expect(posts()).toHaveLength(0);

		feed = [incident('b', [{ id: 'v1', status: 'investigating' }]), incident('a', [{ id: 'u2', status: 'resolved' }, { id: 'u1', status: 'investigating' }], true)];
		fetchMock.mockClear();
		await checkGitHubStatus(env, { BOT_STATE: kv });
		// Oldest incident first.
		expect(posts().map((p) => p.embed?.title)).toEqual(['✅ GitHub: Incident a', '🔍 GitHub: Incident b']);
		expect(posts()[0]?.embed?.color).toBe(0x2eb67d);
	});

	it('logs to #bot-logs when the status page cannot be read, and keeps state', async () => {
		const kv = fakeKv();
		kv.store.set('github-status', JSON.stringify({ seen: { a: 'u1' } }));
		fetchMock.mockImplementation(async (url: string) =>
			url.includes('githubstatus.com') ? new Response('down', { status: 503 }) : new Response('{}', { status: 200 })
		);
		await checkGitHubStatus(env, { BOT_STATE: kv });
		expect(posts().map((p) => p.url)).toEqual(['https://discord.com/api/v10/channels/logs-id/messages']);
		expect(posts()[0]?.body).toContain('githubstatus.com answered 503');
		expect(kv.store.get('github-status')).toBe(JSON.stringify({ seen: { a: 'u1' } }));
	});
});
