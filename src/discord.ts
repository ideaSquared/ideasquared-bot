import { BOT_LOGS_ENV_VAR, Env } from './config';

const DISCORD_API = 'https://discord.com/api/v10';

// Discord requires a descriptive User-Agent for bot requests.
const USER_AGENT = 'DiscordBot (https://github.com/ideaSquared/ideasquared-bot, 1.0.0)';

const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5000;

// Returns the new message's id when Discord sends one back.
export const postToChannel = async (token: string, channelId: string, body: unknown): Promise<string | undefined> =>
	sendMessage(token, `${DISCORD_API}/channels/${channelId}/messages`, 'POST', body, channelId);

// Edits a message the bot posted earlier. Returns false when the message no longer exists.
export const editMessage = async (token: string, channelId: string, messageId: string, body: unknown): Promise<boolean> => {
	try {
		await sendMessage(token, `${DISCORD_API}/channels/${channelId}/messages/${messageId}`, 'PATCH', body, channelId);
		return true;
	} catch (error) {
		if (error instanceof DiscordError && error.status === 404) return false;
		throw error;
	}
};

class DiscordError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

const sendMessage = async (token: string, url: string, method: string, body: unknown, channelId: string): Promise<string | undefined> => {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, {
			method,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bot ${token}`,
				'User-Agent': USER_AGENT,
			},
			body: JSON.stringify(body),
		});

		if (res.ok) {
			const data = (await res.json().catch(() => ({}))) as { id?: unknown };
			return typeof data.id === 'string' ? data.id : undefined;
		}

		// Rate limited: honour Discord's retry_after (seconds) with a short, bounded wait
		if (res.status === 429 && attempt < MAX_RETRIES) {
			const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
			const retryAfter = data.retry_after ?? (Number(res.headers.get('Retry-After')) || 1);
			const waitMs = Math.ceil(retryAfter * 1000);
			if (waitMs <= MAX_RETRY_WAIT_MS) {
				await new Promise((r) => setTimeout(r, waitMs));
				continue;
			}
		}

		throw new DiscordError(res.status, `Discord ${res.status} sending to channel ${channelId}: ${await res.text().catch(() => '')}`);
	}
};

// Best-effort error report to #bot-logs; never throws.
export const logToBotLogs = async (env: Env, message: string): Promise<void> => {
	console.error(message);
	const token = env.DISCORD_BOT_TOKEN;
	const channelId = env[BOT_LOGS_ENV_VAR];
	if (!token || !channelId) return;
	try {
		await postToChannel(token, channelId, { content: `⚠️ ${message}`.slice(0, 2000) });
	} catch (e) {
		console.error('Failed to post to bot-logs', e);
	}
};
