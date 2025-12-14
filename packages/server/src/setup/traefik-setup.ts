import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ContainerCreateOptions, CreateServiceOptions } from "dockerode";
import { stringify } from "yaml";
import { paths } from "../constants";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import type { FileConfig } from "../utils/traefik/file-types";
import type { MainTraefikConfig } from "../utils/traefik/types";

const DEBUG_LOG_PATH = "/home/rodry/Desktop/dokploy/.cursor/debug.log";

const debugLog = (location: string, message: string, data: unknown) => {
	try {
		const logEntry = JSON.stringify({
			location,
			message,
			data,
			timestamp: Date.now(),
			sessionId: "debug-session",
		}) + "\n";
		appendFileSync(DEBUG_LOG_PATH, logEntry, "utf8");
	} catch (error) {
		// Silently fail if logging doesn't work
	}
};

export const TRAEFIK_SSL_PORT =
	Number.parseInt(process.env.TRAEFIK_SSL_PORT!, 10) || 443;
export const TRAEFIK_PORT =
	Number.parseInt(process.env.TRAEFIK_PORT!, 10) || 80;
export const TRAEFIK_HTTP3_PORT =
	Number.parseInt(process.env.TRAEFIK_HTTP3_PORT!, 10) || 443;
export const TRAEFIK_VERSION = process.env.TRAEFIK_VERSION || "3.6.1";

export interface TraefikOptions {
	env?: string[];
	serverId?: string;
	additionalPorts?: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[];
}

export const initializeStandaloneTraefik = async ({
	env,
	serverId,
	additionalPorts = [],
}: TraefikOptions = {}) => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const imageName = `traefik:v${TRAEFIK_VERSION}`;
	const containerName = "dokploy-traefik";

	const exposedPorts: Record<string, {}> = {
		[`${TRAEFIK_PORT}/tcp`]: {},
		[`${TRAEFIK_SSL_PORT}/tcp`]: {},
		[`${TRAEFIK_HTTP3_PORT}/udp`]: {},
	};

	const portBindings: Record<string, Array<{ HostPort: string }>> = {
		[`${TRAEFIK_PORT}/tcp`]: [{ HostPort: TRAEFIK_PORT.toString() }],
		[`${TRAEFIK_SSL_PORT}/tcp`]: [{ HostPort: TRAEFIK_SSL_PORT.toString() }],
		[`${TRAEFIK_HTTP3_PORT}/udp`]: [
			{ HostPort: TRAEFIK_HTTP3_PORT.toString() },
		],
	};

	const enableDashboard = additionalPorts.some(
		(port) => port.targetPort === 8080,
	);

	if (enableDashboard) {
		exposedPorts["8080/tcp"] = {};
		portBindings["8080/tcp"] = [{ HostPort: "8080" }];
	}

	for (const port of additionalPorts) {
		const portKey = `${port.targetPort}/${port.protocol ?? "tcp"}`;
		exposedPorts[portKey] = {};
		portBindings[portKey] = [{ HostPort: port.publishedPort.toString() }];
	}

	// Map Cloudflare environment variables to Traefik's expected format
	const mappedEnv = mapCloudflareEnvVars(env);
	debugLog("traefik-setup.ts:93", "Mapping Cloudflare env vars", {
		originalCount: env?.length || 0,
		mappedCount: mappedEnv.length,
		hasCFToken: mappedEnv.some((e) => e.startsWith("CF_DNS_API_TOKEN")),
		hasCFEmail: mappedEnv.some((e) => e.startsWith("CF_API_EMAIL")),
		hasCFKey: mappedEnv.some((e) => e.startsWith("CF_API_KEY")),
		hasOldToken: env?.some((e) => e.startsWith("CLOUDFLARE_DNS_API_TOKEN")),
		hasOldEmail: env?.some((e) => e.startsWith("CLOUDFLARE_EMAIL")),
	});

	const settings: ContainerCreateOptions = {
		name: containerName,
		Image: imageName,
		NetworkingConfig: {
			EndpointsConfig: {
				"dokploy-network": {},
			},
		},
		ExposedPorts: exposedPorts,
		HostConfig: {
			RestartPolicy: {
				Name: "always",
			},
			Binds: [
				`${MAIN_TRAEFIK_PATH}/traefik.yml:/etc/traefik/traefik.yml`,
				`${DYNAMIC_TRAEFIK_PATH}:/etc/dokploy/traefik/dynamic`,
				"/var/run/docker.sock:/var/run/docker.sock",
			],
			PortBindings: portBindings,
		},
		Env: mappedEnv,
	};

	const docker = await getRemoteDocker(serverId);
	try {
		await docker.pull(imageName);
		await new Promise((resolve) => setTimeout(resolve, 3000));
		console.log("Traefik Image Pulled ✅");
	} catch (error) {
		console.log("Traefik Image Not Found: Pulling ", error);
	}
	try {
		const container = docker.getContainer(containerName);
		await container.remove({ force: true });
		await new Promise((resolve) => setTimeout(resolve, 5000));
	} catch {}

	try {
		await docker.createContainer(settings);
		const newContainer = docker.getContainer(containerName);
		await newContainer.start();
		console.log("Traefik Started ✅");
	} catch (error) {
		console.log("Traefik Not Found: Starting ", error);
	}
};

export const initializeTraefikService = async ({
	env,
	additionalPorts = [],
	serverId,
}: TraefikOptions) => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const imageName = `traefik:v${TRAEFIK_VERSION}`;
	const appName = "dokploy-traefik";

	// Map Cloudflare environment variables to Traefik's expected format
	const mappedEnv = mapCloudflareEnvVars(env);
	debugLog("traefik-setup.ts:134", "Mapping Cloudflare env vars for service", {
		originalCount: env?.length || 0,
		mappedCount: mappedEnv.length,
		hasCFToken: mappedEnv.some((e) => e.startsWith("CF_DNS_API_TOKEN")),
		hasCFEmail: mappedEnv.some((e) => e.startsWith("CF_API_EMAIL")),
		hasCFKey: mappedEnv.some((e) => e.startsWith("CF_API_KEY")),
		hasOldToken: env?.some((e) => e.startsWith("CLOUDFLARE_DNS_API_TOKEN")),
		hasOldEmail: env?.some((e) => e.startsWith("CLOUDFLARE_EMAIL")),
	});

	const settings: CreateServiceOptions = {
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: mappedEnv,
				Mounts: [
					{
						Type: "bind",
						Source: `${MAIN_TRAEFIK_PATH}/traefik.yml`,
						Target: "/etc/traefik/traefik.yml",
					},
					{
						Type: "bind",
						Source: DYNAMIC_TRAEFIK_PATH,
						Target: "/etc/dokploy/traefik/dynamic",
					},
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
					},
				],
			},
			Networks: [{ Target: "dokploy-network" }],
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
		EndpointSpec: {
			Ports: [
				{
					TargetPort: 443,
					PublishedPort: TRAEFIK_SSL_PORT,
					PublishMode: "host",
					Protocol: "tcp",
				},
				{
					TargetPort: 443,
					PublishedPort: TRAEFIK_SSL_PORT,
					PublishMode: "host",
					Protocol: "udp",
				},
				{
					TargetPort: 80,
					PublishedPort: TRAEFIK_PORT,
					PublishMode: "host",
					Protocol: "tcp",
				},

				...additionalPorts.map((port) => ({
					TargetPort: port.targetPort,
					PublishedPort: port.publishedPort,
					Protocol: port.protocol as "tcp" | "udp" | "sctp" | undefined,
					PublishMode: "host" as const,
				})),
			],
		},
	};
	const docker = await getRemoteDocker(serverId);
	try {
		const service = docker.getService(appName);
		const inspect = await service.inspect();

		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
			},
		});
		console.log("Traefik Updated ✅");
	} catch {
		await docker.createService(settings);
		console.log("Traefik Started ✅");
	}
};

export const createDefaultServerTraefikConfig = () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configFilePath = path.join(DYNAMIC_TRAEFIK_PATH, "dokploy.yml");

	if (existsSync(configFilePath)) {
		console.log("Default traefik config already exists");
		return;
	}

	const appName = "dokploy";
	const serviceURLDefault = `http://${appName}:${process.env.PORT || 3000}`;
	const config: FileConfig = {
		http: {
			routers: {
				[`${appName}-router-app`]: {
					rule: `Host(\`${appName}.docker.localhost\`) && PathPrefix(\`/\`)`,
					service: `${appName}-service-app`,
					entryPoints: ["web"],
				},
			},
			services: {
				[`${appName}-service-app`]: {
					loadBalancer: {
						servers: [{ url: serviceURLDefault }],
						passHostHeader: true,
					},
				},
			},
		},
	};

	const yamlStr = stringify(config);
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(
		path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`),
		yamlStr,
		"utf8",
	);
};

/**
 * Maps Cloudflare environment variables to Traefik's expected format
 * Traefik's Cloudflare provider expects CF_DNS_API_TOKEN or CF_API_EMAIL/CF_API_KEY
 * but users may set CLOUDFLARE_DNS_API_TOKEN or CLOUDFLARE_EMAIL/CLOUDFLARE_API_KEY
 *
 * This function:
 * 1. Preserves existing CF_* vars if they're already set (preferred)
 * 2. Maps CLOUDFLARE_* vars to CF_* format only if CF_* version doesn't exist
 * 3. Removes old CLOUDFLARE_* vars to avoid duplicates
 */
const mapCloudflareEnvVars = (env?: string[]): string[] => {
	if (!env) return [];

	const mapped: string[] = [];
	const keysToSkip = new Set<string>();
	const hasCFToken = env.some((e) => e.startsWith("CF_DNS_API_TOKEN="));
	const hasCFEmail = env.some((e) => e.startsWith("CF_API_EMAIL="));
	const hasCFKey = env.some((e) => e.startsWith("CF_API_KEY="));

	// First pass: map CLOUDFLARE_* to CF_* only if CF_* version doesn't exist
	for (const envVar of env) {
		// Map CLOUDFLARE_DNS_API_TOKEN to CF_DNS_API_TOKEN (only if CF_DNS_API_TOKEN doesn't exist)
		if (envVar.startsWith("CLOUDFLARE_DNS_API_TOKEN=") && !hasCFToken) {
			const value = envVar.split("=").slice(1).join("=");
			mapped.push(`CF_DNS_API_TOKEN=${value}`);
			keysToSkip.add("CLOUDFLARE_DNS_API_TOKEN");
		}
		// Map CLOUDFLARE_EMAIL to CF_API_EMAIL (only if CF_API_EMAIL doesn't exist)
		else if (envVar.startsWith("CLOUDFLARE_EMAIL=") && !hasCFEmail) {
			const value = envVar.split("=").slice(1).join("=");
			mapped.push(`CF_API_EMAIL=${value}`);
			keysToSkip.add("CLOUDFLARE_EMAIL");
		}
		// Map CLOUDFLARE_API_KEY to CF_API_KEY (only if CF_API_KEY doesn't exist)
		else if (envVar.startsWith("CLOUDFLARE_API_KEY=") && !hasCFKey) {
			const value = envVar.split("=").slice(1).join("=");
			mapped.push(`CF_API_KEY=${value}`);
			keysToSkip.add("CLOUDFLARE_API_KEY");
		}
		// Always skip CLOUDFLARE_* vars if CF_* version exists
		else if (envVar.startsWith("CLOUDFLARE_DNS_API_TOKEN=") && hasCFToken) {
			keysToSkip.add("CLOUDFLARE_DNS_API_TOKEN");
		} else if (envVar.startsWith("CLOUDFLARE_EMAIL=") && hasCFEmail) {
			keysToSkip.add("CLOUDFLARE_EMAIL");
		} else if (envVar.startsWith("CLOUDFLARE_API_KEY=") && hasCFKey) {
			keysToSkip.add("CLOUDFLARE_API_KEY");
		}
	}

	// Second pass: add all other env vars, skipping ones we've already mapped
	for (const envVar of env) {
		const key = envVar.split("=")[0];
		if (key && !keysToSkip.has(key)) {
			mapped.push(envVar);
		}
	}

	return mapped;
};

/**
 * Detects the challenge type based on environment variables
 * Returns 'dns' if Cloudflare DNS API token is present, otherwise 'http'
 * Checks for both CLOUDFLARE_* and CF_* formats
 */
const getChallengeType = (env?: string[]): "http" | "dns" => {
	if (!env) return "http";
	const hasCloudflare = env.some(
		(e) =>
			e.includes("CLOUDFLARE_DNS_API_TOKEN") ||
			e.includes("CLOUDFLARE_EMAIL") ||
			e.includes("CF_DNS_API_TOKEN") ||
			e.includes("CF_API_EMAIL"),
	);
	return hasCloudflare ? "dns" : "http";
};

/**
 * Gets the Let's Encrypt email from environment variables or returns default
 * Checks for both CLOUDFLARE_EMAIL and CF_API_EMAIL formats
 */
const getLetsEncryptEmail = (env?: string[]): string => {
	if (!env) return "test@localhost.com";
	// Check for CLOUDFLARE_EMAIL first (legacy format)
	let emailVar = env.find((e) => e.startsWith("CLOUDFLARE_EMAIL="));
	if (emailVar) {
		return emailVar.split("=").slice(1).join("=") || "test@localhost.com";
	}
	// Check for CF_API_EMAIL (Traefik format)
	emailVar = env.find((e) => e.startsWith("CF_API_EMAIL="));
	if (emailVar) {
		return emailVar.split("=").slice(1).join("=") || "test@localhost.com";
	}
	return "test@localhost.com";
};

export const getDefaultTraefikConfig = (env?: string[]) => {
	const challengeType = getChallengeType(env);
	const email = getLetsEncryptEmail(env);

	const configObject: MainTraefikConfig = {
		global: {
			sendAnonymousUsage: false,
		},
		providers: {
			...(process.env.NODE_ENV === "development"
				? {
						docker: {
							defaultRule:
								"Host(`{{ trimPrefix `/` .Name }}.docker.localhost`)",
						},
					}
				: {
						swarm: {
							exposedByDefault: false,
							watch: true,
						},
						docker: {
							exposedByDefault: false,
							watch: true,
							network: "dokploy-network",
						},
					}),
			file: {
				directory: "/etc/dokploy/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				http3: {
					advertisedPort: TRAEFIK_HTTP3_PORT,
				},
				http: {
					tls: {
						certResolver: "letsencrypt",
					},
				},
			},
		},
		api: {
			insecure: true,
		},
		certificatesResolvers: {
			letsencrypt: {
				acme: {
					email: email,
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
				},
			},
		},
	};

	const yamlStr = stringify(configObject);

	return yamlStr;
};

export const getDefaultServerTraefikConfig = (env?: string[]) => {
	const challengeType = getChallengeType(env);
	const email = getLetsEncryptEmail(env);

	const configObject: MainTraefikConfig = {
		providers: {
			swarm: {
				exposedByDefault: false,
				watch: true,
			},
			docker: {
				exposedByDefault: false,
				watch: true,
				network: "dokploy-network",
			},
			file: {
				directory: "/etc/dokploy/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				http3: {
					advertisedPort: TRAEFIK_HTTP3_PORT,
				},
				http: {
					tls: {
						certResolver: "letsencrypt",
					},
				},
			},
		},
		api: {
			insecure: true,
		},
		certificatesResolvers: {
			letsencrypt: {
				acme: {
					email: email,
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
				},
			},
		},
	};

	const yamlStr = stringify(configObject);

	return yamlStr;
};

export const createDefaultTraefikConfig = () => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths();
	const mainConfig = path.join(MAIN_TRAEFIK_PATH, "traefik.yml");
	const acmeJsonPath = path.join(DYNAMIC_TRAEFIK_PATH, "acme.json");

	if (existsSync(acmeJsonPath)) {
		chmodSync(acmeJsonPath, "600");
	}

	// Create the traefik directory first
	mkdirSync(MAIN_TRAEFIK_PATH, { recursive: true });

	// Check if traefik.yml exists and handle the case where it might be a directory
	if (existsSync(mainConfig)) {
		const stats = statSync(mainConfig);
		if (stats.isDirectory()) {
			// If traefik.yml is a directory, remove it
			console.log("Found traefik.yml as directory, removing it...");
			rmSync(mainConfig, { recursive: true, force: true });
		} else if (stats.isFile()) {
			console.log("Main config already exists");
			return;
		}
	}

	const yamlStr = getDefaultTraefikConfig();
	writeFileSync(mainConfig, yamlStr, "utf8");
	console.log("Traefik config created successfully");
};

// Export helper functions for use in other modules
export { getChallengeType, getLetsEncryptEmail };

export const getDefaultMiddlewares = () => {
	const defaultMiddlewares = {
		http: {
			middlewares: {
				"redirect-to-https": {
					redirectScheme: {
						scheme: "https",
						permanent: true,
					},
				},
			},
		},
	};
	const yamlStr = stringify(defaultMiddlewares);
	return yamlStr;
};
export const createDefaultMiddlewares = () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const middlewaresPath = path.join(DYNAMIC_TRAEFIK_PATH, "middlewares.yml");
	if (existsSync(middlewaresPath)) {
		console.log("Default middlewares already exists");
		return;
	}
	const yamlStr = getDefaultMiddlewares();
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(middlewaresPath, yamlStr, "utf8");
};
