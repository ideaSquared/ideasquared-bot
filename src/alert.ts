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
