import type { IncomingMessage } from "node:http";
import * as bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { admin, apiKey, organization, twoFactor } from "better-auth/plugins";
import { and, desc, eq } from "drizzle-orm";
import { IS_CLOUD } from "../constants";
import { db } from "../db";
import * as schema from "../db/schema";
import { getUserByToken } from "../services/admin";
import { updateUser } from "../services/user";
import { getHubSpotUTK, submitToHubSpot } from "../utils/tracking/hubspot";
import { sendEmail } from "../verification/send-verification-email";
import { getPublicIpWithFallback } from "../wss/utils";
import { getTrustedOrigins } from "./trusted-origins";

// Re-export for backward compatibility
export { getTrustedOrigins };

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

const { handler, api } = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: schema,
	}),
	appName: "Dokploy",
	socialProviders: {
		github: {
			clientId: process.env.GITHUB_CLIENT_ID as string,
			clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
		},
		google: {
			clientId: process.env.GOOGLE_CLIENT_ID as string,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
		},
	},
	logger: {
		disabled: process.env.NODE_ENV === "production",
	},
	...(!IS_CLOUD && {
		trustedOrigins: getTrustedOrigins,
	}),
	emailVerification: {
		sendOnSignUp: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({ user, url }) => {
			if (IS_CLOUD) {
				await sendEmail({
					email: user.email,
					subject: "Verify your email",
					text: `
				<p>Click the link to verify your email: <a href="${url}">Verify Email</a></p>
				`,
				});
			}
		},
	},
	emailAndPassword: {
		enabled: true,
		autoSignIn: !IS_CLOUD,
		requireEmailVerification: IS_CLOUD,
		password: {
			async hash(password) {
				return bcrypt.hashSync(password, 10);
			},
			async verify({ hash, password }) {
				return bcrypt.compareSync(password, hash);
			},
		},
		sendResetPassword: async ({ user, url }) => {
			await sendEmail({
				email: user.email,
				subject: "Reset your password",
				text: `
				<p>Click the link to reset your password: <a href="${url}">Reset Password</a></p>
				`,
			});
		},
	},
	databaseHooks: {
		user: {
			create: {
				before: async (_user, context) => {
					if (!IS_CLOUD) {
						const xDokployToken =
							context?.request?.headers?.get("x-dokploy-token");
						if (xDokployToken) {
							const user = await getUserByToken(xDokployToken);
							if (!user) {
								throw new APIError("BAD_REQUEST", {
									message: "User not found",
								});
							}
						} else {
							const isAdminPresent = await db.query.member.findFirst({
								where: eq(schema.member.role, "owner"),
							});
							if (isAdminPresent) {
								throw new APIError("BAD_REQUEST", {
									message: "Admin is already created",
								});
							}
						}
					}
				},
				after: async (user, context) => {
					const isAdminPresent = await db.query.member.findFirst({
						where: eq(schema.member.role, "owner"),
					});

					if (!IS_CLOUD) {
						await updateUser(user.id, {
							serverIp: await getPublicIpWithFallback(),
						});
					}

					console.log(user);

					if (IS_CLOUD) {
						try {
							const hutk = getHubSpotUTK(
								context?.request?.headers?.get("cookie") || undefined,
							);
							// Cast to include additional fields
							const userWithFields = user as typeof user & {
								lastName?: string;
							};
							const hubspotSuccess = await submitToHubSpot(
								{
									email: user.email,
									firstName: user.name || "", // name is mapped to firstName column
									lastName: userWithFields.lastName || "",
								},
								hutk,
							);
							if (!hubspotSuccess) {
								console.error("Failed to submit to HubSpot");
							}
						} catch (error) {
							console.error("Error submitting to HubSpot", error);
						}
					}

					if (IS_CLOUD || !isAdminPresent) {
						await db.transaction(async (tx) => {
							const organization = await tx
								.insert(schema.organization)
								.values({
									name: "My Organization",
									ownerId: user.id,
									createdAt: new Date(),
								})
								.returning()
								.then((res) => res[0]);

							await tx.insert(schema.member).values({
								userId: user.id,
								organizationId: organization?.id || "",
								role: "owner",
								createdAt: new Date(),
								isDefault: true, // Mark first organization as default
							});
						});
					}
				},
			},
		},
		session: {
			create: {
				before: async (session) => {
					// Find the default organization for this user
					// Priority: 1) isDefault=true, 2) most recently created
					const member = await db.query.member.findFirst({
						where: eq(schema.member.userId, session.userId),
						orderBy: [
							desc(schema.member.isDefault),
							desc(schema.member.createdAt),
						],
						with: {
							organization: true,
						},
					});

					return {
						data: {
							...session,
							activeOrganizationId: member?.organization.id,
						},
					};
				},
			},
		},
	},
	session: {
		expiresIn: 60 * 60 * 24 * 3,
		updateAge: 60 * 60 * 24,
	},
	user: {
		modelName: "user",
		fields: {
			name: "firstName", // Map better-auth's default 'name' field to 'firstName' column
		},
		additionalFields: {
			role: {
				type: "string",
				// required: true,
				input: false,
			},
			ownerId: {
				type: "string",
				// required: true,
				input: false,
			},
			allowImpersonation: {
				fieldName: "allowImpersonation",
				type: "boolean",
				defaultValue: false,
			},
			lastName: {
				type: "string",
				required: false,
				input: true,
				defaultValue: "",
			},
		},
	},
	plugins: [
		apiKey({
			enableMetadata: true,
		}),
		twoFactor(),
		organization({
			async sendInvitationEmail(data, _request) {
				if (IS_CLOUD) {
					const host =
						process.env.NODE_ENV === "development"
							? "http://localhost:3000"
							: "https://app.dokploy.com";
					const inviteLink = `${host}/invitation?token=${data.id}`;

					await sendEmail({
						email: data.email,
						subject: "Invitation to join organization",
						text: `
					<p>You are invited to join ${data.organization.name} on Dokploy. Click the link to accept the invitation: <a href="${inviteLink}">Accept Invitation</a></p>
					`,
					});
				}
			},
		}),
		...(IS_CLOUD
			? [
					admin({
						adminUserIds: [process.env.USER_ADMIN_ID as string],
					}),
				]
			: []),
	],
});

export const auth = {
	handler,
	createApiKey: api.createApiKey,
};

export const validateRequest = async (request: IncomingMessage) => {
	const apiKey = request.headers["x-api-key"] as string;
	if (apiKey) {
		try {
			const { valid, key, error } = await api.verifyApiKey({
				body: {
					key: apiKey,
				},
			});

			if (error) {
				throw new Error(error.message || "Error verifying API key");
			}
			if (!valid || !key) {
				return {
					session: null,
					user: null,
				};
			}

			const apiKeyRecord = await db.query.apikey.findFirst({
				where: eq(schema.apikey.id, key.id),
				with: {
					user: true,
				},
			});

			if (!apiKeyRecord) {
				return {
					session: null,
					user: null,
				};
			}

			const organizationId = JSON.parse(
				apiKeyRecord.metadata || "{}",
			).organizationId;

			if (!organizationId) {
				return {
					session: null,
					user: null,
				};
			}

			const member = await db.query.member.findFirst({
				where: and(
					eq(schema.member.userId, apiKeyRecord.user.id),
					eq(schema.member.organizationId, organizationId),
				),
				with: {
					organization: true,
				},
			});

			// When accessing from DB, use actual column names
			const userFromDb = apiKeyRecord.user as typeof apiKeyRecord.user & {
				firstName: string;
				lastName: string;
			};

			const mockSession = {
				session: {
					userId: apiKeyRecord.user.id,
					activeOrganizationId: organizationId || "",
				},
				user: {
					id: userFromDb.id,
					name: userFromDb.firstName, // Map firstName back to name for better-auth
					email: userFromDb.email,
					emailVerified: userFromDb.emailVerified,
					image: userFromDb.image,
					createdAt: userFromDb.createdAt,
					updatedAt: userFromDb.updatedAt,
					twoFactorEnabled: userFromDb.twoFactorEnabled,
					role: member?.role || "member",
					ownerId: member?.organization.ownerId || apiKeyRecord.user.id,
				},
			};

			return mockSession;
		} catch (error) {
			console.error("Error verifying API key", error);
			return {
				session: null,
				user: null,
			};
		}
	}

	// If no API key, proceed with normal session validation
	const session = await api.getSession({
		headers: new Headers({
			cookie: request.headers.cookie || "",
		}),
	});

	if (!session?.session || !session.user) {
		return {
			session: null,
			user: null,
		};
	}

	if (session?.user) {
		const member = await db.query.member.findFirst({
			where: and(
				eq(schema.member.userId, session.user.id),
				eq(
					schema.member.organizationId,
					session.session.activeOrganizationId || "",
				),
			),
			with: {
				organization: true,
			},
		});

		session.user.role = member?.role || "member";
		if (member) {
			session.user.ownerId = member.organization.ownerId;
		} else {
			session.user.ownerId = session.user.id;
		}
	}

	return session;
};
