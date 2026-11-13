import { CLOUDFLARE_BUILDS_APP_SLUG, ChannelKind, DOMAIN_CRON, GITHUB_STATUS_CRON, ENABLED_EVENTS, EVENT_ROUTES, Env, GitHubEventType, PROJECTS, Project, channelEnvVar, secretEnvVar } from './config';
import { updateBoard } from './board';
import { logToBotLogs, postToChannel } from './discord';
import { DomainBindings, checkDomain } from './domain';
import { verifySignature } from './github';
import { StatusBindings, checkGitHubStatus } from './github-status';
import { SHIP_SECRET_ENV_VAR, SHIP_SIGNATURE_HEADER, ShipReport, createShipEmbed, invalidReason } from './ship';

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
	release?: {
		name?: string | null;
		tag_name: string;
		html_url: string;
		body?: string | null;
		prerelease?: boolean;
	};
	deployment_status?: {
		state: string;
		environment?: string;
		target_url?: string | null;
		log_url?: string | null;
		environment_url?: string | null;
	};
	deployment?: {
		sha: string;
		ref?: string;
		environment?: string;
	};
	check_run?: {
		name: string;
		head_sha: string;
		conclusion?: string | null;
		html_url?: string;
		details_url?: string | null;
		app?: { slug?: string };
	};
}

// Final deployment states worth announcing (pending / queued / in_progress are skipped)
const FINAL_DEPLOYMENT_STATES = ['success', 'failure', 'error'];

const deployOutcome = (payload: GitHubWebhookPayload, eventType: GitHubEventType): string | undefined =>
	eventType === 'deployment_status'
		? payload.deployment_status?.state
		: eventType === 'check_run'
			? payload.check_run?.conclusion ?? undefined
			: undefined;

const createDiscordEmbed = (payload: GitHubWebhookPayload, eventType: GitHubEventType, project: Project) => {
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
			case 'deployment_status': {
				const status = payload.deployment_status;
				const link = status?.log_url || status?.target_url;
				return [
					{ name: 'Environment', value: status?.environment || payload.deployment?.environment || 'unknown', inline: true },
					{ name: 'State', value: status?.state || 'unknown', inline: true },
					{ name: 'Commit', value: `\`${payload.deployment?.sha.substring(0, 7)}\``, inline: true },
					...(link ? [{ name: 'Logs', value: link }] : []),
					...(status?.environment_url ? [{ name: 'URL', value: status.environment_url }] : []),
				];
			}
			case 'check_run': {
				const run = payload.check_run;
				const link = run?.details_url || run?.html_url;
				return [
					{ name: 'Build', value: run?.name || 'unknown', inline: true },
					{ name: 'Conclusion', value: run?.conclusion || 'unknown', inline: true },
					{ name: 'Commit', value: `\`${run?.head_sha.substring(0, 7)}\``, inline: true },
					...(link ? [{ name: 'Logs', value: link }] : []),
				];
			}
			default:
				return [];
		}
	};

	const outcome = deployOutcome(payload, eventType);
	const color = outcome === undefined ? 0x2b82ea : outcome === 'success' ? 0x2eb67d : 0xe01e5a;

	return {
		embeds: [
			{
				title: `${project.name} / ${payload.repository?.name} - ${eventType.toUpperCase()} Event`,
				url: payload.repository?.html_url,
				color,
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
					text: 'ideaSquared Bot',
					icon_url: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
				},
			},
		],
	};
};

// POST /ship: a deploy report from ideaSquared/shipper, signed with SHIP_NOTIFY_SECRET.
const handleShip = async (request: Request, env: Env): Promise<Response> => {
	const token = env.DISCORD_BOT_TOKEN;
	const secret = env[SHIP_SECRET_ENV_VAR];
	if (!token || !secret) {
		return new Response(`Error: ${!token ? 'DISCORD_BOT_TOKEN' : SHIP_SECRET_ENV_VAR} is not set`, { status: 500 });
	}
	const rawBody = await request.text();
	if (!(await verifySignature(secret, rawBody, request.headers.get(SHIP_SIGNATURE_HEADER)))) {
		return new Response('Invalid signature', { status: 401 });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return new Response('Body is not JSON', { status: 400 });
	}
	const reason = invalidReason(parsed);
	if (reason) return new Response(`Invalid report: ${reason}`, { status: 400 });
	// invalidReason has checked every field ShipReport declares.
	const report = parsed as ShipReport;

	const project = PROJECTS[report.project.toLowerCase()];
	if (!project) {
		await logToBotLogs(env, `Ship report for unknown project '${report.project}' (${report.repository})`);
		return new Response('Unknown project', { status: 404 });
	}
	const channelId = env[channelEnvVar(project, 'github')];
	if (!channelId) {
		const msg = `No channel configured for ${project.name} ship report (expected ${channelEnvVar(project, 'github')})`;
		await logToBotLogs(env, msg);
		return new Response(`Error: ${msg}`, { status: 500 });
	}

	try {
		await postToChannel(token, channelId, createShipEmbed(report, project));
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		await logToBotLogs(env, `${project.name} ship report delivery failed: ${msg}`);
		return new Response('Error sending message to Discord', { status: 502 });
	}
	// The board is a convenience: a failure is logged, never returned to shipper.
	try {
		await updateBoard(env, token, report);
	} catch (error) {
		await logToBotLogs(env, `Ship board update failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return new Response('Ship report posted', { status: 200 });
};

const getEventType = (request: Request): GitHubEventType | null => {
	return request.headers.get('X-GitHub-Event') as GitHubEventType | null;
};

const isEventEnabled = (eventType: GitHubEventType | null): eventType is GitHubEventType => {
	return !!eventType && ENABLED_EVENTS[eventType] === true;
};

const resolveChannels = (env: Env, project: Project, kinds: ChannelKind[]): { kind: ChannelKind; id: string }[] => {
	const channels: { kind: ChannelKind; id: string }[] = [];
	for (const kind of kinds) {
		const id = env[channelEnvVar(project, kind)];
		if (id) channels.push({ kind, id });
	}
	return channels;
};

export default {
	// Cron trigger (see wrangler.json): domain watcher
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		// KV bindings don't fit Env's string index signature, so they're read separately
		if (controller.cron === DOMAIN_CRON) ctx.waitUntil(checkDomain(env, env as unknown as DomainBindings));
		if (controller.cron === GITHUB_STATUS_CRON) ctx.waitUntil(checkGitHubStatus(env, env as unknown as StatusBindings));
	},

	async fetch(request: Request, env: Env): Promise<Response> {
		// Health check for deploys (ideaSquared/shipper polls it and rolls back if it never answers)
		if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
			return new Response('ok', { status: 200 });
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		// Route by project: POST /<project>
		const projectPath = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
		if (projectPath === 'ship') return handleShip(request, env);
		const project = PROJECTS[projectPath];
		if (!project) {
			return new Response('Unknown project', { status: 404 });
		}

		const token = env.DISCORD_BOT_TOKEN;
		if (!token) {
			return new Response('Error: DISCORD_BOT_TOKEN is not set', { status: 500 });
		}

		// Authenticate the sender with the project-scoped secret
		const secret = env[secretEnvVar(project)];
		if (!secret) {
			return new Response(`Error: ${secretEnvVar(project)} is not set`, { status: 500 });
		}
		const rawBody = await request.text();
		if (!(await verifySignature(secret, rawBody, request.headers.get('X-Hub-Signature-256')))) {
			return new Response('Invalid signature', { status: 401 });
		}

		try {
			// GitHub sends a ping when a webhook is created; confirm it in the project's github channel
			if (request.headers.get('X-GitHub-Event') === 'ping') {
				const channelId = env[channelEnvVar(project, 'github')];
				if (!channelId) {
					const msg = `No channel configured for ${project.name} ping (expected ${channelEnvVar(project, 'github')})`;
					await logToBotLogs(env, msg);
					return new Response(`Error: ${msg}`, { status: 500 });
				}
				const ping: GitHubWebhookPayload & { zen?: string } = JSON.parse(rawBody);
				await postToChannel(token, channelId, {
					embeds: [
						{
							title: `${project.name}${ping.repository?.name ? ` / ${ping.repository.name}` : ''} - Webhook initialised`,
							url: ping.repository?.html_url,
							color: 0x2eb67d,
							description: ping.zen ? `_${ping.zen}_` : undefined,
							timestamp: new Date().toISOString(),
							footer: { text: 'ideaSquared Bot' },
						},
					],
				});
				return new Response('Pong', { status: 200 });
			}

			const eventType = getEventType(request);
			if (!isEventEnabled(eventType)) {
				return new Response('Event type not enabled', { status: 200 });
			}

			const payload: GitHubWebhookPayload = JSON.parse(rawBody);

			if (!payload.repository || !payload.sender || !payload.repository.name || !payload.sender.login) {
				return new Response('Invalid payload structure', { status: 400 });
			}

			// Only announce a release once, when it is published
			if (eventType === 'release' && payload.action !== 'published') {
				return new Response('Release action ignored', { status: 200 });
			}

			// Only announce deployments once they finish
			if (eventType === 'deployment_status' && !FINAL_DEPLOYMENT_STATES.includes(payload.deployment_status?.state ?? '')) {
				return new Response('Deployment state ignored', { status: 200 });
			}

			// Only Cloudflare Workers Builds check runs, once completed (CI test runs etc. are ignored)
			if (
				eventType === 'check_run' &&
				(payload.action !== 'completed' || payload.check_run?.app?.slug !== CLOUDFLARE_BUILDS_APP_SLUG)
			) {
				return new Response('Check run ignored', { status: 200 });
			}

			const channels = resolveChannels(env, project, EVENT_ROUTES[eventType]);
			if (channels.length === 0) {
				const msg = `No channels configured for ${project.name} ${eventType} (expected ${EVENT_ROUTES[eventType]
					.map((k) => channelEnvVar(project, k))
					.join(', ')})`;
				await logToBotLogs(env, msg);
				return new Response(`Error: ${msg}`, { status: 500 });
			}

			// Partial config: still deliver to what's configured, but flag what's missing
			const missing = EVENT_ROUTES[eventType].filter((k) => !channels.some((c) => c.kind === k));
			if (missing.length > 0) {
				await logToBotLogs(env, `${project.name} ${eventType}: missing ${missing.map((k) => channelEnvVar(project, k)).join(', ')}`);
			}

			const body = createDiscordEmbed(payload, eventType, project);
			const results = await Promise.allSettled(channels.map((c) => postToChannel(token, c.id, body)));

			const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [`${channels[i].kind}: ${r.reason instanceof Error ? r.reason.message : r.reason}`] : []));
			if (failures.length > 0) {
				await logToBotLogs(env, `${project.name} ${eventType} delivery failed — ${failures.join('; ')}`);
			}
			if (failures.length === channels.length) {
				return new Response('Error sending message to Discord', { status: 502 });
			}

			return new Response('Webhook processed successfully!', { status: 200 });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			await logToBotLogs(env, `${project.name} webhook error: ${msg}`);
			return new Response(`Error: ${msg}`, { status: 500 });
		}
	},
};
