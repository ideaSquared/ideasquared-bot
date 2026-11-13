// GitHub status watcher: polls githubstatus.com on the cron trigger and posts each new incident
// update to the GitHub status channel, so we know when Actions or the API is the problem.
import { Env, GITHUB_STATUS_ENV_VAR } from './config';
import { logToBotLogs, postToChannel } from './discord';

export type StatusBindings = { BOT_STATE?: KVNamespace };

const INCIDENTS_URL = 'https://www.githubstatus.com/api/v2/incidents.json';
const STATE_KEY = 'github-status';
const USER_AGENT = 'ideaSquared-bot/1.0 (+https://github.com/ideaSquared/ideasquared-bot)';

export type IncidentUpdate = {
	id: string;
	status: string;
	body: string;
	created_at: string;
	affected_components?: { name: string; new_status: string }[] | null;
};

export type Incident = {
	id: string;
	name: string;
	status: string;
	impact: string;
	shortlink: string;
	resolved_at: string | null;
	// Newest first, as the status page sends them.
	incident_updates: IncidentUpdate[];
};

// The newest update id seen for each incident still in the feed.
export type StatusState = { seen: Record<string, string> };

const STATUS_ICONS: Record<string, string> = {
	investigating: '🔍',
	identified: '🧭',
	monitoring: '👀',
	resolved: '✅',
	postmortem: '📝',
};
const IMPACT_COLOURS: Record<string, number> = { critical: 0xe01e5a, major: 0xf2711c, minor: 0xecb22e, none: 0x95a5a6 };
const RESOLVED_COLOUR = 0x2eb67d;

const plainText = (html: string) =>
	html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.trim();

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const createStatusEmbed = (incident: Incident, update: IncidentUpdate) => {
	const resolved = update.status === 'resolved' || update.status === 'postmortem';
	const components = [...new Set((update.affected_components ?? []).map((c) => c.name))];
	return {
		embeds: [
			{
				title: clip(`${STATUS_ICONS[update.status] ?? '⚠️'} GitHub: ${incident.name}`, 256),
				url: incident.shortlink,
				color: resolved ? RESOLVED_COLOUR : (IMPACT_COLOURS[incident.impact] ?? IMPACT_COLOURS.none),
				description: clip(plainText(update.body), 2000),
				fields: [
					{ name: 'Status', value: update.status, inline: true },
					{ name: 'Impact', value: incident.impact, inline: true },
					...(components.length > 0 ? [{ name: 'Affected', value: clip(components.join(', '), 1024) }] : []),
				],
				footer: { text: 'githubstatus.com' },
				timestamp: update.created_at,
			},
		],
	};
};

// Which incidents need a message: any whose newest update we have not posted. On the first run
// (no state) only incidents still open are posted, so old, resolved ones are not replayed.
export const newUpdates = (incidents: readonly Incident[], state: StatusState | null) =>
	incidents.flatMap((incident) => {
		const [latest] = incident.incident_updates;
		if (!latest) return [];
		if (state === null) return incident.resolved_at === null ? [{ incident, update: latest }] : [];
		return state.seen[incident.id] === latest.id ? [] : [{ incident, update: latest }];
	});

export const nextState = (incidents: readonly Incident[]): StatusState => ({
	seen: Object.fromEntries(
		incidents.flatMap((i) => (i.incident_updates[0] ? [[i.id, i.incident_updates[0].id] as const] : []))
	),
});

export const checkGitHubStatus = async (env: Env, bindings: StatusBindings): Promise<void> => {
	const kv = bindings.BOT_STATE;
	const token = env.DISCORD_BOT_TOKEN;
	const channelId = env[GITHUB_STATUS_ENV_VAR];
	if (!kv || !token || !channelId) return;

	try {
		const res = await fetch(INCIDENTS_URL, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
		if (!res.ok) throw new Error(`githubstatus.com answered ${res.status}`);
		const { incidents } = (await res.json()) as { incidents: Incident[] };
		const state = await kv.get<StatusState>(STATE_KEY, 'json');
		// Oldest first, so the channel reads in order.
		const toPost = newUpdates(incidents, state).reverse();
		for (const { incident, update } of toPost) {
			await postToChannel(token, channelId, createStatusEmbed(incident, update));
		}
		await kv.put(STATE_KEY, JSON.stringify(nextState(incidents)));
	} catch (error) {
		await logToBotLogs(env, `GitHub status check failed: ${error instanceof Error ? error.message : String(error)}`);
	}
};
