import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyReport, renderBoard, type BoardState } from '../src/board';
import worker from '../src/index';
import type { ShipReport } from '../src/ship';

const SECRET = 'ship-secret';
const LIVE = 'ad6b1d3233c597721d44add45436f1cf14670121';
const NEW = '505da4508a889b459857e278f1d54d451b5bb522';

const report = (overrides: Partial<ShipReport> = {}): ShipReport => ({
	version: 1,
	project: 'gaminginit',
	product: 'gaminginit-bot',
	repository: 'ideaSquared/gaminginit-bot',
	environment: 'production',
	outcome: 'shipped',
	actor: 'octocat',
	at: '2026-11-13T20:03:30.000Z',
	sha: NEW,
	previousSha: LIVE,
	compareUrl: null,
	runUrl: 'https://github.com/ideaSquared/gaminginit-bot/actions/runs/1',
	totalCommits: 1,
	commits: [],
	components: [],
	failures: [],
	...overrides,
});

const empty: BoardState = { entries: {} };
const liveSha = (state: BoardState) => state.entries['gaminginit-bot/production']?.live?.sha;

describe('applyReport', () => {
	it('makes a shipped commit the live one', () => {
		expect(liveSha(applyReport(empty, report()))).toBe(NEW);
	});

	it('keeps what was live when a deploy fails or is blocked', () => {
		const shipped = applyReport(empty, report({ sha: LIVE }));
		expect(liveSha(applyReport(shipped, report({ outcome: 'failed' })))).toBe(LIVE);
		expect(liveSha(applyReport(shipped, report({ outcome: 'blocked' })))).toBe(LIVE);
		expect(applyReport(shipped, report({ outcome: 'failed' })).entries['gaminginit-bot/production']?.last.outcome).toBe('failed');
	});

	it('shows the previous commit as live after a rollback', () => {
		expect(liveSha(applyReport(empty, report({ outcome: 'rolled-back' })))).toBe(LIVE);
	});
});

describe('renderBoard', () => {
	it('lists each product with its environments and the last failed attempt', () => {
		const state = [
			report({ sha: LIVE }),
			report({ outcome: 'failed' }),
			report({ product: 'creatrgrid', repository: 'ideaSquared/creatrgrid', environment: 'staging' }),
		].reduce(applyReport, empty);
		const [embed] = renderBoard(state, new Date('2026-11-13T21:00:00Z')).embeds;
		expect(embed?.fields.map((f) => f.name)).toEqual(['creatrgrid', 'gaminginit-bot']);
		const bot = embed?.fields[1]?.value ?? '';
		expect(bot).toContain('🔴 **production** · [`ad6b1d3`]');
		expect(bot).toContain('last attempt [failed]');
		expect(bot).toContain('`505da45`');
	});
});

// ---- Through the worker: first report posts the board, the next edits it.

const sign = async (body: string) => {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
	return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const fakeKv = () => {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => {
			const value = store.get(key);
			return value === undefined ? null : JSON.parse(value);
		},
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
	};
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'board-msg' }), { status: 200 }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

const send = async (env: Record<string, unknown>, payload: ShipReport) => {
	const body = JSON.stringify(payload);
	// The worker reads KV bindings off the same env object as its string vars.
	const e = env as unknown as Record<string, string>;
	return worker.fetch(
		new Request('http://example.com/ship', { method: 'POST', body, headers: { 'X-Ship-Signature-256': await sign(body) } }),
		e,
	);
};

const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), method: (init as RequestInit).method }));

describe('POST /ship board', () => {
	const baseEnv = {
		DISCORD_BOT_TOKEN: 'bot-token',
		SHIP_NOTIFY_SECRET: SECRET,
		DISCORD_CHANNEL_GAMINGINIT_GITHUB: 'gi-github-id',
		DISCORD_CHANNEL_SHIP_STATUS: 'board-id',
		DISCORD_CHANNEL_BOT_LOGS: 'logs-id',
	};

	it('posts the board once, then edits the same message', async () => {
		const kv = fakeKv();
		const env = { ...baseEnv, BOT_STATE: kv };

		expect((await send(env, report())).status).toBe(200);
		expect(calls()).toEqual([
			{ url: 'https://discord.com/api/v10/channels/gi-github-id/messages', method: 'POST' },
			{ url: 'https://discord.com/api/v10/channels/board-id/messages', method: 'POST' },
		]);
		expect(JSON.parse(kv.store.get('ship-board') ?? '{}').messageId).toBe('board-msg');

		fetchMock.mockClear();
		await send(env, report({ outcome: 'failed' }));
		expect(calls()[1]).toEqual({ url: 'https://discord.com/api/v10/channels/board-id/messages/board-msg', method: 'PATCH' });
	});

	it('posts a new board when the old message was deleted', async () => {
		const kv = fakeKv();
		kv.store.set('ship-board', JSON.stringify({ messageId: 'gone', entries: {} }));
		fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
			init.method === 'PATCH'
				? new Response('Unknown Message', { status: 404 })
				: new Response(JSON.stringify({ id: 'fresh' }), { status: 200 }),
		);
		await send({ ...baseEnv, BOT_STATE: kv }, report());
		expect(calls().map((c) => c.method)).toEqual(['POST', 'PATCH', 'POST']);
		expect(JSON.parse(kv.store.get('ship-board') ?? '{}').messageId).toBe('fresh');
	});

	it('still answers 200 when the board fails, and logs it', async () => {
		const kv = {
			get: async () => {
				throw new Error('kv down');
			},
			put: async () => undefined,
		};
		const res = await send({ ...baseEnv, BOT_STATE: kv }, report());
		expect(res.status).toBe(200);
		expect(calls()[calls().length - 1]?.url).toBe('https://discord.com/api/v10/channels/logs-id/messages');
	});

	it('skips the board when no KV is bound', async () => {
		await send(baseEnv, report());
		expect(calls()).toHaveLength(1);
	});
});
