// The live deploy board: one message in #ship-status, edited after every shipper report.
import { Env, SHIP_STATUS_ENV_VAR } from './config';
import { editMessage, postToChannel } from './discord';
import { ShipOutcome, ShipReport } from './ship';

export type BoardBindings = { BOT_STATE?: KVNamespace };

const STATE_KEY = 'ship-board';

type Attempt = { sha: string; at: string; actor: string; runUrl: string };

export type BoardEntry = {
	product: string;
	repository: string;
	environment: string;
	// What is running now, as far as shipper reports tell us.
	live?: Attempt;
	last: Attempt & { outcome: ShipOutcome };
};

export type BoardState = { messageId?: string; entries: Record<string, BoardEntry> };

const emptyState = (): BoardState => ({ entries: {} });

// Shipped: the new commit is live. Rolled back: the previous one still is. Failed or blocked: unchanged.
const liveAfter = (report: ShipReport, before: Attempt | undefined): Attempt | undefined => {
	const attempt = { sha: report.sha, at: report.at, actor: report.actor, runUrl: report.runUrl };
	if (report.outcome === 'shipped') return attempt;
	if (report.outcome === 'rolled-back' && report.previousSha && before?.sha !== report.previousSha) {
		return { ...attempt, sha: report.previousSha };
	}
	return before;
};

export const applyReport = (state: BoardState, report: ShipReport): BoardState => {
	const key = `${report.product}/${report.environment}`;
	const before = state.entries[key];
	const entry: BoardEntry = {
		product: report.product,
		repository: report.repository,
		environment: report.environment,
		live: liveAfter(report, before?.live),
		last: { sha: report.sha, at: report.at, actor: report.actor, runUrl: report.runUrl, outcome: report.outcome },
	};
	return { ...state, entries: { ...state.entries, [key]: entry } };
};

const ICONS: Record<ShipOutcome, string> = { shipped: '🟢', 'rolled-back': '🟡', failed: '🔴', blocked: '⛔' };
const short = (sha: string) => sha.slice(0, 7);
const when = (iso: string) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
const commit = (repository: string, sha: string) => `[\`${short(sha)}\`](https://github.com/${repository}/commit/${sha})`;

const entryLines = (e: BoardEntry): string[] => {
	const live = e.live
		? `${ICONS[e.last.outcome]} **${e.environment}** · ${commit(e.repository, e.live.sha)} · by ${e.live.actor} ${when(e.live.at)}`
		: `${ICONS[e.last.outcome]} **${e.environment}** · nothing shipped yet`;
	if (e.last.outcome === 'shipped') return [live];
	return [
		live,
		`└ last attempt [${e.last.outcome}](${e.last.runUrl}): ${commit(e.repository, e.last.sha)} by ${e.last.actor} ${when(e.last.at)}`,
	];
};

export const renderBoard = (state: BoardState, now: Date) => {
	const byProduct = Object.values(state.entries).reduce<Record<string, BoardEntry[]>>(
		(groups, e) => ({ ...groups, [e.product]: [...(groups[e.product] ?? []), e] }),
		{},
	);
	const fields = Object.keys(byProduct)
		.sort()
		.map((product) => ({
			name: product,
			value: (byProduct[product] ?? [])
				.sort((a, b) => a.environment.localeCompare(b.environment))
				.flatMap(entryLines)
				.join('\n')
				.slice(0, 1024),
		}))
		.slice(0, 25);
	return {
		embeds: [
			{
				title: '🚢 ideaSquared deploys',
				description: fields.length > 0 ? 'What is live where, updated after every ship.' : 'No ships reported yet.',
				color: 0x5865f2,
				fields,
				footer: { text: '🟢 live · 🟡 rolled back · 🔴 failed · ⛔ blocked' },
				timestamp: now.toISOString(),
			},
		],
	};
};

// Records the report, then edits the board message, or posts a new one if it is missing.
export const updateBoard = async (env: Env, token: string, report: ShipReport, now = new Date()): Promise<void> => {
	// KV bindings sit on the same env object; Env only declares the string vars.
	const kv = (env as unknown as BoardBindings).BOT_STATE;
	const channelId = env[SHIP_STATUS_ENV_VAR];
	if (!kv || !channelId) return;

	const stored = await kv.get<BoardState>(STATE_KEY, 'json');
	const state = applyReport(stored ?? emptyState(), report);
	const body = renderBoard(state, now);
	const edited = state.messageId ? await editMessage(token, channelId, state.messageId, body) : false;
	const messageId = edited ? state.messageId : await postToChannel(token, channelId, body);
	await kv.put(STATE_KEY, JSON.stringify({ ...state, messageId }));
};
