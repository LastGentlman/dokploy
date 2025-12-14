import {
	existsSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { readEnvironmentVariables } from "@dokploy/server/services/settings";
import type { User } from "@dokploy/server/services/user";
import { getChallengeType } from "@dokploy/server/setup/traefik-setup";
import { parse, stringify } from "yaml";
import {
	loadOrCreateConfig,
	removeTraefikConfig,
	writeTraefikConfig,
} from "./application";
import type { FileConfig } from "./file-types";
import type { MainTraefikConfig } from "./types";

export const updateServerTraefik = (
	user: User | null,
	newHost: string | null,
) => {
	const { https, certificateType } = user || {};
	const appName = "dokploy";
	const config: FileConfig = loadOrCreateConfig(appName);

	config.http = config.http || { routers: {}, services: {} };
	config.http.routers = config.http.routers || {};
	config.http.services = config.http.services || {};

	const currentRouterConfig = config.http.routers[`${appName}-router-app`] || {
		rule: `Host(\`${newHost}\`)`,
		service: `${appName}-service-app`,
		entryPoints: ["web"],
	};
	config.http.routers[`${appName}-router-app`] = currentRouterConfig;

	config.http.services = {
		...config.http.services,
		[`${appName}-service-app`]: {
			loadBalancer: {
				servers: [
					{
						url: `http://dokploy:${process.env.PORT || 3000}`,
					},
				],
				passHostHeader: true,
			},
		},
	};

	if (https) {
		currentRouterConfig.middlewares = ["redirect-to-https"];

		if (certificateType === "letsencrypt") {
			config.http.routers[`${appName}-router-app-secure`] = {
				rule: `Host(\`${newHost}\`)`,
				service: `${appName}-service-app`,
				entryPoints: ["websecure"],
				tls: { certResolver: "letsencrypt" },
			};
		} else {
			config.http.routers[`${appName}-router-app-secure`] = {
				rule: `Host(\`${newHost}\`)`,
				service: `${appName}-service-app`,
				entryPoints: ["websecure"],
			};
		}
	} else {
		delete config.http.routers[`${appName}-router-app-secure`];
		currentRouterConfig.middlewares = [];
	}

	if (newHost) {
		writeTraefikConfig(config, appName);
	} else {
		removeTraefikConfig(appName);
	}
};

/**
 * Updates Let's Encrypt email while preserving the full certificate resolver configuration
 * Detects challenge type (HTTP or DNS) from Traefik container environment variables
 */
export const updateLetsEncryptEmail = async (
	newEmail: string | null,
	serverId?: string,
) => {
	try {
		if (!newEmail) return;

		// Read current Traefik environment variables to determine challenge type
		let envVars: string[] = [];
		try {
			const envString = await readEnvironmentVariables(
				"dokploy-traefik",
				serverId,
			);
			if (envString) {
				envVars = envString.split("\n").filter((line: string) => line.trim());
			}
		} catch (error) {
			// If we can't read env vars, default to HTTP challenge
			console.warn(
				"Could not read Traefik environment variables, defaulting to HTTP challenge",
				error,
			);
		}

		const challengeType = getChallengeType(envVars);
		const { MAIN_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		const configContent = readFileSync(configPath, "utf8");
		const config = parse(configContent) as MainTraefikConfig;

		// Ensure certificatesResolvers structure exists
		if (!config.certificatesResolvers) {
			config.certificatesResolvers = {};
		}

		if (!config.certificatesResolvers.letsencrypt) {
			config.certificatesResolvers.letsencrypt = {
				acme: {
					email: newEmail,
					storage: "/etc/dokploy/traefik/dynamic/acme.json",
				},
			};
		}

		// Update email and preserve challenge configuration
		if (config.certificatesResolvers.letsencrypt.acme) {
			config.certificatesResolvers.letsencrypt.acme.email = newEmail;

			// Preserve or set challenge type based on environment variables
			if (challengeType === "dns") {
				// Use DNS challenge
				delete config.certificatesResolvers.letsencrypt.acme.httpChallenge;
				config.certificatesResolvers.letsencrypt.acme.dnsChallenge = {
					provider: "cloudflare",
				};
			} else {
				// Use HTTP challenge
				delete config.certificatesResolvers.letsencrypt.acme.dnsChallenge;
				config.certificatesResolvers.letsencrypt.acme.httpChallenge = {
					entryPoint: "web",
				};
			}

			// Ensure storage path is set
			if (!config.certificatesResolvers.letsencrypt.acme.storage) {
				config.certificatesResolvers.letsencrypt.acme.storage =
					"/etc/dokploy/traefik/dynamic/acme.json";
			}
		} else {
			// Create new acme configuration
			config.certificatesResolvers.letsencrypt.acme = {
				email: newEmail,
				storage: "/etc/dokploy/traefik/dynamic/acme.json",
				...(challengeType === "dns"
					? {
							dnsChallenge: {
								provider: "cloudflare",
							},
						}
					: {
							httpChallenge: {
								entryPoint: "web",
							},
						}),
			};
		}

		const newYamlContent = stringify(config);
		writeFileSync(configPath, newYamlContent, "utf8");
	} catch (error) {
		throw error;
	}
};

export const readMainConfig = () => {
	const { MAIN_TRAEFIK_PATH } = paths();
	const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
	if (existsSync(configPath)) {
		const yamlStr = readFileSync(configPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const writeMainConfig = (traefikConfig: string) => {
	try {
		const { MAIN_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		writeFileSync(configPath, traefikConfig, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export interface TlsVerificationDetails {
	websecureHasTls: boolean;
	certResolverConfigured: boolean;
	acmeJsonExists: boolean;
	acmeJsonPermissions: string | null;
	challengeType: "http" | "dns" | "unknown";
	email: string | null;
}

export interface TlsVerificationResult {
	isValid: boolean;
	errors: string[];
	warnings: string[];
	details: TlsVerificationDetails;
}

/**
 * Verifies TLS configuration in Traefik
 * Returns an object with verification results
 */
export const verifyTlsConfiguration = async (
	serverId?: string,
): Promise<TlsVerificationResult> => {
	const errors: string[] = [];
	const warnings: string[] = [];
	const details: TlsVerificationDetails = {
		websecureHasTls: false,
		certResolverConfigured: false,
		acmeJsonExists: false,
		acmeJsonPermissions: null,
		challengeType: "unknown",
		email: null,
	};

	try {
		const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		const acmeJsonPath = join(DYNAMIC_TRAEFIK_PATH, "acme.json");

		// Check if config file exists
		if (!existsSync(configPath)) {
			errors.push("Traefik configuration file not found");
			return { isValid: false, errors, warnings, details };
		}

		// Parse and verify configuration
		const configContent = readFileSync(configPath, "utf8");
		const config = parse(configContent) as MainTraefikConfig;

		// Check websecure entrypoint has TLS
		if (
			config.entryPoints?.websecure?.http?.tls?.certResolver === "letsencrypt"
		) {
			details.websecureHasTls = true;
		} else {
			errors.push(
				"websecure entrypoint does not have TLS configured with letsencrypt certResolver",
			);
		}

		// Check certificate resolver configuration
		if (config.certificatesResolvers?.letsencrypt?.acme) {
			details.certResolverConfigured = true;
			details.email =
				config.certificatesResolvers.letsencrypt.acme.email || null;

			// Determine challenge type
			if (config.certificatesResolvers.letsencrypt.acme.dnsChallenge) {
				details.challengeType = "dns";
				if (
					config.certificatesResolvers.letsencrypt.acme.dnsChallenge
						.provider !== "cloudflare"
				) {
					warnings.push(
						"DNS challenge provider is not 'cloudflare', expected for Cloudflare DNS",
					);
				}
			} else if (config.certificatesResolvers.letsencrypt.acme.httpChallenge) {
				details.challengeType = "http";
			} else {
				warnings.push("No challenge type configured (neither HTTP nor DNS)");
			}
		} else {
			errors.push("Let's Encrypt certificate resolver not configured");
		}

		// Check acme.json file
		if (existsSync(acmeJsonPath)) {
			details.acmeJsonExists = true;
			try {
				const stats = statSync(acmeJsonPath);
				const mode = (stats.mode & 0o777).toString(8);
				details.acmeJsonPermissions = mode;

				// Check permissions (should be 600 for security)
				if (mode !== "600") {
					warnings.push(
						`acme.json permissions are ${mode}, should be 600 for security`,
					);
				}
			} catch (error) {
				warnings.push("Could not read acme.json permissions");
			}
		} else {
			warnings.push(
				"acme.json file does not exist (will be created on first certificate request)",
			);
		}

		// Verify environment variables for DNS challenge if needed
		if (details.challengeType === "dns") {
			try {
				const envString = await readEnvironmentVariables(
					"dokploy-traefik",
					serverId,
				);
				if (envString) {
					const envVars = envString.split("\n");
					const hasCloudflareToken = envVars.some(
						(e: string) =>
							e.includes("CLOUDFLARE_DNS_API_TOKEN") ||
							e.includes("CF_DNS_API_TOKEN"),
					);
					const hasCloudflareEmail = envVars.some(
						(e: string) =>
							e.includes("CLOUDFLARE_EMAIL") || e.includes("CF_API_EMAIL"),
					);
					// #region agent log
					debugLog("web-server.ts:333", "DNS challenge env verification", {
						hasCloudflareToken,
						hasCloudflareEmail,
						envVarCount: envVars.length,
						hasCFToken: envVars.some((e: string) =>
							e.startsWith("CF_DNS_API_TOKEN"),
						),
						hasCFEmail: envVars.some((e: string) =>
							e.startsWith("CF_API_EMAIL"),
						),
						hasCFKey: envVars.some((e: string) => e.startsWith("CF_API_KEY")),
						hasOldToken: envVars.some((e: string) =>
							e.startsWith("CLOUDFLARE_DNS_API_TOKEN"),
						),
						hasOldEmail: envVars.some((e: string) =>
							e.startsWith("CLOUDFLARE_EMAIL"),
						),
						cloudflareVars: envVars
							.filter(
								(e: string) => e.includes("CLOUDFLARE") || e.includes("CF_"),
							)
							.map((e: string) => {
								const parts = e.split("=");
								return {
									key: parts[0] || "",
									hasValue: parts.length > 1 && (parts[1]?.length || 0) > 0,
								};
							}),
					});
					// #endregion

					if (!hasCloudflareToken) {
						errors.push(
							"DNS challenge configured but neither CLOUDFLARE_DNS_API_TOKEN nor CF_DNS_API_TOKEN found in Traefik environment. Please ensure the Cloudflare API token is set and Traefik has been restarted.",
						);
					}
					// Note: CF_API_EMAIL is only needed for API key auth, not for API token auth
					// So we don't require it if CF_DNS_API_TOKEN is present
					if (!hasCloudflareToken && !hasCloudflareEmail) {
						warnings.push(
							"DNS challenge configured but neither CLOUDFLARE_EMAIL/CF_API_EMAIL nor CLOUDFLARE_DNS_API_TOKEN/CF_DNS_API_TOKEN found in Traefik environment",
						);
					}
				} else {
					warnings.push(
						"Could not read Traefik environment variables to verify DNS challenge configuration",
					);
				}
			} catch (error) {
				warnings.push("Could not verify DNS challenge environment variables");
			}
		}

		return {
			isValid: errors.length === 0,
			errors,
			warnings,
			details,
		};
	} catch (error) {
		errors.push(
			`Error verifying TLS configuration: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
		return { isValid: false, errors, warnings, details };
	}
};
