import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const SECRET = 'ship-secret';

const env = {
	DISCORD_BOT_TOKEN: 'bot-token',
	SHIP_NOTIFY_SECRET: SECRET,
	DISCORD_CHANNEL_GAMINGINIT_GITHUB: 'gi-github-id',
	DISCORD_CHANNEL_BOT_LOGS: 'logs-id',
};

const report = {
	version: 1,
	project: 'gaminginit',
	product: 'gaminginit-bot',
	repository: 'ideaSquared/gaminginit-bot',
	environment: 'production',
	outcome: 'shipped',
	actor: 'octocat',
	at: '2026-11-13T20:03:30.000Z',
	sha: '505da4508a889b459857e278f1d54d451b5bb522',
	previousSha: 'ad6b1d3233c597721d44add45436f1cf14670121',
	compareUrl: 'https://github.com/ideaSquared/gaminginit-bot/compare/ad6b1d3...505da45',
	runUrl: 'https://github.com/ideaSquared/gaminginit-bot/actions/runs/1',
	totalCommits: 2,
	commits: [
		{ sha: '505da45aaaa', message: 'ci: deploy through shipper (#197)', author: 'octocat', url: 'https://github.com/c/505' },
		{ sha: 'c3d95d3bbbb', message: 'chore: switch from npm to pnpm', author: 'hubot', url: 'https://github.com/c/c3d' },
	],
	components: [
		{
			name: 'bot',
			status: 'deployed',
			url: 'https://wardogs-discord-bot.idea-squared.workers.dev',
			detail: 'health check passed',
		},
	],
	failures: [],
};

const sign = async (secret: string, body: string) => {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
	return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const ship = async (payload: unknown, secret = SECRET, e: Record<string, string> = env) => {
	const body = JSON.stringify(payload);
	return worker.fetch(
		new Request('http://example.com/ship', { method: 'POST', body, headers: { 'X-Ship-Signature-256': await sign(secret, body) } }),
		e
	);
};

type Embed = {
	title: string;
	url: string;
	color: number;
	description: string;
	fields: { name: string; value: string }[];
	timestamp: string;
};

let fetchMock: ReturnType<typeof vi.fn>;
const posted = (): { channel: string; embed: Embed }[] =>
	fetchMock.mock.calls.map(([url, init]) => ({
		channel: String(url).split('/channels/')[1].split('/')[0],
		embed: JSON.parse(String((init as RequestInit).body)).embeds?.[0],
	}));

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('POST /ship', () => {
	it('posts who shipped what, when, and from which commit to which', async () => {
		const res = await ship(report);
		expect(res.status).toBe(200);
		const [{ channel, embed }] = posted();
		expect(channel).toBe('gi-github-id');
		expect(embed.title).toBe('🚀 gaminginit-bot shipped to production');
		expect(embed.url).toBe(report.runUrl);
		expect(embed.color).toBe(0x2eb67d);
		expect(embed.timestamp).toBe(report.at);
		expect(embed.description).toContain('Shipped by **octocat** · <t:1794600210:f>');
		expect(embed.description).toContain('`ad6b1d3`');
		expect(embed.description).toContain('→ [`505da45`]');
		expect(embed.description).toContain(`[2 commits](${report.compareUrl})`);
		expect(embed.description).toContain('ci: deploy through shipper (#197) · octocat');
		expect(embed.fields).toEqual([
			{ name: 'bot', value: '✅ Deployed\nhttps://wardogs-discord-bot.idea-squared.workers.dev\nhealth check passed', inline: false },
		]);
	});

	it('makes a rollback stand out with the reason', async () => {
		await ship({
			...report,
			outcome: 'rolled-back',
			components: [{ name: 'bot', status: 'rolled-back', detail: '/api/stats failed 10 times. Rolled back to the previous version.' }],
		});
		const [{ embed }] = posted();
		expect(embed.title).toBe('↩️ gaminginit-bot rolled back on production');
		expect(embed.color).toBe(0xecb22e);
		expect(embed.fields[0].value).toContain('/api/stats failed 10 times');
	});

	it('lists why a deploy was blocked', async () => {
		await ship({ ...report, outcome: 'blocked', previousSha: null, compareUrl: null, totalCommits: 0, commits: [], components: [], failures: ["check 'test' did not pass"] });
		const [{ embed }] = posted();
		expect(embed.title).toBe('⛔ gaminginit-bot blocked from production');
		expect(embed.description).toContain('Tried by **octocat**');
		expect(embed.description).toContain("• check 'test' did not pass");
	});

	it('says when it is the first ship and when commits were cut short', async () => {
		await ship({ ...report, previousSha: null, compareUrl: null });
		expect(posted()[0].embed.description).toContain('First ship to production');

		fetchMock.mockClear();
		await ship({ ...report, totalCommits: 14 });
		expect(posted()[0].embed.description).toContain('…and 12 more');
	});

	it('rejects a bad signature and posts nothing', async () => {
		expect((await ship(report, 'wrong')).status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a malformed report', async () => {
		const res = await ship({ ...report, outcome: 'exploded' });
		expect(res.status).toBe(400);
		expect(await res.text()).toBe('Invalid report: unknown outcome');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reports an unknown project to bot-logs', async () => {
		expect((await ship({ ...report, project: 'nope' })).status).toBe(404);
		expect(posted().map((p) => p.channel)).toEqual(['logs-id']);
	});

	it('fails clearly when the secret is not configured', async () => {
		const { SHIP_NOTIFY_SECRET, ...noSecret } = env;
		const res = await ship(report, SECRET, noSecret);
		expect(res.status).toBe(500);
		expect(await res.text()).toBe('Error: SHIP_NOTIFY_SECRET is not set');
	});

	it('keeps a huge report under Discord embed limits', async () => {
		const long = 'x'.repeat(5000);
		await ship({
			...report,
			product: long.slice(0, 300),
			totalCommits: 500,
			commits: Array.from({ length: 10 }, (_, i) => ({ sha: `sha${i}`, message: long, author: long.slice(0, 100), url: `https://github.com/c/${i}` })),
			components: Array.from({ length: 30 }, (_, i) => ({ name: `component-${i}-${long.slice(0, 200)}`, status: 'failed', detail: long })),
			failures: [long, long],
		});
		const [{ embed }] = posted();
		const author = (embed as unknown as { author: { name: string }; footer: { text: string } });
		const total =
			embed.title.length + embed.description.length + author.author.name.length + author.footer.text.length +
			embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
		expect(total).toBeLessThanOrEqual(6000);
		expect(embed.title.length).toBeLessThanOrEqual(256);
		expect(embed.description.length).toBeLessThanOrEqual(4096);
		expect(embed.fields.length).toBeLessThanOrEqual(25);
		embed.fields.forEach((f) => {
			expect(f.name.length).toBeLessThanOrEqual(256);
			expect(f.value.length).toBeLessThanOrEqual(1024);
		});
	});
});
