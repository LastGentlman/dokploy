#!/usr/bin/env tsx
/**
 * Domain Diagnostic Script
 * 
 * This script helps diagnose issues with domain access in Dokploy.
 * Run with: pnpm tsx scripts/diagnose-domain.ts <domain>
 * 
 * Example: pnpm tsx scripts/diagnose-domain.ts tooljet.ingroy.com
 * 
 * Note: Make sure DATABASE_URL environment variable is set
 */

import dns from "node:dns";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { parse } from "yaml";

// Get root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

// Initialize database connection
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	console.error("❌ DATABASE_URL environment variable is not set");
	console.error("💡 Set it with: export DATABASE_URL='your-connection-string'");
	process.exit(1);
}

// Initialize database and imports
let db: ReturnType<typeof drizzle>;
let paths: ReturnType<typeof import("../../packages/server/src/constants/index.ts")["paths"]>;
let domains: any;
let applications: any;

async function initializeDatabase() {
	const sql = postgres(connectionString, { max: 1 });

	// Import schema from source files
	const schemaModule = await import(
		`${rootDir}/packages/server/src/db/schema/index.ts`
	);
	const schema = schemaModule;

	// Initialize db with schema
	db = drizzle(sql, { schema });

	// Import paths utility
	const constantsModule = await import(
		`${rootDir}/packages/server/src/constants/index.ts`
	);
	paths = constantsModule.paths;

	// Get schema tables
	domains = schema.domains;
	applications = schema.applications;

	return sql;
}

const resolveDns = promisify(dns.resolve4);

interface DiagnosticResult {
	domain: string;
	checks: {
		dns?: {
			resolved: boolean;
			ips?: string[];
			error?: string;
		};
		database?: {
			found: boolean;
			config?: any;
		};
		traefik?: {
			configExists: boolean;
			config?: any;
		};
		application?: {
			exists: boolean;
			status?: string;
			running?: boolean;
		};
		ssl?: {
			https: boolean;
			certificateType?: string;
		};
	};
}

async function checkDNS(domain: string) {
	try {
		const ips = await resolveDns(domain);
		return {
			resolved: true,
			ips: ips.map((ip) => ip.toString()),
		};
	} catch (error) {
		return {
			resolved: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

async function checkDatabase(domain: string) {
	const domainRecord = await db.query.domains.findFirst({
		where: eq(domains.host, domain),
		with: {
			application: true,
		},
	});

	if (!domainRecord) {
		return { found: false };
	}

	return {
		found: true,
		config: {
			host: domainRecord.host,
			https: domainRecord.https,
			port: domainRecord.port,
			path: domainRecord.path,
			certificateType: domainRecord.certificateType,
			customCertResolver: domainRecord.customCertResolver,
			applicationId: domainRecord.applicationId,
			appName: domainRecord.application?.appName,
		},
	};
}

async function checkTraefikConfig(appName: string, serverId?: string) {
	const { DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const configPath = join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);

	if (!existsSync(configPath)) {
		return { configExists: false };
	}

	try {
		const yamlStr = readFileSync(configPath, "utf8");
		const config = parse(yamlStr);
		return {
			configExists: true,
			config,
		};
	} catch (error) {
		return {
			configExists: true,
			error: error instanceof Error ? error.message : "Failed to parse config",
		};
	}
}

async function checkApplication(applicationId?: string) {
	if (!applicationId) {
		return { exists: false };
	}

	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
	});

	if (!application) {
		return { exists: false };
	}

	return {
		exists: true,
		status: application.applicationStatus,
		running: application.applicationStatus === "done",
	};
}

async function diagnoseDomain(domain: string): Promise<DiagnosticResult> {
	console.log(`\n🔍 Diagnosing domain: ${domain}\n`);
	console.log("=".repeat(60));

	// Remove protocol if present
	const cleanDomain = domain.replace(/^https?:\/\//, "").split("/")[0];

	// Check DNS
	console.log("1️⃣  Checking DNS resolution...");
	const dnsCheck = await checkDNS(cleanDomain);
	if (dnsCheck.resolved) {
		console.log(`   ✅ DNS resolves to: ${dnsCheck.ips?.join(", ")}`);
	} else {
		console.log(`   ❌ DNS resolution failed: ${dnsCheck.error}`);
	}

	// Check Database
	console.log("\n2️⃣  Checking database configuration...");
	const dbCheck = await checkDatabase(cleanDomain);
	if (dbCheck.found) {
		console.log(`   ✅ Domain found in database`);
		console.log(`   📋 Configuration:`, JSON.stringify(dbCheck.config, null, 2));
	} else {
		console.log(`   ❌ Domain not found in database`);
		console.log(`   💡 Tip: Add the domain in Dokploy dashboard first`);
		return {
			domain: cleanDomain,
			checks: {
				dns: dnsCheck,
				database: dbCheck,
			},
		};
	}

	// Check Application
	console.log("\n3️⃣  Checking application status...");
	const appCheck = await checkApplication(dbCheck.config?.applicationId);
	if (appCheck.exists) {
		console.log(`   ✅ Application exists`);
		console.log(`   📊 Status: ${appCheck.status}`);
		console.log(
			`   ${appCheck.running ? "✅" : "❌"} Application is ${appCheck.running ? "running" : "not running"}`,
		);
	} else {
		console.log(`   ❌ Application not found`);
	}

	// Check Traefik Config
	console.log("\n4️⃣  Checking Traefik configuration...");
	const traefikCheck = await checkTraefikConfig(dbCheck.config?.appName);
	if (traefikCheck.configExists) {
		console.log(`   ✅ Traefik config file exists`);
		if (traefikCheck.config) {
			const routers = traefikCheck.config?.http?.routers || {};
			const routerCount = Object.keys(routers).length;
			console.log(`   📋 Found ${routerCount} router(s) in config`);

			// Check if domain is in router rules
			const domainInRules = Object.values(routers).some(
				(router: any) => router.rule?.includes(cleanDomain),
			);
			console.log(
				`   ${domainInRules ? "✅" : "❌"} Domain found in router rules: ${domainInRules}`,
			);
		}
	} else {
		console.log(`   ❌ Traefik config file not found`);
		console.log(
			`   💡 Tip: The domain may need to be re-added or the application redeployed`,
		);
	}

	// Check SSL
	console.log("\n5️⃣  Checking SSL configuration...");
	const sslCheck = {
		https: dbCheck.config?.https || false,
		certificateType: dbCheck.config?.certificateType || "none",
	};
	console.log(`   ${sslCheck.https ? "✅" : "❌"} HTTPS enabled: ${sslCheck.https}`);
	console.log(`   📋 Certificate type: ${sslCheck.certificateType}`);
	if (sslCheck.https && sslCheck.certificateType === "letsencrypt") {
		console.log(`   💡 Let's Encrypt certificate should auto-provision`);
		console.log(`   💡 Check Traefik logs if certificate is not working`);
	}

	// Summary
	console.log("\n" + "=".repeat(60));
	console.log("📊 SUMMARY\n");

	const issues: string[] = [];
	if (!dnsCheck.resolved) {
		issues.push("❌ DNS not resolving - check DNS records");
	}
	if (!dbCheck.found) {
		issues.push("❌ Domain not configured in Dokploy");
	}
	if (!appCheck.exists || !appCheck.running) {
		issues.push("❌ Application not running - deploy the application");
	}
	if (!traefikCheck.configExists) {
		issues.push("❌ Traefik config missing - re-add domain or redeploy");
	}
	if (sslCheck.https && sslCheck.certificateType === "letsencrypt") {
		issues.push("⚠️  Let's Encrypt may take a few minutes to provision");
	}

	if (issues.length === 0) {
		console.log("✅ All checks passed! Domain should be accessible.");
		console.log(
			`\n🌐 Try accessing: ${sslCheck.https ? "https" : "http"}://${cleanDomain}`,
		);
	} else {
		console.log("⚠️  Issues found:\n");
		issues.forEach((issue) => console.log(`   ${issue}`));
	}

	return {
		domain: cleanDomain,
		checks: {
			dns: dnsCheck,
			database: dbCheck,
			traefik: traefikCheck,
			application: appCheck,
			ssl: sslCheck,
		},
	};
}

// Main execution
async function main() {
	const domain = process.argv[2];

	if (!domain) {
		console.error("❌ Please provide a domain name");
		console.error("Usage: pnpm tsx scripts/diagnose-domain.ts <domain>");
		console.error("Example: pnpm tsx scripts/diagnose-domain.ts tooljet.ingroy.com");
		process.exit(1);
	}

	try {
		const sql = await initializeDatabase();
		await diagnoseDomain(domain);
		await sql.end();
		console.log("\n✅ Diagnosis complete\n");
		process.exit(0);
	} catch (error) {
		console.error("\n❌ Error during diagnosis:", error);
		process.exit(1);
	}
}

main();
