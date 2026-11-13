import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env as testEnv, reset, runInDurableObject } from 'cloudflare:test';
import { applyReport, renderBoard, type BoardBindings, type BoardState, type ShipBoard } from '../src/board';
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

describe('renderBoard limits', () => {
	it('stays inside Discord embed limits with many or long-named products', () => {
		const state = Array.from({ length: 40 }, (_, i) =>
			report({ product: `${'p'.repeat(300)}-${String(i).padStart(2, '0')}`, outcome: 'failed' }),
		).reduce(applyReport, empty);
		const [embed] = renderBoard(state, new Date()).embeds;
		const fields = embed?.fields ?? [];
		const total = fields.reduce((n, f) => n + f.name.length + f.value.length, 0) + (embed?.title.length ?? 0) + (embed?.description.length ?? 0) + (embed?.footer.text.length ?? 0);
		expect(total).toBeLessThanOrEqual(6000);
		expect(fields.length).toBeLessThanOrEqual(25);
		expect(fields.every((f) => f.name.length <= 256 && f.value.length <= 1024)).toBe(true);
		expect(fields[fields.length - 1]?.value).toMatch(/more products not shown$/);
	});
});

// ---- Through the worker: first report posts the board, the next edits it.

const sign = async (body: string) => {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
	return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// The real board Durable Object from the test runtime (bound in wrangler.json), wiped before each test.
// cloudflare:test types its env from the empty generated interface, so the binding is typed here.
const SHIP_BOARD = (testEnv as unknown as Required<BoardBindings>).SHIP_BOARD;
const board = {
	namespace: SHIP_BOARD,
	seed: (state: BoardState) => runInDurableObject(SHIP_BOARD.getByName('board'), (_o: ShipBoard, ctx) => ctx.storage.put('ship-board', state)),
	saved: () => runInDurableObject(SHIP_BOARD.getByName('board'), (_o: ShipBoard, ctx) => ctx.storage.get<BoardState>('ship-board')),
};

beforeEach(async () => {
	await reset();
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'board-msg' }), { status: 200 }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

const send = async (env: Record<string, unknown>, payload: ShipReport) => {
	const body = JSON.stringify(payload);
	// The worker reads bindings off the same env object as its string vars.
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
		const env = { ...baseEnv, SHIP_BOARD: board.namespace };

		expect((await send(env, report())).status).toBe(200);
		expect(calls()).toEqual([
			{ url: 'https://discord.com/api/v10/channels/gi-github-id/messages', method: 'POST' },
			{ url: 'https://discord.com/api/v10/channels/board-id/messages', method: 'POST' },
		]);
		expect((await board.saved())?.messageId).toBe('board-msg');

		fetchMock.mockClear();
		await send(env, report({ outcome: 'failed' }));
		expect(calls()[1]).toEqual({ url: 'https://discord.com/api/v10/channels/board-id/messages/board-msg', method: 'PATCH' });
	});

	it('keeps every product and posts one message when reports arrive together', async () => {
		const env = { ...baseEnv, SHIP_BOARD: board.namespace };
		// Discord is slow, so the second report arrives while the first is still posting the board.
		fetchMock.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return new Response(JSON.stringify({ id: 'board-msg' }), { status: 200 });
		});

		await Promise.all([
			send(env, report()),
			send(env, report({ product: 'creatrgrid', repository: 'ideaSquared/creatrgrid', project: 'gaminginit' })),
		]);
		expect(Object.keys((await board.saved())?.entries ?? {}).sort()).toEqual(['creatrgrid/production', 'gaminginit-bot/production']);
		const boardCalls = calls().filter((c) => c.url.includes('/channels/board-id/'));
		expect(boardCalls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
	});

	it('posts a new board when the old message was deleted', async () => {
		await board.seed({ messageId: 'gone', entries: {} });
		fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
			init.method === 'PATCH'
				? new Response('Unknown Message', { status: 404 })
				: new Response(JSON.stringify({ id: 'fresh' }), { status: 200 }),
		);
		await send({ ...baseEnv, SHIP_BOARD: board.namespace }, report());
		expect(calls().map((c) => c.method)).toEqual(['POST', 'PATCH', 'POST']);
		expect((await board.saved())?.messageId).toBe('fresh');
	});

	it('keeps the new live commit when the Discord edit fails, and logs it', async () => {
		await board.seed({ messageId: 'board-msg', entries: {} });
		fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
			init.method === 'PATCH' ? new Response('bad', { status: 400 }) : new Response(JSON.stringify({ id: 'x' }), { status: 200 }),
		);
		expect((await send({ ...baseEnv, SHIP_BOARD: board.namespace }, report())).status).toBe(200);
		expect((await board.saved())?.entries['gaminginit-bot/production']?.live?.sha).toBe(NEW);
		expect((await board.saved())?.messageId).toBe('board-msg');
		expect(calls()[calls().length - 1]?.url).toBe('https://discord.com/api/v10/channels/logs-id/messages');
	});

	it('skips the board when it is not bound', async () => {
		await send(baseEnv, report());
		expect(calls()).toHaveLength(1);
	});
});
