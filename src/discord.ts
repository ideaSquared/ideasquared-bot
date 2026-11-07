const DISCORD_API = 'https://discord.com/api/v10';

// Discord requires a descriptive User-Agent for bot requests.
const USER_AGENT = 'DiscordBot (https://github.com/ideaSquared/ideasquared-bot, 1.0.0)';

export const postToChannel = async (token: string, channelId: string, body: unknown): Promise<void> => {
	const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bot ${token}`,
			'User-Agent': USER_AGENT,
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		throw new Error(`Discord ${res.status} posting to channel ${channelId}: ${await res.text()}`);
	}
};
