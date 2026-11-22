import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const SECRET = 'alert-secret';

const env = {
	DISCORD_BOT_TOKEN: 'bot-token',
	ALERT_SECRET: SECRET,
	DISCORD_CHANNEL_ADS_GITHUB: 'ads-github-id',
	DISCORD_CHANNEL_BOT_LOGS: 'logs-id',
};

const firing = {
	version: '4',
	status: 'firing',
	receiver: 'bot',
	groupLabels: { alertname: 'ServiceDown' },
	commonLabels: { alertname: 'ServiceDown', severity: 'critical', job: 'service-pets' },
	commonAnnotations: {},
	externalURL: 'http://alertmanager:9093',
	alerts: [
		{
			status: 'firing',
			labels: { alertname: 'ServiceDown', severity: 'critical', job: 'service-pets' },
			annotations: { summary: 'service-pets is down', description: 'No scrape for 2 minutes', runbook: 'docs/runbooks/service-down.md' },
			startsAt: '2026-11-14T23:00:00Z',
		},
	],
};

const send = (payload: unknown, auth: string | null = `Bearer ${SECRET}`, project = 'ads', e: Record<string, string> = env) =>
	worker.fetch(
		new Request(`http://example.com/alert/alertmanager/${project}`, {
			method: 'POST',
			body: JSON.stringify(payload),
			headers: auth ? { Authorization: auth } : {},
		}),
		e,
	);

type Message = {
	content?: string;
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

describe('POST /alert/alertmanager/:project', () => {
	it('posts a firing alert to the project github channel with @everyone', async () => {
		const res = await send(firing);
		expect(res.status).toBe(200);
		const [{ channel, message }] = posted();
		expect(channel).toBe('ads-github-id');
		expect(message.content).toBe('@everyone');
		expect(message.allowed_mentions).toEqual({ parse: ['everyone'] });
		expect(message.embeds[0].title).toBe('🚨 Firing: ServiceDown');
		expect(message.embeds[0].description).toBe('service-pets is down\nNo scrape for 2 minutes\nRunbook: docs/runbooks/service-down.md');
		expect(message.embeds[0].footer.text).toBe('Alertmanager · AdoptDontShop');
	});

	it('treats a non-critical severity as a warning', async () => {
		await send({ ...firing, commonLabels: { alertname: 'HighLatency', severity: 'warning' } });
		expect(posted()[0].message.embeds[0].title).toBe('⚠️ Firing: HighLatency');
	});

	it('posts a resolved alert without pinging anyone', async () => {
		await send({ ...firing, status: 'resolved', alerts: [{ ...firing.alerts[0], status: 'resolved' }] });
		const [{ message }] = posted();
		expect(message.content).toBeUndefined();
		expect(message.allowed_mentions).toEqual({ parse: [] });
		expect(message.embeds[0].title).toBe('✅ Resolved: ServiceDown');
	});

	it('rejects a missing or wrong token', async () => {
		expect((await send(firing, null)).status).toBe(401);
		expect((await send(firing, 'Bearer wrong')).status).toBe(401);
		expect((await send(firing, SECRET)).status).toBe(401);
		expect(posted()).toEqual([]);
	});

	it('rejects an unknown project and a payload that is not from Alertmanager', async () => {
		expect((await send(firing, `Bearer ${SECRET}`, 'nope')).status).toBe(400);
		expect((await send({ hello: 'world' })).status).toBe(400);
		expect(posted()).toEqual([]);
	});

	it('fails clearly when ALERT_SECRET is not set', async () => {
		const { ALERT_SECRET, ...noSecret } = env;
		expect((await send(firing, `Bearer ${SECRET}`, 'ads', noSecret)).status).toBe(503);
	});

	it('reports a Discord failure by status only', async () => {
		fetchMock.mockImplementationOnce(async () => new Response('{"message":"echo"}', { status: 403 }));
		const res = await send(firing);
		expect(res.status).toBe(502);
		const logPost = posted().find((p) => p.channel === 'logs-id');
		expect(JSON.stringify(logPost)).not.toContain('service-pets is down');
	});
});
