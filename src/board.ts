// The live deploy board: one message in #ship-status, edited after every shipper report.
import { DurableObject } from 'cloudflare:workers';
import { Env, SHIP_STATUS_ENV_VAR } from './config';
import { editMessage, postToChannel } from './discord';
import { ShipOutcome, ShipReport } from './ship';

export type BoardBindings = { SHIP_BOARD?: DurableObjectNamespace<ShipBoard> };

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

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Discord rejects an embed over 6000 characters in total or with more than 25 fields;
// this leaves room for the title, description, footer and the overflow line.
const FIELD_BUDGET = 5500;
const MAX_FIELDS = 24;

type Field = { name: string; value: string };

// Keeps whole fields, in order, while they fit, then one line saying how many were left out.
const withinBudget = (fields: readonly Field[]): Field[] => {
	const { kept } = fields.reduce<{ kept: Field[]; used: number; full: boolean }>(
		(acc, field) => {
			const size = field.name.length + field.value.length;
			if (acc.full || acc.kept.length >= MAX_FIELDS || acc.used + size > FIELD_BUDGET) return { ...acc, full: true };
			return { ...acc, kept: [...acc.kept, field], used: acc.used + size };
		},
		{ kept: [], used: 0, full: false },
	);
	const left = fields.length - kept.length;
	return left > 0 ? [...kept, { name: '…', value: `${left} more product${left === 1 ? '' : 's'} not shown` }] : kept;
};

export const renderBoard = (state: BoardState, now: Date) => {
	const byProduct = Object.values(state.entries).reduce<Record<string, BoardEntry[]>>(
		(groups, e) => ({ ...groups, [e.product]: [...(groups[e.product] ?? []), e] }),
		{},
	);
	const fields = withinBudget(
		Object.keys(byProduct)
			.sort()
			.map((product) => ({
				name: clip(product, 256),
				value: clip(
					(byProduct[product] ?? [])
						.sort((a, b) => a.environment.localeCompare(b.environment))
						.flatMap(entryLines)
						.join('\n'),
					1024,
				),
			})),
	);
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

type Store = { get: () => Promise<BoardState | undefined>; put: (state: BoardState) => Promise<void> };

// Records the report, then edits the board message, or posts a new one if it is missing.
const recordReport = async (store: Store, token: string, channelId: string, report: ShipReport, now: Date): Promise<void> => {
	const state = applyReport((await store.get()) ?? emptyState(), report);
	// Saved before Discord is called, so a failed edit never loses what is live.
	await store.put(state);
	const body = renderBoard(state, now);
	const edited = state.messageId ? await editMessage(token, channelId, state.messageId, body) : false;
	if (edited) return;
	const messageId = await postToChannel(token, channelId, body);
	if (messageId) await store.put({ ...state, messageId });
};

// The one writer of the board. Reports from different products can arrive together; each waits
// for the one before it, including its Discord calls, so none is lost and only one message is posted.
export class ShipBoard extends DurableObject<Env> {
	private queue: Promise<unknown> = Promise.resolve();

	async record(report: ShipReport, token: string, channelId: string): Promise<void> {
		const store: Store = {
			get: () => this.ctx.storage.get<BoardState>(STATE_KEY),
			put: (state) => this.ctx.storage.put(STATE_KEY, state),
		};
		const run = this.queue.then(() => recordReport(store, token, channelId, report, new Date()));
		this.queue = run.catch(() => undefined);
		return run;
	}
}

// Hands the report to the board's Durable Object. Does nothing when the board isn't set up.
export const updateBoard = async (env: Env, token: string, report: ShipReport): Promise<void> => {
	// Durable Object bindings sit on the same env object; Env only declares the string vars.
	const namespace = (env as unknown as BoardBindings).SHIP_BOARD;
	const channelId = env[SHIP_STATUS_ENV_VAR];
	if (!namespace || !channelId) return;
	await namespace.getByName('board').record(report, token, channelId);
};
