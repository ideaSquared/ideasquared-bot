import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const SECRET = 'alert-secret';

const env = {
	DISCORD_BOT_TOKEN: 'bot-token',
	ALERT_SECRET: SECRET,
	DISCORD_CHANNEL_CREATRGRID_GITHUB: 'cg-github-id',
	DISCORD_CHANNEL_BOT_LOGS: 'logs-id',
};

const alert = {
	project: 'creatrgrid',
	severity: 'critical',
	title: 'Sync queue is failing',
	details: 'No account has synced for 3 hours',
	source: 'creatrgrid-api',
};

const sign = async (secret: string, body: string) => {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
	return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const send = async (payload: unknown, secret = SECRET, e: Record<string, string> = env) => {
	const body = JSON.stringify(payload);
	return worker.fetch(
		new Request('http://example.com/alert', { method: 'POST', body, headers: { 'X-Alert-Signature-256': await sign(secret, body) } }),
		e,
	);
};

type Message = {
	content: string;
	allowed_mentions: { parse: string[] };
	embeds: { title: string; color: number; description?: string; footer: { text: string } }[];
};

let fetchMock: ReturnType<typeof vi.fn>;
const posted = (): { channel: string; message: Message }[] =>
	fetchMock.mock.calls.map(([url, init]) => ({
		channel: String(url).split('/channels/')[1].split('/')[0],
		message: JSON.parse(String((init as RequestInit).body)),
	}));

beforeEach(() => {
	fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('POST /alert', () => {
	it('pings @everyone in the project github channel with a critical embed', async () => {
		const res = await send(alert);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		const [{ channel, message }] = posted();
		expect(channel).toBe('cg-github-id');
		expect(message.content).toBe('@everyone');
		expect(message.allowed_mentions).toEqual({ parse: ['everyone'] });
		expect(message.embeds[0].title).toBe('🚨 Sync queue is failing');
		expect(message.embeds[0].color).toBe(0xe01e5a);
		expect(message.embeds[0].description).toBe(alert.details);
		expect(message.embeds[0].footer.text).toBe('creatrgrid-api · CreatrGrid');
	});

	it('marks a warning amber and accepts an alert with only the required fields', async () => {
		const res = await send({ project: 'creatrgrid', severity: 'warning', title: 'Slow syncs', extra: 'ignored' });
		expect(res.status).toBe(200);
		const [{ message }] = posted();
		expect(message.embeds[0].title).toBe('⚠️ Slow syncs');
		expect(message.embeds[0].color).toBe(0xecb22e);
		expect(message.embeds[0].footer.text).toBe('CreatrGrid');
	});

	it('rejects a bad signature', async () => {
		const res = await send(alert, 'wrong-secret');
		expect(res.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a missing signature', async () => {
		const res = await worker.fetch(new Request('http://example.com/alert', { method: 'POST', body: JSON.stringify(alert) }), env);
		expect(res.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects an unknown project', async () => {
		const res = await send({ ...alert, project: 'nope' });
		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		['an unknown severity', { ...alert, severity: 'info' }],
		['an empty title', { ...alert, title: '' }],
		['a title over 200 characters', { ...alert, title: 'x'.repeat(201) }],
		['details over 1500 characters', { ...alert, details: 'x'.repeat(1501) }],
		['a source over 100 characters', { ...alert, source: 'x'.repeat(101) }],
		['a missing project', { severity: 'critical', title: 'T' }],
	])('rejects %s', async (_, payload) => {
		const res = await send(payload);
		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a body that is not JSON', async () => {
		const body = 'not json';
		const res = await worker.fetch(
			new Request('http://example.com/alert', { method: 'POST', body, headers: { 'X-Alert-Signature-256': await sign(SECRET, body) } }),
			env,
		);
		expect(res.status).toBe(400);
	});

	it('answers 503 when ALERT_SECRET is not configured', async () => {
		const { ALERT_SECRET: _omitted, ...withoutSecret } = env;
		const res = await send(alert, SECRET, withoutSecret);
		expect(res.status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('answers 502 and reports to #bot-logs when Discord fails', async () => {
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes('/channels/cg-github-id/') ? new Response('boom', { status: 500 }) : new Response('{}', { status: 200 }),
		);
		const res = await send(alert);
		expect(res.status).toBe(502);
		const [, logPost] = posted();
		expect(logPost.channel).toBe('logs-id');
	});

	it("keeps Discord's response body out of the console log and #bot-logs, giving only the status", async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		fetchMock.mockImplementation(async (url: string) =>
			String(url).includes('/channels/cg-github-id/') ? new Response('secret-body', { status: 500 }) : new Response('{}', { status: 200 }),
		);
		await send(alert);
		const lines = spy.mock.calls.map(([line]) => JSON.parse(String(line)));
		spy.mockRestore();
		const failed = lines.filter((line) => line.meta?.event === 'alert-delivery-failed');
		expect(failed).toHaveLength(1);
		expect(failed[0].error).toBeUndefined();
		expect(JSON.stringify(lines)).not.toContain('secret-body');
		const [, logPost] = posted();
		expect(JSON.stringify(logPost)).toContain('HTTP 500');
		expect(JSON.stringify(logPost)).not.toContain('secret-body');
	});
});
