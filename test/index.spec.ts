import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";

const makeFetchStub =
	(routes: Record<string, Response>) => async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		return routes[url] ?? new Response("Not Found", { status: 404 });
	};

describe("hexdocs wrapper worker", () => {
	it("builds an llms.txt index from api-reference and sidebar data", async () => {
		const apiReferenceHtml = [
			"<html>",
			"<head>",
			'<script defer src="dist/sidebar_items-TEST.js"></script>',
			"</head>",
			"<body>",
			'<h2 id="modules">Modules</h2>',
			'<div class="summary">',
			'<div class="summary-row">',
			'<div class="summary-signature"><a href="AI.Messages.html">AI.Messages</a></div>',
			'<div class="summary-synopsis"><p>Handles chat</p></div>',
			"</div>",
			"</div>",
			"</body>",
			"</html>",
		].join("");
		const sidebarItems = [
			"sidebarNodes=",
			JSON.stringify({
				modules: [{ id: "AI.Messages", deprecated: false, group: "" }],
				extras: [{ id: "readme", group: "", title: "README" }],
				tasks: [
					{
						id: "Mix.Tasks.Ecto.Migrate",
						deprecated: false,
						group: "",
						title: "mix ecto.migrate",
						sections: [],
					},
				],
			}),
			";",
		].join("");
		const fetcher = makeFetchStub({
			"https://hexdocs.pm/ai_sdk_ex/0.1.1/api-reference.html": new Response(
				apiReferenceHtml,
				{
					headers: { "content-type": "text/html" },
				},
			),
			"https://hexdocs.pm/ai_sdk_ex/0.1.1/dist/sidebar_items-TEST.js":
				new Response(sidebarItems, {
					headers: { "content-type": "text/javascript" },
				}),
		});

		const request = new Request(
			"https://wrapper.example/ai_sdk_ex/0.1.1/llms.txt",
		);
		const response = await handleRequest(request, fetcher);
		const body = await response.text();

		expect(body).toContain("## Package");
		expect(body).toContain(
			"https://wrapper.example/ai_sdk_ex/0.1.1/AI.Messages.html",
		);
		expect(body).toContain(
			"Markdown: https://wrapper.example/ai_sdk_ex/0.1.1/AI.Messages.md",
		);
		expect(body).toContain("## Guides");
		expect(body).toContain("## Mix Tasks");
	});

	it("uses Copy Markdown link when available and appends related links", async () => {
		const html = [
			"<html>",
			"<body>",
			'<a href="AI.Messages.md">Copy Markdown</a>',
			"</body>",
			"</html>",
		].join("");
		const markdown = "# AI.Messages\n\nSee [AI.Error](AI.Error.html)";
		const fetcher = makeFetchStub({
			"https://hexdocs.pm/ai_sdk_ex/0.1.1/AI.Messages.html": new Response(
				html,
				{
					headers: { "content-type": "text/html" },
				},
			),
			"https://hexdocs.pm/ai_sdk_ex/0.1.1/AI.Messages.md": new Response(
				markdown,
				{
					headers: { "content-type": "text/markdown" },
				},
			),
		});

		const request = new Request(
			"https://wrapper.example/ai_sdk_ex/0.1.1/AI.Messages.html",
		);
		const response = await handleRequest(request, fetcher);
		const body = await response.text();

		expect(body).toContain("# AI.Messages");
		expect(body).toContain("## Related Links");
		expect(body).toContain(
			"https://wrapper.example/ai_sdk_ex/0.1.1/AI.Error.html",
		);
	});

	it("serves a package index.json payload", async () => {
		const apiReferenceHtml = [
			"<html>",
			"<head>",
			'<script defer src="dist/sidebar_items-TEST.js"></script>',
			"</head>",
			"<body>",
			'<h2 id="modules">Modules</h2>',
			'<div class="summary">',
			'<div class="summary-row">',
			'<div class="summary-signature"><a href="AI.Messages.html">AI.Messages</a></div>',
			'<div class="summary-synopsis"><p>Handles chat</p></div>',
			"</div>",
			"</div>",
			"</body>",
			"</html>",
		].join("");
		const sidebarItems = [
			"sidebarNodes=",
			JSON.stringify({
				modules: [{ id: "AI.Messages", deprecated: false, group: "" }],
				extras: [{ id: "readme", group: "", title: "README" }],
				tasks: [],
			}),
			";",
		].join("");
		const fetcher = makeFetchStub({
			"https://hexdocs.pm/ai_sdk_ex/0.1.1/api-reference.html": new Response(
				apiReferenceHtml,
				{
					headers: { "content-type": "text/html" },
				},
			),
			"https://hexdocs.pm/ai_sdk_ex/0.1.1/dist/sidebar_items-TEST.js":
				new Response(sidebarItems, {
					headers: { "content-type": "text/javascript" },
				}),
		});

		const request = new Request(
			"https://wrapper.example/ai_sdk_ex/0.1.1/index.json",
		);
		const response = await handleRequest(request, fetcher);
		const body = await response.json();

		expect(body.package).toBe("ai_sdk_ex");
		expect(body.modules[0].name).toBe("AI.Messages");
		expect(body.guides[0].id).toBe("readme");
	});
});
