import { eq } from "drizzle-orm";
import { db } from "../db";
import * as schema from "../db/schema";

/**
 * Extracts the origin from request headers
 */
function extractOriginFromRequest(
	headers?: Headers | Record<string, string | string[] | undefined>,
): string | null {
	if (!headers) return null;

	let originHeader: string | string[] | undefined | null;
	if (headers instanceof Headers) {
		originHeader = headers.get("origin") || headers.get("referer");
	} else {
		const plainHeaders = headers as Record<
			string,
			string | string[] | undefined
		>;
		originHeader = plainHeaders.origin || plainHeaders.referer;
	}

	if (!originHeader) return null;

	const originStr = Array.isArray(originHeader)
		? originHeader[0]
		: originHeader;
	if (!originStr) return null;

	try {
		const url = new URL(originStr);
		return `${url.protocol}//${url.host}`;
	} catch {
		// Invalid URL, ignore
		return null;
	}
}

/**
 * Gets trusted origins for better-auth based on admin configuration and request origin
 * This function is exported for testing purposes
 */
export async function getTrustedOrigins(request?: {
	headers?: Headers | Record<string, string | string[] | undefined>;
}): Promise<string[]> {
	try {
		const admin = await db.query.member.findFirst({
			where: eq(schema.member.role, "owner"),
			with: {
				user: true,
			},
		});

		const origins: string[] = [];

		// Always allow localhost
		origins.push("http://localhost:3000");
		origins.push("http://127.0.0.1:3000");

		// Extract origin from request if available
		const requestOrigin = extractOriginFromRequest(request?.headers);
		if (requestOrigin && !origins.includes(requestOrigin)) {
			origins.push(requestOrigin);
		}

		// If no admin exists yet, allow the request origin for initial setup
		if (!admin) {
			// Also allow common development origins
			origins.push("http://localhost");
			origins.push("http://127.0.0.1");
			return origins;
		}

		// Add admin-configured origins
		if (admin.user.serverIp) {
			origins.push(`http://${admin.user.serverIp}:3000`);
		}
		if (admin.user.host) {
			origins.push(`https://${admin.user.host}`);
			// Also add http version if host is configured
			origins.push(`http://${admin.user.host}`);
		}

		// Always include the current request origin if available
		if (requestOrigin && !origins.includes(requestOrigin)) {
			origins.push(requestOrigin);
		}

		return origins;
	} catch (error) {
		// If there's any error (e.g., DB connection), allow localhost at minimum
		console.error("Error in getTrustedOrigins:", error);
		return ["http://localhost:3000", "http://127.0.0.1:3000"];
	}
}

