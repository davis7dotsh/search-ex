const UPSTREAM_ORIGIN = "https://hexdocs.pm";
const YEAR_TTL_SECONDS = 31_536_000;
const HOUR_TTL_SECONDS = 3_600;

const parsePathContext = (pathname: string) => {
	const [packageName, version, ...rest] = pathname.split("/").filter(Boolean);
	return {
		packageName,
		version,
		restPath: rest.join("/"),
	};
};

const isVersionSegment = (version?: string) =>
	Boolean(version && /^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version));

const cacheTtlFor = (version?: string) =>
	isVersionSegment(version) ? YEAR_TTL_SECONDS : HOUR_TTL_SECONDS;

const markdownResponse = (body: string, ttlSeconds: number, status = 200) =>
	new Response(body, {
		status,
		headers: {
			"content-type": "text/markdown; charset=utf-8",
			"cache-control": `public, max-age=${ttlSeconds}${
				ttlSeconds === YEAR_TTL_SECONDS ? ", immutable" : ""
			}`,
		},
	});

const buildInstructionHeader = (
	origin: string,
	packageName: string,
	version: string,
) => {
	const base = `${origin}/${packageName}/${version}`;
	return [
		"## Navigation + Discovery Instructions",
		"Follow only the explicit URL patterns below; do not guess or crawl outside them.",
		"",
		"```agent-navigation",
		`WRAPPER_BASE=${origin}`,
		`PACKAGE=${packageName}`,
		`VERSION=${version}`,
		`MODULE_HTML=${base}/{Module}.html`,
		`MODULE_MD=${base}/{Module}.md`,
		`MODULE_FUNCTIONS=${base}/{Module}.html#summary`,
		`MODULE_TYPES=${base}/{Module}.html#types`,
		`MODULE_CALLBACKS=${base}/{Module}.html#callbacks`,
		`EXCEPTIONS_SOURCE=${base}/llms.txt`,
		`README_HTML=${base}/readme.html`,
		`README_MD=${base}/readme.md`,
		'RELATED_LINKS=See the "Related Links" section at the end of every response.',
		"```",
		"",
		"Steps:",
		`1. OPEN ${base}/llms.txt and read the Modules and Exceptions lists.`,
		`2. For each module, GO TO ${base}/{Module}.html#summary to see functions.`,
		`3. For full details, GO TO ${base}/{Module}.md and scan "Types", "Callbacks", and "Exceptions".`,
		`4. FOLLOW any URLs in the "Related Links" section to continue discovery.`,
	].join("\n");
};

const decodeHtmlEntities = (input: string) =>
	input
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(x?[0-9a-fA-F]+);/g, (_, raw) => {
			const value = raw.startsWith("x")
				? Number.parseInt(raw.slice(1), 16)
				: Number.parseInt(raw, 10);
			return Number.isFinite(value) ? String.fromCharCode(value) : _;
		});

const stripTags = (input: string) =>
	decodeHtmlEntities(input.replace(/<[^>]*>/g, ""));

const htmlToMarkdown = (html: string) => {
	let output = html;
	output = output.replace(/<script[\s\S]*?<\/script>/gi, "");
	output = output.replace(/<style[\s\S]*?<\/style>/gi, "");
	output = output.replace(/<!--[\s\S]*?-->/g, "");
	output = output.replace(
		/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
		(_, code) => `\n\n\`\`\`\n${stripTags(code)}\n\`\`\`\n\n`,
	);
	for (let level = 6; level >= 1; level -= 1) {
		const regex = new RegExp(
			`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`,
			"gi",
		);
		output = output.replace(regex, (_, content) => {
			const text = stripTags(content);
			return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "\n\n";
		});
	}
	output = output.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
		const text = stripTags(content);
		return text ? `\n\n${text}\n\n` : "\n\n";
	});
	output = output.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
		const text = stripTags(content);
		return text ? `\n- ${text}\n` : "\n";
	});
	output = output.replace(/<br\s*\/?>/gi, "\n");
	output = output.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => {
		const text = stripTags(content);
		return text ? `\`${text}\`` : "";
	});
	output = output.replace(
		/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_, href, content) => {
			const text = stripTags(content);
			return text ? `[${text}](${href})` : href;
		},
	);
	output = decodeHtmlEntities(output.replace(/<[^>]+>/g, ""));
	return output.replace(/\n{3,}/g, "\n\n").trim();
};

const resolveRelatedLink = (
	href: string,
	baseUrl: string,
	wrapperOrigin: string,
) => {
	if (!href || href.startsWith("mailto:") || href.startsWith("javascript:")) {
		return null;
	}
	try {
		const resolved = new URL(href, baseUrl);
		if (resolved.host === "hexdocs.pm") {
			return `${wrapperOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
		}
		return resolved.toString();
	} catch {
		return null;
	}
};

const extractRelatedLinks = (
	markdown: string,
	baseUrl: string,
	wrapperOrigin: string,
) => {
	const links = new Set<string>();
	const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
	for (const match of markdown.matchAll(pattern)) {
		const href = match[2]?.trim();
		const resolved = href
			? resolveRelatedLink(href, baseUrl, wrapperOrigin)
			: null;
		if (resolved) {
			links.add(resolved);
		}
	}
	return Array.from(links);
};

const renderRelatedLinks = (links: string[]) => {
	const lines = ["## Related Links"];
	if (!links.length) {
		lines.push("- (none)");
		return lines.join("\n");
	}
	for (const link of links) {
		lines.push(`- ${link}`);
	}
	return lines.join("\n");
};

const findMarkdownUrlFromHtml = (html: string, htmlUrl: URL) => {
	const expected = htmlUrl.pathname.endsWith(".html")
		? htmlUrl.pathname
				.split("/")
				.pop()
				?.replace(/\.html$/i, ".md")
		: undefined;
	const candidates = [
		...html.matchAll(/data-markdown-url=["']([^"']+\.md[^"']*)["']/gi),
		...html.matchAll(/href=["']([^"']+\.md[^"']*)["']/gi),
	].map((match) => match[1]);
	if (!candidates.length && expected) {
		return new URL(expected, htmlUrl).toString();
	}
	const preferred =
		(expected &&
			candidates.find((candidate) => candidate.includes(expected))) ??
		candidates[0];
	return preferred ? new URL(preferred, htmlUrl).toString() : null;
};

const fetchUpstream = (fetcher: typeof fetch, url: URL, ttlSeconds: number) =>
	fetcher(url, {
		cf: {
			cacheTtl: ttlSeconds,
			cacheEverything: true,
		},
	});

const getMarkdownFromPath = async (
	requestUrl: URL,
	fetcher: typeof fetch,
	ttlSeconds: number,
) => {
	const upstreamUrl = new URL(
		`${requestUrl.pathname}${requestUrl.search}`,
		UPSTREAM_ORIGIN,
	);
	if (requestUrl.pathname.endsWith(".md")) {
		const response = await fetchUpstream(fetcher, upstreamUrl, ttlSeconds);
		if (!response.ok) {
			throw new Error(`Upstream markdown fetch failed (${response.status})`);
		}
		return response.text();
	}
	const htmlResponse = await fetchUpstream(fetcher, upstreamUrl, ttlSeconds);
	if (!htmlResponse.ok) {
		throw new Error(`Upstream html fetch failed (${htmlResponse.status})`);
	}
	const html = await htmlResponse.text();
	const markdownUrl = findMarkdownUrlFromHtml(html, upstreamUrl);
	if (markdownUrl) {
		const markdownResponse = await fetchUpstream(
			fetcher,
			new URL(markdownUrl),
			ttlSeconds,
		);
		if (markdownResponse.ok) {
			return markdownResponse.text();
		}
	}
	return htmlToMarkdown(html);
};

const parseLlmsEntry = (line: string) => {
	const content = line.replace(/^-+\s*/, "").trim();
	const linkMatch = content.match(
		/^\[([^\]]+)\]\(([^)]+)\)\s*(?:[-–—]\s*)?(.*)$/,
	);
	if (linkMatch) {
		return {
			name: linkMatch[1].trim(),
			summary: linkMatch[3]?.trim(),
		};
	}
	const separatorMatch = content.match(/^(.*?)(?:\s+[-–—]\s+)(.+)$/);
	if (separatorMatch) {
		return {
			name: separatorMatch[1]?.trim(),
			summary: separatorMatch[2]?.trim(),
		};
	}
	return content ? { name: content, summary: "" } : null;
};

const normalizeEntryName = (name: string) =>
	name
		.replace(/`/g, "")
		.replace(/\.md$/i, "")
		.replace(/\.html$/i, "")
		.trim();

const transformLlmsText = (
	text: string,
	origin: string,
	packageName: string,
	version: string,
) => {
	const base = `${origin}/${packageName}/${version}`;
	const lines = text.split("\n");
	let section: "modules" | "exceptions" | null = null;
	const output: string[] = [];
	for (const line of lines) {
		const headingMatch = line.match(/^#{1,6}\s+(.*)$/);
		if (headingMatch) {
			const heading = headingMatch[1]?.toLowerCase() ?? "";
			if (heading.includes("module")) {
				section = "modules";
			} else if (heading.includes("exception")) {
				section = "exceptions";
			} else {
				section = null;
			}
			output.push(line);
			continue;
		}
		if (line.trim().startsWith("-") && section) {
			const entry = parseLlmsEntry(line);
			if (!entry?.name) {
				output.push(line);
				continue;
			}
			const name = normalizeEntryName(entry.name);
			const htmlUrl = `${base}/${encodeURIComponent(name)}.html`;
			const mdUrl = `${base}/${encodeURIComponent(name)}.md`;
			const summary = entry.summary ? ` — ${entry.summary}` : "";
			output.push(`- [${name}](${htmlUrl})${summary} (Markdown: ${mdUrl})`);
			continue;
		}
		output.push(line);
	}
	return output.join("\n").trim();
};

const buildLlmsReplacement = async (
	requestUrl: URL,
	fetcher: typeof fetch,
	ttlSeconds: number,
) => {
	const { packageName, version } = parsePathContext(requestUrl.pathname);
	const upstreamUrl = new URL(
		`${requestUrl.pathname}${requestUrl.search}`,
		UPSTREAM_ORIGIN,
	);
	const response = await fetchUpstream(fetcher, upstreamUrl, ttlSeconds);
	if (!response.ok) {
		throw new Error(`Upstream llms.txt fetch failed (${response.status})`);
	}
	const upstreamText = await response.text();
	return transformLlmsText(
		upstreamText,
		requestUrl.origin,
		packageName,
		version,
	);
};

export const handleRequest = async (
	request: Request,
	fetcher: typeof fetch = fetch,
) => {
	const url = new URL(request.url);
	const { packageName, version } = parsePathContext(url.pathname);
	if (!packageName || !version) {
		return markdownResponse(
			[
				"## Invalid Request",
				"Expected URL format: /{package}/{version}/{page}.html",
				"Example: /ai_sdk_ex/0.1.1/readme.html",
			].join("\n"),
			HOUR_TTL_SECONDS,
			400,
		);
	}
	const ttlSeconds = cacheTtlFor(version);
	const instructionHeader = buildInstructionHeader(
		url.origin,
		packageName,
		version,
	);
	const isLlms = url.pathname.endsWith("/llms.txt");
	try {
		if (isLlms) {
			const llmsBody = await buildLlmsReplacement(url, fetcher, ttlSeconds);
			const relatedLinks = [
				`${url.origin}/${packageName}/${version}/readme.html`,
				`${url.origin}/${packageName}/${version}/readme.md`,
			];
			const body = [
				instructionHeader,
				"",
				llmsBody,
				"",
				renderRelatedLinks(relatedLinks),
			].join("\n");
			return markdownResponse(body, ttlSeconds);
		}
		const markdown = await getMarkdownFromPath(url, fetcher, ttlSeconds);
		const relatedLinks = extractRelatedLinks(
			markdown,
			url.toString(),
			url.origin,
		);
		const body = [
			instructionHeader,
			"",
			markdown,
			"",
			renderRelatedLinks(relatedLinks),
		].join("\n");
		return markdownResponse(body, ttlSeconds);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return markdownResponse(
			[instructionHeader, "", "## Upstream Error", message].join("\n"),
			HOUR_TTL_SECONDS,
			502,
		);
	}
};

export default {
	fetch: (request: Request, _env: Env, _ctx: ExecutionContext) =>
		handleRequest(request),
} satisfies ExportedHandler<Env>;
