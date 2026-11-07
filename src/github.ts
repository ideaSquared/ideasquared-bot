// GitHub webhook signature check (X-Hub-Signature-256).
export const verifySignature = async (secret: string, rawBody: string, header: string | null): Promise<boolean> => {
	if (!header || !header.startsWith('sha256=')) return false;

	const hex = header.slice('sha256='.length);
	if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
	const signature = new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));

	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
	// subtle.verify compares in constant time
	return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(rawBody));
};
