import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

// Mock environment
const mockEnv = {
	DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test',
};

// Mock Fetch API for Discord webhook
globalThis.fetch = vi.fn(async (url, options) => {
	if (url.includes('discord.com/api/webhooks')) {
		return new Response('Discord message sent', { status: 200 });
	}
	return new Response('Unknown request', { status: 400 });
});

describe('GitHub Webhook Worker (Discord Only)', () => {
	it('returns 405 for non-POST requests', async () => {
		const request = new Request('http://example.com', { method: 'GET' });
		const response = await worker.fetch(request, mockEnv);
		expect(response.status).toBe(405);
		expect(await response.text()).toBe('Method Not Allowed');
	});

	it('returns 400 for invalid payloads', async () => {
		const request = new Request('http://example.com', {
			method: 'POST',
			body: JSON.stringify({ invalid: 'data' }),
			headers: { 'Content-Type': 'application/json' },
		});
		const response = await worker.fetch(request, mockEnv);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Invalid payload');
	});

	it('handles valid GitHub webhook payload (Discord only)', async () => {
		const githubPayload = {
			action: 'opened',
			repository: { name: 'test-repo' },
			sender: { login: 'test-user' },
		};

		const request = new Request('http://example.com', {
			method: 'POST',
			body: JSON.stringify(githubPayload),
			headers: { 'Content-Type': 'application/json' },
		});

		const response = await worker.fetch(request, mockEnv);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Webhook processed successfully!');

		// Verify fetch was called for Discord
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			mockEnv.DISCORD_WEBHOOK_URL,
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ content: '🔔 **GitHub Update** in **test-repo** by **test-user**' }),
			})
		);
	});

	it('fails gracefully when Discord webhook returns errors', async () => {
		globalThis.fetch = vi.fn(async () => new Response('Error', { status: 500 }));

		const githubPayload = {
			action: 'opened',
			repository: { name: 'test-repo' },
			sender: { login: 'test-user' },
		};

		const request = new Request('http://example.com', {
			method: 'POST',
			body: JSON.stringify(githubPayload),
			headers: { 'Content-Type': 'application/json' },
		});

		const response = await worker.fetch(request, mockEnv);
		expect(response.status).toBe(500);
		expect(await response.text()).toBe('Error sending messages');
	});
});
