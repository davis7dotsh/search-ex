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
	it("builds an enriched llms.txt response with links", async () => {
		const llmsText = [
			"# ai_sdk_ex",
			"",
			"## Modules",
			"- AI.Messages - Handles chat",
			"",
			"## Exceptions",
			"- AI.Error",
		].join("\n");
		const fetcher = makeFetchStub({
			"https://hexdocs.pm/ai_sdk_ex/0.1.1/llms.txt": new Response(llmsText, {
				headers: { "content-type": "text/markdown" },
			}),
		});

		const request = new Request(
			"https://wrapper.example/ai_sdk_ex/0.1.1/llms.txt",
		);
		const response = await handleRequest(request, fetcher);
		const body = await response.text();

		expect(body).toContain("Navigation + Discovery Instructions");
		expect(body).toContain(
			"https://wrapper.example/ai_sdk_ex/0.1.1/AI.Messages.html",
		);
		expect(body).toContain(
			"Markdown: https://wrapper.example/ai_sdk_ex/0.1.1/AI.Messages.md",
		);
		expect(body).toContain(
			"https://wrapper.example/ai_sdk_ex/0.1.1/AI.Error.html",
		);
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
});
