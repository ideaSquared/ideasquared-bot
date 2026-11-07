// Domain watcher: runs on the cron trigger, compares the domain's RDAP record and aftermarket
// listing against the last snapshot in KV, and alerts Discord when anything changes.
import { DOMAIN_ALERTS_ENV_VAR, Env, WATCHED_DOMAIN } from './config';
import { logToBotLogs, postToChannel } from './discord';

export type DomainBindings = { DOMAIN_WATCH?: KVNamespace };

export interface Listing {
	isForSale: boolean;
	buyNow: number | null; // USD
	minBid: number | null; // USD
	seller: string | null;
}

export interface Snapshot {
	registered: boolean;
	statuses: string[];
	registrar: string | null;
	registeredAt: string | null;
	expiresAt: string | null;
	nameservers: string[];
	/** Last known aftermarket listing */
	listing: Listing | null;
	/** True while the listing fetch is failing, so the warning is sent once, not every run */
	listingFailing?: boolean;
}

export interface HistoryEntry {
	at: string;
	changes: string[];
}

const SNAPSHOT_KEY = 'snapshot';
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 500;
const USER_AGENT = 'ideaSquared-domain-watcher/1.0 (+https://github.com/ideaSquared/ideasquared-bot)';

// Statuses meaning the domain is about to drop and could soon be registered.
const DROP_STATUSES = ['redemption period', 'pending delete'];

const rdapUrl = (domain: string) => `https://rdap.verisign.com/com/v1/domain/${domain}`;
const listingUrl = (domain: string) => `https://www.afternic.com/domain/${domain}`;

interface RdapResponse {
	status?: string[];
	events?: { eventAction: string; eventDate: string }[];
	nameservers?: { ldhName: string }[];
	entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[];
}

export const fetchRdap = async (domain: string): Promise<Omit<Snapshot, 'listing'>> => {
	const res = await fetch(rdapUrl(domain), { headers: { Accept: 'application/rdap+json', 'User-Agent': USER_AGENT } });
	if (res.status === 404) {
		return { registered: false, statuses: [], registrar: null, registeredAt: null, expiresAt: null, nameservers: [] };
	}
	if (!res.ok) throw new Error(`RDAP ${res.status} for ${domain}`);
	const data = (await res.json()) as RdapResponse;
	const event = (action: string) => data.events?.find((e) => e.eventAction === action)?.eventDate ?? null;
	const registrar = data.entities?.find((e) => e.roles?.includes('registrar'));
	const fn = registrar?.vcardArray?.[1].find(([name]) => name === 'fn')?.[3] ?? null;
	return {
		registered: true,
		statuses: [...(data.status ?? [])].map((s) => s.toLowerCase()).sort(),
		registrar: fn,
		registeredAt: event('registration'),
		expiresAt: event('expiration'),
		nameservers: (data.nameservers ?? []).map((n) => n.ldhName.toLowerCase()).sort(),
	};
};

// Afternic (GoDaddy's aftermarket) embeds the listing in its Next.js page data; prices are in micro-dollars.
export const fetchListing = async (domain: string): Promise<Listing> => {
	const res = await fetch(listingUrl(domain), { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok) throw new Error(`Afternic ${res.status} for ${domain}`);
	const html = await res.text();
	const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
	if (!match) throw new Error('Afternic page has no __NEXT_DATA__');
	const profile = JSON.parse(match[1])?.props?.pageProps?.profile;
	if (!profile) return { isForSale: false, buyNow: null, minBid: null, seller: null };
	const usd = (micros: unknown) => (typeof micros === 'number' && micros > 0 ? micros / 1_000_000 : null);
	return {
		isForSale: profile.isForSale === true,
		buyNow: usd(profile.buyNow),
		minBid: usd(profile.minBid),
		seller: profile.sellerUsername ?? null,
	};
};

const money = (n: number | null) => (n === null ? 'none' : `$${n.toLocaleString('en-US')}`);
const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');

export const diffSnapshots = (prev: Snapshot, next: Snapshot): string[] => {
	const changes: string[] = [];
	const cmp = (label: string, a: string, b: string) => a !== b && changes.push(`${label}: ${a} → ${b}`);
	cmp('Registered', String(prev.registered), String(next.registered));
	cmp('Status', list(prev.statuses), list(next.statuses));
	cmp('Registrar', prev.registrar ?? 'none', next.registrar ?? 'none');
	cmp('Registration date', prev.registeredAt ?? 'none', next.registeredAt ?? 'none');
	cmp('Expiry', prev.expiresAt ?? 'none', next.expiresAt ?? 'none');
	cmp('Nameservers', list(prev.nameservers), list(next.nameservers));
	// First successful listing fetch (e.g. after the baseline run failed) is itself a change
	if (!prev.listing && next.listing) {
		const l = next.listing;
		changes.push(`Listing: none → ${l.isForSale ? 'for sale' : 'not for sale'}, buy now ${money(l.buyNow)}, min bid ${money(l.minBid)}, seller ${l.seller ?? 'none'}`);
	} else if (prev.listing && next.listing) {
		cmp('For sale', String(prev.listing.isForSale), String(next.listing.isForSale));
		cmp('Buy now price', money(prev.listing.buyNow), money(next.listing.buyNow));
		cmp('Minimum bid', money(prev.listing.minBid), money(next.listing.minBid));
		cmp('Seller', prev.listing.seller ?? 'none', next.listing.seller ?? 'none');
	}
	return changes;
};

const assess = (s: Snapshot): { status: string; action: string; urgent: boolean } => {
	if (!s.registered) return { status: 'Available for registration', action: 'Register immediately', urgent: true };
	const dropping = s.statuses.find((st) => DROP_STATUSES.includes(st));
	if (dropping) return { status: `Registered — ${dropping}`, action: 'Prepare to register when it drops', urgent: true };
	if (s.listing?.isForSale) return { status: 'Registered — listed for sale', action: 'Review price', urgent: false };
	return { status: 'Registered', action: 'None', urgent: false };
};

const buildAlert = (domain: string, s: Snapshot, changes: string[]) => {
	const { status, action, urgent } = assess(s);
	const fields = [
		{ name: 'Domain', value: domain, inline: true },
		{ name: 'Status', value: status, inline: true },
		{ name: 'Action', value: action, inline: true },
		{ name: 'Changes', value: changes.join('\n').slice(0, 1024) },
	];
	if (s.registered) {
		fields.push({ name: 'Expiry', value: s.expiresAt ?? 'unknown', inline: true }, { name: 'Registrar', value: s.registrar ?? 'unknown', inline: true });
	}
	if (s.listing?.isForSale) {
		fields.push({ name: 'Listing', value: `[Buy now ${money(s.listing.buyNow)} · min bid ${money(s.listing.minBid)}](${listingUrl(domain)})`, inline: false });
	}
	return {
		embeds: [
			{
				title: 'IDEASQUARED DOMAIN ALERT',
				color: urgent ? 0xe01e5a : 0xecb22e,
				fields,
				timestamp: new Date().toISOString(),
				footer: { text: 'ideaSquared Domain Watcher' },
			},
		],
	};
};

export const checkDomain = async (env: Env, bindings: DomainBindings): Promise<void> => {
	const kv = bindings.DOMAIN_WATCH;
	const token = env.DISCORD_BOT_TOKEN;
	const channelId = env[DOMAIN_ALERTS_ENV_VAR];
	if (!kv || !token || !channelId) {
		await logToBotLogs(env, `Domain watcher misconfigured: need DOMAIN_WATCH KV, DISCORD_BOT_TOKEN and ${DOMAIN_ALERTS_ENV_VAR}`);
		return;
	}

	try {
		const prev = await kv.get<Snapshot>(SNAPSHOT_KEY, 'json');
		const rdap = await fetchRdap(WATCHED_DOMAIN);

		// Listing is best effort: if it fails, keep the last known listing and only report the transition to failing.
		let listing = prev?.listing ?? null;
		let listingFailing = false;
		try {
			listing = await fetchListing(WATCHED_DOMAIN);
		} catch (e) {
			listingFailing = true;
			if (!prev?.listingFailing) {
				await logToBotLogs(env, `Domain watcher: listing check failed — ${e instanceof Error ? e.message : e}`);
			}
		}

		const next: Snapshot = { ...rdap, listing, listingFailing };
		const changes = prev ? diffSnapshots(prev, next) : ['Watching started'];

		if (changes.length > 0) {
			await postToChannel(token, channelId, buildAlert(WATCHED_DOMAIN, next, changes));
			const history = (await kv.get<HistoryEntry[]>(HISTORY_KEY, 'json')) ?? [];
			history.push({ at: new Date().toISOString(), changes });
			await kv.put(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT)));
		}
		await kv.put(SNAPSHOT_KEY, JSON.stringify(next));
	} catch (e) {
		await logToBotLogs(env, `Domain watcher error: ${e instanceof Error ? e.message : e}`);
	}
};
