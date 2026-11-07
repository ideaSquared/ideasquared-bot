import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDomain } from '../src/domain';

const env = { DISCORD_BOT_TOKEN: 'bot-token', DISCORD_CHANNEL_DOMAIN_ALERTS: 'domain-id', DISCORD_CHANNEL_BOT_LOGS: 'logs-id' };

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

const rdap = (over: { status?: string[]; expiration?: string; ns?: string[] } = {}) => ({
	status: over.status ?? ['client transfer prohibited'],
	events: [
		{ eventAction: 'registration', eventDate: '2006-03-01T15:33:50Z' },
		{ eventAction: 'expiration', eventDate: over.expiration ?? '2027-03-01T15:33:50Z' },
	],
	nameservers: (over.ns ?? ['NS3.AFTERNIC.COM']).map((ldhName) => ({ ldhName })),
	entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'GoDaddy.com, LLC']]] }],
});

const afternic = (buyNow = 5_000_000_000) =>
	`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
		props: { pageProps: { profile: { isForSale: true, buyNow, minBid: 500_000_000, sellerUsername: 'seller' } } },
	})}</script></html>`;

let rdapRes: () => Response;
let listingRes: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

const posts = (channel: string) =>
	fetchMock.mock.calls.filter(([url]) => String(url).includes(`/channels/${channel}/`)).map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
	rdapRes = () => Response.json(rdap());
	listingRes = () => new Response(afternic());
	fetchMock = vi.fn(async (url: string) => {
		if (url.startsWith('https://rdap.')) return rdapRes();
		if (url.startsWith('https://www.afternic.com/')) return listingRes();
		return new Response('{}', { status: 200 });
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('domain watcher', () => {
	it('posts a baseline alert on first run and records history', async () => {
		const kv = fakeKv();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		const [msg] = posts('domain-id');
		const fields = Object.fromEntries(msg.embeds[0].fields.map((f: { name: string; value: string }) => [f.name, f.value]));
		expect(msg.embeds[0].title).toBe('IDEASQUARED DOMAIN ALERT');
		expect(fields.Status).toBe('Registered — listed for sale');
		expect(fields.Listing).toContain('$5,000');
		expect(JSON.parse(kv.store.get('history')!)).toHaveLength(1);
	});

	it('stays quiet when nothing changed', async () => {
		const kv = fakeKv();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		fetchMock.mockClear();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		expect(posts('domain-id')).toHaveLength(0);
	});

	it('alerts on price and expiry changes', async () => {
		const kv = fakeKv();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		listingRes = () => new Response(afternic(2_500_000_000));
		rdapRes = () => Response.json(rdap({ expiration: '2028-03-01T15:33:50Z' }));
		fetchMock.mockClear();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		const changes = posts('domain-id')[0].embeds[0].fields.find((f: { name: string }) => f.name === 'Changes').value;
		expect(changes).toContain('Buy now price: $5,000 → $2,500');
		expect(changes).toContain('Expiry: 2027-03-01T15:33:50Z → 2028-03-01T15:33:50Z');
		expect(JSON.parse(kv.store.get('history')!)).toHaveLength(2);
	});

	it('flags pending delete as urgent', async () => {
		const kv = fakeKv();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		rdapRes = () => Response.json(rdap({ status: ['pending delete'] }));
		fetchMock.mockClear();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		const embed = posts('domain-id')[0].embeds[0];
		expect(embed.color).toBe(0xe01e5a);
		expect(embed.fields.find((f: { name: string }) => f.name === 'Status').value).toBe('Registered — pending delete');
	});

	it('says register immediately when RDAP returns 404', async () => {
		const kv = fakeKv();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		rdapRes = () => new Response('', { status: 404 });
		fetchMock.mockClear();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		const fields = posts('domain-id')[0].embeds[0].fields;
		expect(fields.find((f: { name: string }) => f.name === 'Status').value).toBe('Available for registration');
		expect(fields.find((f: { name: string }) => f.name === 'Action').value).toBe('Register immediately');
	});

	it('warns bot-logs once when the listing fetch fails, keeping the last known listing', async () => {
		const kv = fakeKv();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		listingRes = () => new Response('blocked', { status: 403 });
		fetchMock.mockClear();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		await checkDomain(env, { DOMAIN_WATCH: kv });
		expect(posts('logs-id')).toHaveLength(1);
		expect(posts('domain-id')).toHaveLength(0);
		expect(JSON.parse(kv.store.get('snapshot')!).listing.buyNow).toBe(5000);

		// Recovery with a changed price is still detected against the last known listing
		listingRes = () => new Response(afternic(4_000_000_000));
		await checkDomain(env, { DOMAIN_WATCH: kv });
		expect(posts('domain-id')[0].embeds[0].fields.find((f: { name: string }) => f.name === 'Changes').value).toContain('$5,000 → $4,000');
	});

	it('announces the listing when it first succeeds after a failed baseline', async () => {
		const kv = fakeKv();
		listingRes = () => new Response('blocked', { status: 403 });
		await checkDomain(env, { DOMAIN_WATCH: kv });
		expect(JSON.parse(kv.store.get('snapshot')!).listing).toBeNull();

		listingRes = () => new Response(afternic());
		fetchMock.mockClear();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		const changes = posts('domain-id')[0].embeds[0].fields.find((f: { name: string }) => f.name === 'Changes').value;
		expect(changes).toBe('Listing: none → for sale, buy now $5,000, min bid $500, seller seller');
		expect(JSON.parse(kv.store.get('history')!)).toHaveLength(2);

		// Subsequent unchanged runs stay quiet
		fetchMock.mockClear();
		await checkDomain(env, { DOMAIN_WATCH: kv });
		expect(posts('domain-id')).toHaveLength(0);
	});

	it('reports RDAP errors to bot-logs without alerting or overwriting state', async () => {
		const kv = fakeKv();
		rdapRes = () => new Response('', { status: 503 });
		await checkDomain(env, { DOMAIN_WATCH: kv });
		expect(posts('logs-id')[0].content).toContain('RDAP 503');
		expect(posts('domain-id')).toHaveLength(0);
		expect(kv.store.has('snapshot')).toBe(false);
	});

	it('reports missing config to bot-logs', async () => {
		await checkDomain(env, {});
		expect(posts('logs-id')[0].content).toContain('misconfigured');
	});
});
