import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the database module
const mockFindFirst = vi.fn();
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			member: {
				findFirst: mockFindFirst,
			},
		},
	},
}));

// Mock the schema - use importOriginal to get the real schema structure
vi.mock("@dokploy/server/db/schema", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/db/schema")>();
	return {
		...actual,
	};
});

// Import getTrustedOrigins from the separate module using relative path
import { getTrustedOrigins } from "../../../../packages/server/src/lib/trusted-origins";

describe("getTrustedOrigins", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should always include localhost origins", async () => {
		mockFindFirst.mockResolvedValue(null);

		const origins = await getTrustedOrigins();

		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("http://127.0.0.1:3000");
	});

	it("should include request origin when no admin exists", async () => {
		mockFindFirst.mockResolvedValue(null);

		const request = {
			headers: {
				origin: "https://example.com",
			} as Record<string, string>,
		};

		const origins = await getTrustedOrigins(request);

		expect(origins).toContain("https://example.com");
		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("http://127.0.0.1:3000");
		expect(origins).toContain("http://localhost");
		expect(origins).toContain("http://127.0.0.1");
	});

	it("should include admin-configured serverIp when admin exists", async () => {
		mockFindFirst.mockResolvedValue({
			role: "owner",
			user: {
				serverIp: "192.168.1.100",
				host: null,
			},
		} as any);

		const origins = await getTrustedOrigins();

		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("http://192.168.1.100:3000");
	});

	it("should include admin-configured host when admin exists", async () => {
		mockFindFirst.mockResolvedValue({
			role: "owner",
			user: {
				serverIp: null,
				host: "dokploy.example.com",
			},
		} as any);

		const origins = await getTrustedOrigins();

		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("https://dokploy.example.com");
		expect(origins).toContain("http://dokploy.example.com");
	});

	it("should include both admin config and request origin", async () => {
		mockFindFirst.mockResolvedValue({
			role: "owner",
			user: {
				serverIp: "192.168.1.100",
				host: "dokploy.example.com",
			},
		} as any);

		const request = {
			headers: {
				origin: "https://new-domain.com",
			} as Record<string, string>,
		};

		const origins = await getTrustedOrigins(request);

		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("http://192.168.1.100:3000");
		expect(origins).toContain("https://dokploy.example.com");
		expect(origins).toContain("http://dokploy.example.com");
		expect(origins).toContain("https://new-domain.com");
	});

	it("should handle Headers object from request", async () => {
		mockFindFirst.mockResolvedValue(null);

		const headers = new Headers();
		headers.set("origin", "https://example.com");

		const request = {
			headers,
		};

		const origins = await getTrustedOrigins(request);

		expect(origins).toContain("https://example.com");
	});

	it("should handle referer header when origin is not present", async () => {
		mockFindFirst.mockResolvedValue(null);

		const request = {
			headers: {
				referer: "https://example.com/page",
			} as Record<string, string>,
		};

		const origins = await getTrustedOrigins(request);

		expect(origins).toContain("https://example.com");
	});

	it("should return localhost origins on database error", async () => {
		mockFindFirst.mockRejectedValue(new Error("Database connection failed"));

		const origins = await getTrustedOrigins();

		expect(origins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
	});

	it("should handle invalid origin URLs gracefully", async () => {
		mockFindFirst.mockResolvedValue(null);

		const request = {
			headers: {
				origin: "not-a-valid-url",
			} as Record<string, string>,
		};

		const origins = await getTrustedOrigins(request);

		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("http://127.0.0.1:3000");
		expect(origins).not.toContain("not-a-valid-url");
	});
});
