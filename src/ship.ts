// Deploy reports from ideaSquared/shipper (POST /ship), turned into one clear embed per deploy.
import { Project } from './config';

export const SHIP_SECRET_ENV_VAR = 'SHIP_NOTIFY_SECRET';
export const SHIP_SIGNATURE_HEADER = 'X-Ship-Signature-256';

export type ShipOutcome = 'shipped' | 'rolled-back' | 'failed' | 'blocked';
export type ComponentStatus = 'deployed' | 'failed' | 'rolled-back' | 'skipped';

export interface ShipReport {
	version: 1;
	project: string;
	product: string;
	repository: string;
	environment: string;
	outcome: ShipOutcome;
	actor: string;
	at: string;
	sha: string;
	previousSha: string | null;
	compareUrl: string | null;
	runUrl: string;
	totalCommits: number;
	commits: { sha: string; message: string; author: string; url: string }[];
	components: { name: string; status: ComponentStatus; url?: string; detail?: string }[];
	failures: string[];
}

const OUTCOMES: readonly string[] = ['shipped', 'rolled-back', 'failed', 'blocked'];
const STATUSES: readonly string[] = ['deployed', 'failed', 'rolled-back', 'skipped'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isOptionalString = (v: unknown): boolean => v === undefined || isString(v);

// Checks the shape before anything is rendered; returns why it is invalid, or undefined.
export const invalidReason = (value: unknown): string | undefined => {
	if (!isObject(value)) return 'body is not an object';
	if (value.version !== 1) return 'unsupported version';
	const strings = ['project', 'product', 'repository', 'environment', 'actor', 'at', 'sha', 'runUrl'];
	const missing = strings.find((key) => !isString(value[key]) || value[key] === '');
	if (missing) return `${missing} must be a non-empty string`;
	if (!isString(value.outcome) || !OUTCOMES.includes(value.outcome)) return 'unknown outcome';
	if (Number.isNaN(Date.parse(value.at as string))) return 'at is not a date';
	if (value.previousSha !== null && !isString(value.previousSha)) return 'previousSha must be a string or null';
	if (value.compareUrl !== null && !isString(value.compareUrl)) return 'compareUrl must be a string or null';
	if (typeof value.totalCommits !== 'number') return 'totalCommits must be a number';
	const commitsOk =
		Array.isArray(value.commits) &&
		value.commits.every((c) => isObject(c) && isString(c.sha) && isString(c.message) && isString(c.author) && isString(c.url));
	if (!commitsOk) return 'commits are malformed';
	const componentsOk =
		Array.isArray(value.components) &&
		value.components.every(
			(c) => isObject(c) && isString(c.name) && isString(c.status) && STATUSES.includes(c.status) && isOptionalString(c.url) && isOptionalString(c.detail),
		);
	if (!componentsOk) return 'components are malformed';
	if (!Array.isArray(value.failures) || !value.failures.every(isString)) return 'failures are malformed';
	return undefined;
};

const COLORS: Record<ShipOutcome, number> = {
	shipped: 0x2eb67d,
	'rolled-back': 0xecb22e,
	failed: 0xe01e5a,
	blocked: 0xe01e5a,
};

const titleOf = (r: ShipReport): string =>
	({
		shipped: `🚀 ${r.product} shipped to ${r.environment}`,
		'rolled-back': `↩️ ${r.product} rolled back on ${r.environment}`,
		failed: `❌ ${r.product} failed to ship to ${r.environment}`,
		blocked: `⛔ ${r.product} blocked from ${r.environment}`,
	})[r.outcome];

const short = (sha: string): string => sha.slice(0, 7);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const repoUrl = (r: ShipReport): string => `https://github.com/${r.repository}`;
const commitLink = (r: ShipReport, sha: string): string => `[\`${short(sha)}\`](${repoUrl(r)}/commit/${sha})`;

const rangeLine = (r: ShipReport): string => {
	if (r.previousSha === null) return `First ship to ${r.environment}: ${commitLink(r, r.sha)}`;
	if (r.previousSha === r.sha) return `Redeployed ${commitLink(r, r.sha)}`;
	const count = `${r.totalCommits} commit${r.totalCommits === 1 ? '' : 's'}`;
	const counted = r.compareUrl ? `[${count}](${r.compareUrl})` : count;
	return `${commitLink(r, r.previousSha)} → ${commitLink(r, r.sha)} · ${counted}`;
};

const commitLines = (r: ShipReport): string[] => {
	const lines = r.commits.map((c) => `• [\`${short(c.sha)}\`](${c.url}) ${clip(c.message, 90)} · ${c.author}`);
	const more = r.totalCommits - r.commits.length;
	return more > 0 ? [...lines, `…and ${more} more`] : lines;
};

// Room under Discord's limits: 6000 characters of text per embed, so cap what the fields can take.
const EMBED_TEXT_LIMIT = 5900;
const MAX_FIELDS = 10;
const MAX_FIELD_VALUE = 300;

const STATUS_LABEL: Record<ComponentStatus, string> = {
	deployed: '✅ Deployed',
	'rolled-back': '↩️ Rolled back',
	failed: '❌ Failed',
	skipped: '⏭️ Skipped',
};

export const createShipEmbed = (r: ShipReport, project: Project) => {
	const unix = Math.floor(Date.parse(r.at) / 1000);
	const intro = r.outcome === 'blocked' ? 'Tried by' : 'Shipped by';
	const description = [
		`${intro} **${r.actor}** · <t:${unix}:f> (<t:${unix}:R>)`,
		r.outcome === 'blocked' ? `Commit ${commitLink(r, r.sha)}` : rangeLine(r),
		...(r.outcome === 'blocked' ? ['', '**Blocked because:**', ...r.failures.map((f) => `• ${clip(f, 200)}`)] : []),
		...(r.outcome !== 'blocked' && r.failures.length > 0 ? ['', ...r.failures.map((f) => `• ${clip(f, 200)}`)] : []),
		...(r.commits.length > 0 ? ['', ...commitLines(r)] : []),
		'',
		`[View the run](${r.runUrl})`,
	].join('\n');

	const title = clip(titleOf(r), 256);
	const footer = clip(`${project.name} · ${r.repository}`, 2048);
	const fields = r.components.slice(0, MAX_FIELDS).map((c) => ({
		name: clip(c.name, 256),
		value: clip([STATUS_LABEL[c.status], c.url, c.detail].filter(Boolean).join('\n'), MAX_FIELD_VALUE),
		inline: r.components.length > 1,
	}));
	// Discord rejects an embed whose text adds up to more than 6000 characters; the description gets what is left.
	const used = title.length + r.actor.length + footer.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
	const descriptionBudget = Math.min(4096, EMBED_TEXT_LIMIT - used);

	return {
		embeds: [
			{
				title,
				url: r.runUrl,
				color: COLORS[r.outcome],
				author: { name: r.actor, url: `https://github.com/${r.actor}`, icon_url: `https://github.com/${r.actor}.png` },
				description: clip(description, descriptionBudget),
				fields,
				timestamp: r.at,
				footer: { text: footer },
			},
		],
	};
};
