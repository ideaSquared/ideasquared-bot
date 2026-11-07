const DISCORD_API = 'https://discord.com/api/v10';

// Discord requires a descriptive User-Agent for bot requests.
const USER_AGENT = 'DiscordBot (https://github.com/ideaSquared/ideasquared-bot, 1.0.0)';

const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5000;

export const postToChannel = async (token: string, channelId: string, body: unknown): Promise<void> => {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bot ${token}`,
				'User-Agent': USER_AGENT,
			},
			body: JSON.stringify(body),
		});

		if (res.ok) return;

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

		throw new Error(`Discord ${res.status} posting to channel ${channelId}: ${await res.text().catch(() => '')}`);
	}
};
