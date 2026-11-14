// Operational alerts from ideaSquared products (POST /alert), posted to the project's github channel with @everyone.
import { z } from 'zod';
import { Project } from './config';

export const ALERT_SECRET_ENV_VAR = 'ALERT_SECRET';
export const ALERT_SIGNATURE_HEADER = 'X-Alert-Signature-256';

export const AlertSchema = z.object({
	project: z.string(),
	severity: z.enum(['critical', 'warning']),
	title: z.string().min(1).max(200),
	details: z.string().max(1500).optional(),
	source: z.string().max(100).optional(),
});

export type Alert = z.infer<typeof AlertSchema>;

const STYLES: Record<Alert['severity'], { emoji: string; color: number }> = {
	critical: { emoji: '🚨', color: 0xe01e5a },
	warning: { emoji: '⚠️', color: 0xecb22e },
};

export const createAlertMessage = (alert: Alert, project: Project) => ({
	content: '@everyone',
	// Discord ignores @everyone in content unless the message allows it.
	allowed_mentions: { parse: ['everyone'] },
	embeds: [
		{
			title: `${STYLES[alert.severity].emoji} ${alert.title}`,
			color: STYLES[alert.severity].color,
			description: alert.details,
			timestamp: new Date().toISOString(),
			footer: { text: [alert.source, project.name].filter(Boolean).join(' · ') },
		},
	],
});

// Alertmanager's webhook body (version 4). Alertmanager cannot sign a body, so this route takes ALERT_SECRET as a
// bearer token instead. Only the fields the message uses are read.
const Labels = z.record(z.string(), z.string());
export const AlertmanagerSchema = z.object({
	status: z.enum(['firing', 'resolved']),
	commonLabels: Labels.default({}),
	alerts: z
		.array(z.object({ status: z.enum(['firing', 'resolved']), labels: Labels.default({}), annotations: Labels.default({}) }))
		.min(1),
});

export type AlertmanagerPayload = z.infer<typeof AlertmanagerSchema>;

const RESOLVED = { emoji: '✅', color: 0x2eb67d };
const MAX_DETAILS = 1500;

const describeAlert = (a: AlertmanagerPayload['alerts'][number]): string =>
	[a.annotations.summary, a.annotations.description, a.annotations.runbook ? `Runbook: ${a.annotations.runbook}` : undefined]
		.filter(Boolean)
		.join('\n');

export const severityOf = (payload: AlertmanagerPayload): Alert['severity'] =>
	payload.commonLabels.severity === 'critical' ? 'critical' : 'warning';

// Firing pings @everyone like any alert; resolved is posted without a ping so recoveries don't wake anyone.
export const createAlertmanagerMessage = (payload: AlertmanagerPayload, project: Project) => {
	const firing = payload.status === 'firing';
	const style = firing ? STYLES[severityOf(payload)] : RESOLVED;
	const name = payload.commonLabels.alertname ?? payload.alerts[0]?.labels.alertname ?? 'Alert';
	const details = payload.alerts.map(describeAlert).filter(Boolean).join('\n\n');
	return {
		...(firing ? { content: '@everyone' } : {}),
		allowed_mentions: { parse: firing ? ['everyone'] : [] },
		embeds: [
			{
				title: `${style.emoji} ${firing ? 'Firing' : 'Resolved'}: ${name}`.slice(0, 256),
				color: style.color,
				description: details.length > MAX_DETAILS ? `${details.slice(0, MAX_DETAILS - 1)}…` : details || undefined,
				timestamp: new Date().toISOString(),
				footer: { text: `Alertmanager · ${project.name}` },
			},
		],
	};
};

// Constant-time check of `Authorization: Bearer <secret>`.
export const verifyBearer = async (secret: string, header: string | null): Promise<boolean> => {
	const match = /^Bearer (.+)$/.exec(header ?? '');
	if (!match) return false;
	const encoder = new TextEncoder();
	const [given, expected] = await Promise.all(
		[match[1], secret].map(async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(v))))
	);
	return crypto.subtle.timingSafeEqual(given, expected);
};
