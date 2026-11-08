// Project + channel routing. Adding a project = one entry in PROJECTS plus its env vars.
//
// Env vars (naming is the same for every project):
//   DISCORD_BOT_TOKEN                      secret, shared (the bot's identity)
//   DISCORD_CHANNEL_<PROJECT>_<KIND>       channel ID, e.g. DISCORD_CHANNEL_ADS_GITHUB
//   DISCORD_CHANNEL_BOT_LOGS               channel ID for bot errors / unrouted events
//   GITHUB_WEBHOOK_SECRET_<PROJECT>        secret, scoped to the project (e.g. GITHUB_WEBHOOK_SECRET_ADS)
//
// GitHub webhook URL per project: https://<worker>/<path>   e.g. /ads

export type ChannelKind = 'public' | 'releases' | 'development' | 'github' | 'internal';

export interface Project {
	/** Env var key segment, e.g. "ADS" */
	key: string;
	/** Display name used in messages */
	name: string;
}

export const PROJECTS: Record<string, Project> = {
	ads: { key: 'ADS', name: 'AdoptDontShop' },
	pairflix: { key: 'PAIRFLIX', name: 'Pairflix' },
	creatrgrid: { key: 'CREATRGRID', name: 'CreatrGrid' },
	gaminginit: { key: 'GAMINGINIT', name: 'GamingInit' },
};

export type GitHubEventType =
	| 'push'
	| 'pull_request'
	| 'issues'
	| 'discussion'
	| 'star'
	| 'fork'
	| 'release'
	| 'deployment_status'
	| 'check_run';

// Which channels each event goes to. Only releases are public; everything else stays private.
export const EVENT_ROUTES: Record<GitHubEventType, ChannelKind[]> = {
	push: ['github'],
	pull_request: ['github'],
	issues: ['github'],
	discussion: ['github'],
	star: ['github'],
	fork: ['github'],
	release: ['releases', 'github'],
	deployment_status: ['github'],
	check_run: ['github'],
};

// Configure which events you want to receive notifications for
export const ENABLED_EVENTS: Record<GitHubEventType, boolean> = {
	push: false, // Git pushes
	pull_request: true, // Pull request events
	issues: true, // Issue events
	discussion: false, // GitHub Discussions
	star: false, // Repository stars
	fork: false, // Repository forks
	release: true, // New releases
	deployment_status: true, // GitHub Deployments finishing (e.g. Actions deploy job with an environment)
	check_run: true, // Cloudflare Workers Builds finishing (other check runs are ignored)
};

// GitHub App that reports Cloudflare Workers Builds as check runs
export const CLOUDFLARE_BUILDS_APP_SLUG = 'cloudflare-workers-and-pages';

export interface Env {
	DISCORD_BOT_TOKEN?: string;
	[key: string]: string | undefined;
}

export const channelEnvVar = (project: Project, kind: ChannelKind): string =>
	`DISCORD_CHANNEL_${project.key}_${kind.toUpperCase()}`;

export const secretEnvVar = (project: Project): string => `GITHUB_WEBHOOK_SECRET_${project.key}`;

export const BOT_LOGS_ENV_VAR = 'DISCORD_CHANNEL_BOT_LOGS';

// Domain watcher (cron): alerts on RDAP / aftermarket listing changes for this domain
export const WATCHED_DOMAIN = 'ideasquared.com';
export const DOMAIN_ALERTS_ENV_VAR = 'DISCORD_CHANNEL_DOMAIN_ALERTS';
