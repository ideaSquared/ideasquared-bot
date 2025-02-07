export interface GitHubRepository {
	name: string;
	html_url?: string;
	description?: string;
}

export interface GitHubSender {
	login: string;
	avatar_url?: string;
	html_url?: string;
}

// Enhanced webhook payload to support different event types
export interface GitHubWebhookPayload {
	action?: string;
	repository?: GitHubRepository;
	sender?: GitHubSender;
	ref?: string;
	commits?: Array<{
		message: string;
		url: string;
		id: string;
	}>;
	pull_request?: {
		title: string;
		html_url: string;
		body?: string;
		state: string;
		number: number;
	};
	issue?: {
		title: string;
		html_url: string;
		body?: string;
		state: string;
		number: number;
	};
	discussion?: {
		title: string;
		html_url: string;
		body?: string;
		number: number;
	};
}

// Event types we support
type GitHubEventType = 'push' | 'pull_request' | 'issues' | 'discussion' | 'star' | 'fork' | 'release';

interface FeatureFlags {
	enableSlack: boolean;
	enabledEvents: {
		[K in GitHubEventType]: boolean;
	};
}

// Configure which events you want to receive notifications for
const FEATURES: FeatureFlags = {
	enableSlack: false,
	enabledEvents: {
		push: true, // Git pushes
		pull_request: true, // Pull request events
		issues: true, // Issue events
		discussion: false, // GitHub Discussions
		star: false, // Repository stars
		fork: false, // Repository forks
		release: true, // New releases
	},
};

const getEventType = (request: Request): GitHubEventType | null => {
	const eventHeader = request.headers.get('X-GitHub-Event');
	return eventHeader as GitHubEventType | null;
};

const isEventEnabled = (eventType: GitHubEventType | null): boolean => {
	if (!eventType) return false;
	return FEATURES.enabledEvents[eventType] || false;
};

const createDiscordEmbed = (payload: GitHubWebhookPayload, eventType: GitHubEventType) => {
	const branch = payload.ref ? payload.ref.replace('refs/heads/', '') : 'unknown';

	const getEventSpecificFields = () => {
		switch (eventType) {
			case 'push':
				return [
					{
						name: 'Branch',
						value: branch,
						inline: true,
					},
					...(payload.commits
						? [
								{
									name: 'Latest Commit',
									value: `[\`${payload.commits[0].id.substring(0, 7)}\`](${payload.commits[0].url}): ${payload.commits[0].message}`,
								},
						  ]
						: []),
				];
			case 'pull_request':
				return [
					{
						name: 'Pull Request',
						value: `[#${payload.pull_request?.number}](${payload.pull_request?.html_url}): ${payload.pull_request?.title}`,
					},
				];
			case 'issues':
				return [
					{
						name: 'Issue',
						value: `[#${payload.issue?.number}](${payload.issue?.html_url}): ${payload.issue?.title}`,
					},
				];
			case 'discussion':
				return [
					{
						name: 'Discussion',
						value: `[#${payload.discussion?.number}](${payload.discussion?.html_url}): ${payload.discussion?.title}`,
					},
				];
			default:
				return [];
		}
	};

	return {
		embeds: [
			{
				title: `${payload.repository?.name} - ${eventType.toUpperCase()} Event`,
				url: payload.repository?.html_url,
				color: 0x2b82ea,
				author: {
					name: payload.sender?.login,
					url: payload.sender?.html_url,
					icon_url: payload.sender?.avatar_url,
				},
				description: payload.repository?.description,
				fields: [
					{
						name: 'Event Type',
						value: eventType,
						inline: true,
					},
					{
						name: 'Action',
						value: payload.action || 'none',
						inline: true,
					},
					...getEventSpecificFields(),
				],
				timestamp: new Date().toISOString(),
				footer: {
					text: 'GitHub Bot',
					icon_url: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
				},
			},
		],
	};
};

const createSlackMessage = (payload: GitHubWebhookPayload, eventType: GitHubEventType) => {
	const branch = payload.ref ? payload.ref.replace('refs/heads/', '') : 'unknown';

	const getEventSpecificText = () => {
		switch (eventType) {
			case 'push':
				return payload.commits ? `Latest Commit: \`${payload.commits[0].id.substring(0, 7)}\`: ${payload.commits[0].message}` : '';
			case 'pull_request':
				return `PR #${payload.pull_request?.number}: ${payload.pull_request?.title}`;
			case 'issues':
				return `Issue #${payload.issue?.number}: ${payload.issue?.title}`;
			case 'discussion':
				return `Discussion #${payload.discussion?.number}: ${payload.discussion?.title}`;
			default:
				return '';
		}
	};

	return {
		blocks: [
			{
				type: 'header',
				text: {
					type: 'plain_text',
					text: `${payload.repository?.name} - ${eventType.toUpperCase()} Event`,
				},
			},
			{
				type: 'section',
				fields: [
					{
						type: 'mrkdwn',
						text: `*Event Type:*\n${eventType}`,
					},
					{
						type: 'mrkdwn',
						text: `*Action:*\n${payload.action || 'none'}`,
					},
				],
			},
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: getEventSpecificText(),
				},
			},
			{
				type: 'context',
				elements: [
					{
						type: 'image',
						image_url: payload.sender?.avatar_url || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
						alt_text: 'GitHub',
					},
					{
						type: 'mrkdwn',
						text: `*By:* ${payload.sender?.login}`,
					},
				],
			},
		],
	};
};

export default {
	async fetch(request: Request, env: Record<string, string>): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		try {
			const eventType = getEventType(request);

			// Check if this event type is enabled
			if (!eventType || !isEventEnabled(eventType)) {
				return new Response('Event type not enabled', { status: 200 });
			}

			const payload: GitHubWebhookPayload = await request.json();

			// 🔹 Validate required fields
			if (!payload.repository || !payload.sender || !payload.repository.name || !payload.sender.login) {
				return new Response('Invalid payload structure', { status: 400 });
			}

			// 🔹 Ensure Discord webhook URL is set
			if (!env.DISCORD_WEBHOOK_URL) {
				return new Response('Error: DISCORD_WEBHOOK_URL is not set', { status: 500 });
			}

			// 🔹 Send message to Discord
			const discordRes = await fetch(env.DISCORD_WEBHOOK_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(createDiscordEmbed(payload, eventType)),
			});

			if (!discordRes.ok) {
				return new Response('Error sending message to Discord', { status: 500 });
			}

			// 🔹 Send to Slack if enabled
			if (FEATURES.enableSlack) {
				if (!env.SLACK_WEBHOOK_URL) {
					console.warn('Slack webhook URL not set, skipping Slack notification');
				} else {
					const slackRes = await fetch(env.SLACK_WEBHOOK_URL, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(createSlackMessage(payload, eventType)),
					});

					if (!slackRes.ok) {
						console.error('Error sending message to Slack');
					}
				}
			}

			return new Response('Webhook processed successfully!', { status: 200 });
		} catch (error) {
			return new Response(`Error: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
		}
	},
};
