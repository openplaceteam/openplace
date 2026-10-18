import FingerprintJS from "@fingerprintjs/fingerprintjs";

// Cached across calls so FingerprintJS only loads and runs once per page load
let visitorIdPromise: Promise<string | null> | null = null;

async function computeVisitorId(): Promise<string | null> {
	try {
		const agent = await FingerprintJS.load();
		const result = await agent.get();
		return result.visitorId;
	} catch (error) {
		console.error("Failed to compute browser fingerprint:", error);
		return null;
	}
}

export function useFingerprint() {
	/**
	 * Returns the FingerprintJS visitorId, or null when unavailable
	 * (SSR, unsupported browser, or FingerprintJS failed to load).
	 */
	const getVisitorId = (): Promise<string | null> => {
		if (!import.meta.client) {
			return Promise.resolve(null);
		}
		visitorIdPromise ??= computeVisitorId();
		return visitorIdPromise;
	};

	return { getVisitorId };
}
