const UPSTREAM_ORIGIN = "https://hexdocs.pm";
const YEAR_TTL_SECONDS = 31_536_000;
const HOUR_TTL_SECONDS = 3_600;

type OptionEntry = {
	key: string;
	required: boolean;
	type: string;
};

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
			"cache-control": `public, max-age=${ttlSeconds}${ttlSeconds === YEAR_TTL_SECONDS ? ", immutable" : ""}`,
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
		"Use the URL patterns below as a shortcut for navigation. Explore as needed; these are hints, not constraints.",
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
		"Steps (optional):",
		`1. START with the current page and follow what looks relevant.`,
		`2. USE the "Related Pages" section to hop to nearby modules when helpful.`,
		`3. OPEN ${base}/llms.txt when you want a full module/exception index.`,
		`4. For function lists, GO TO ${base}/{Module}.html#summary.`,
		`5. For full details, GO TO ${base}/{Module}.md and scan "Types", "Callbacks", and "Exceptions".`,
		`6. FOLLOW any URLs in the "Related Links" section to continue discovery.`,
	].join("\n");
};

const buildSourceSection = (pageUrl: URL) => {
	const path = pageUrl.pathname;
	if (!path.endsWith(".html") && !path.endsWith(".md")) {
		return null;
	}
	const htmlPath = path.endsWith(".html")
		? path
		: path.replace(/\.md$/i, ".html");
	const mdPath = path.endsWith(".md") ? path : path.replace(/\.html$/i, ".md");
	return [
		"## Source URLs",
		`- HTML: ${pageUrl.origin}${htmlPath}`,
		`- Markdown: ${pageUrl.origin}${mdPath}`,
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

const normalizeLinkTarget = (
	href: string,
	baseUrl: string,
	wrapperOrigin: string,
) => {
	if (
		!href ||
		href.startsWith("#") ||
		href.startsWith("mailto:") ||
		href.startsWith("javascript:")
	) {
		return href;
	}
	try {
		const resolved = new URL(href, baseUrl);
		if (resolved.host === "hexdocs.pm") {
			return `${wrapperOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
		}
		return resolved.toString();
	} catch {
		return href;
	}
};

const rewriteMarkdownLinks = (
	markdown: string,
	baseUrl: string,
	wrapperOrigin: string,
) =>
	markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
		const normalized = normalizeLinkTarget(href.trim(), baseUrl, wrapperOrigin);
		return normalized ? `[${label}](${normalized})` : match;
	});

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

const extractHtmlCodeBlocks = (html: string) => {
	const blocks: { language?: string; code: string }[] = [];
	for (const match of html.matchAll(
		/<pre[^>]*><code([^>]*)>([\s\S]*?)<\/code><\/pre>/gi,
	)) {
		const attrs = match[1] ?? "";
		const rawCode = match[2] ?? "";
		const classMatch = attrs.match(/class=["']([^"']+)["']/i);
		const classes = classMatch?.[1]?.split(/\s+/) ?? [];
		const language =
			classes
				.find((value) => value.startsWith("language-"))
				?.replace("language-", "") ??
			classes.find((value) => value && value !== "highlight");
		blocks.push({
			language,
			code: stripTags(rawCode).trim(),
		});
	}
	const unique = new Map<string, { language?: string; code: string }>();
	for (const block of blocks) {
		if (block.code) {
			unique.set(`${block.language ?? "text"}:${block.code}`, block);
		}
	}
	return Array.from(unique.values());
};

const appendCodeBlocks = (
	markdown: string,
	blocks: { language?: string; code: string }[],
) => {
	if (!blocks.length) {
		return markdown;
	}
	const lines = ["## Code Blocks"];
	for (const block of blocks) {
		const fence = `\`\`\`${block.language ?? ""}`.trimEnd();
		lines.push([fence, block.code, "```"].join("\n"));
	}
	return [markdown, "", lines.join("\n\n")].join("\n");
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

const extractModuleName = (markdown: string) => {
	const headingMatch = markdown.match(/^#\s+`?([^`]+)`?/m);
	return headingMatch?.[1]?.trim() ?? null;
};

const extractModuleReferences = (
	markdown: string,
	typeOptions: Map<string, OptionEntry[]>,
) => {
	const modulePattern =
		/\b(AI(?:\.[A-Za-z0-9_]+)+|AiSdkEx(?:\.[A-Za-z0-9_]+)+)\b/g;
	const modules = new Set<string>();
	for (const match of markdown.matchAll(modulePattern)) {
		modules.add(match[1]);
	}
	for (const options of typeOptions.values()) {
		for (const option of options) {
			for (const match of option.type.matchAll(modulePattern)) {
				modules.add(match[1]);
			}
		}
	}
	return Array.from(modules);
};

const renderRelatedPages = (
	pages: string[],
	origin: string,
	packageName: string,
	version: string,
) => {
	if (!pages.length) {
		return null;
	}
	const lines = ["## Related Pages"];
	for (const page of pages) {
		lines.push(`- ${origin}/${packageName}/${version}/${page}.html`);
	}
	return lines.join("\n");
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
		const htmlUrl = new URL(
			requestUrl.pathname.replace(/\.md$/i, ".html"),
			UPSTREAM_ORIGIN,
		);
		const response = await fetchUpstream(fetcher, upstreamUrl, ttlSeconds);
		if (!response.ok) {
			throw new Error(`Upstream markdown fetch failed (${response.status})`);
		}
		const markdown = await response.text();
		const htmlResponse = await fetchUpstream(fetcher, htmlUrl, ttlSeconds);
		if (!htmlResponse.ok) {
			return markdown;
		}
		const html = await htmlResponse.text();
		return appendCodeBlocks(markdown, extractHtmlCodeBlocks(html));
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
			const markdown = await markdownResponse.text();
			return appendCodeBlocks(markdown, extractHtmlCodeBlocks(html));
		}
	}
	return appendCodeBlocks(htmlToMarkdown(html), extractHtmlCodeBlocks(html));
};

const parseLlmsEntry = (line: string) => {
	const content = line.replace(/^-+\s*/, "").trim();
	const linkMatch = content.match(
		/^\[([^\]]+)\]\(([^)]+)\)\s*(?:[:\-–—]\s*)?(.*)$/,
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
	if (!content) {
		return null;
	}
	if (content.includes("[") && content.includes("](")) {
		return null;
	}
	return { name: content, summary: "" };
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
		const trimmed = line.trim();
		if (/^-\s+exceptions\b/i.test(trimmed)) {
			section = "exceptions";
			output.push("## Exceptions");
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

const parseOptionLine = (line: string) => {
	const trimmed = line.replace(/,\s*$/, "").trim();
	if (!trimmed) {
		return null;
	}
	const optionalMatch = trimmed.match(/^optional\(\s*:(\w+)\s*\)\s*=>\s*(.+)$/);
	if (optionalMatch) {
		return {
			key: `:${optionalMatch[1]}`,
			required: false,
			type: optionalMatch[2].trim(),
		};
	}
	const requiredArrowMatch = trimmed.match(/^:(\w+)\s*=>\s*(.+)$/);
	if (requiredArrowMatch) {
		return {
			key: `:${requiredArrowMatch[1]}`,
			required: true,
			type: requiredArrowMatch[2].trim(),
		};
	}
	const requiredColonMatch = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
	if (requiredColonMatch) {
		return {
			key: `:${requiredColonMatch[1]}`,
			required: true,
			type: requiredColonMatch[2].trim(),
		};
	}
	return null;
};

const parseMapOptions = (lines: string[]) =>
	lines
		.map((line) => (line.split("#")[0] ?? "").trim())
		.map(parseOptionLine)
		.filter((entry): entry is OptionEntry => Boolean(entry));

const extractCodeBlocks = (markdown: string) => {
	const blocks: string[] = [];
	for (const match of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
		blocks.push(match[1]);
	}
	return blocks;
};

const parseTypeOptions = (markdown: string) => {
	const optionsByType = new Map<string, OptionEntry[]>();
	for (const block of extractCodeBlocks(markdown)) {
		const lines = block.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			const typeMatch = line.match(
				/@type\s+([A-Za-z0-9_]+)\(\)\s*::\s*%{\s*(.*)$/,
			);
			if (!typeMatch) {
				continue;
			}
			const typeName = typeMatch[1];
			const inline = typeMatch[2] ?? "";
			const mapLines: string[] = [];
			if (inline.includes("}")) {
				mapLines.push(inline.split("}")[0]);
			} else {
				if (inline.trim()) {
					mapLines.push(inline);
				}
				for (let j = i + 1; j < lines.length; j += 1) {
					const mapLine = lines[j];
					if (mapLine.includes("}")) {
						mapLines.push(mapLine.split("}")[0]);
						i = j;
						break;
					}
					mapLines.push(mapLine);
				}
			}
			const options = parseMapOptions(mapLines);
			if (options.length) {
				optionsByType.set(typeName, options);
			}
		}
	}
	return optionsByType;
};

const parseTypeNames = (markdown: string) => {
	const names = new Set<string>();
	for (const block of extractCodeBlocks(markdown)) {
		for (const line of block.split("\n")) {
			const match = line.match(/@type\s+([A-Za-z0-9_]+)\(\)/);
			if (match) {
				names.add(match[1]);
			}
		}
	}
	return names;
};

const parseSpecs = (markdown: string) => {
	const specs = new Map<string, { spec: string; optsType?: string }>();
	for (const block of extractCodeBlocks(markdown)) {
		const lines = block.split("\n");
		for (const line of lines) {
			const match = line.match(/@spec\s+([a-zA-Z0-9_!?]+)\(([^)]*)\)/);
			if (!match) {
				continue;
			}
			const fnName = match[1];
			const args = match[2];
			const optsMatch = args.match(/([A-Za-z0-9_]+_opts)\(\)/);
			specs.set(fnName, { spec: line.trim(), optsType: optsMatch?.[1] });
		}
	}
	return specs;
};

const parseCallbacks = (markdown: string) => {
	const callbacks = new Set<string>();
	for (const block of extractCodeBlocks(markdown)) {
		for (const line of block.split("\n")) {
			const match = line.match(/@callback\s+([A-Za-z0-9_!?]+)\(/);
			if (match) {
				callbacks.add(match[1]);
			}
		}
	}
	return callbacks;
};

const insertSectionHeadings = (
	markdown: string,
	typeNames: Set<string>,
	callbackNames: Set<string>,
) => {
	const lines = markdown.split("\n");
	const output: string[] = [];
	let typesInserted = false;
	let callbacksInserted = false;
	let exceptionsInserted = false;
	for (const line of lines) {
		const headingMatch = line.match(/^#{1,6}\s+`?([^`]+)`?/);
		if (headingMatch) {
			const title = headingMatch[1]?.trim();
			if (title && typeNames.has(title) && !typesInserted) {
				output.push("## Types", "");
				typesInserted = true;
			}
			if (title && callbackNames.has(title) && !callbacksInserted) {
				output.push("## Callbacks", "");
				callbacksInserted = true;
			}
			if (title && !exceptionsInserted && /(Error|Exception)/.test(title)) {
				output.push("## Exceptions", "");
				exceptionsInserted = true;
			}
		}
		output.push(line);
	}
	return output.join("\n");
};

const buildOptionsTable = (options: OptionEntry[]) => {
	const sorted = [...options].sort(
		(a, b) => Number(b.required) - Number(a.required),
	);
	const lines = [
		"## Options",
		"| Key | Required | Type |",
		"| --- | --- | --- |",
		...sorted.map(
			(option) =>
				`| ${option.key} | ${option.required ? "yes" : "no"} | ${option.type} |`,
		),
	];
	return lines.join("\n");
};

const injectFunctionEnhancements = (
	markdown: string,
	optionsByType: Map<string, OptionEntry[]>,
	specs: Map<string, { spec: string; optsType?: string }>,
) => {
	const lines = markdown.split("\n");
	const output: string[] = [];
	let pending: {
		fnName: string;
		spec?: string;
		options?: OptionEntry[];
		inserted: boolean;
	} | null = null;

	const flushInsertions = () => {
		if (!pending || pending.inserted) {
			return;
		}
		const insertLines: string[] = [];
		if (pending.spec) {
			insertLines.push(`Spec: \`${pending.spec}\``);
		}
		if (pending.options?.length) {
			if (insertLines.length) {
				insertLines.push("");
			}
			insertLines.push(...buildOptionsTable(pending.options).split("\n"));
		}
		if (insertLines.length) {
			output.push(...insertLines);
			output.push("");
		}
		pending.inserted = true;
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const headingMatch = line.match(/^#{1,6}\s+`?([A-Za-z0-9_!?]+)`?\s*$/);
		if (headingMatch) {
			const fnName = headingMatch[1];
			const specInfo = specs.get(fnName);
			const options = specInfo?.optsType
				? optionsByType.get(specInfo.optsType)
				: undefined;
			pending =
				specInfo || options
					? { fnName, spec: specInfo?.spec, options, inserted: false }
					: null;
			output.push(line);
			continue;
		}
		if (pending) {
			if (line.startsWith("[🔗](")) {
				output.push(line);
				continue;
			}
			if (!pending.inserted) {
				if (line.trim() && !line.startsWith("```") && !line.startsWith("#")) {
					flushInsertions();
					output.push(
						line.trim().startsWith("Summary:")
							? line.trim()
							: `Summary: ${line.trim()}`,
					);
					pending = null;
					continue;
				}
				flushInsertions();
			}
		}
		output.push(line);
	}
	return output.join("\n");
};

const buildAgentDataSection = (optionsByType: Map<string, OptionEntry[]>) => {
	const optTypes = Array.from(optionsByType.entries()).filter(([name]) =>
		name.endsWith("_opts"),
	);
	if (!optTypes.length) {
		return null;
	}
	const lines = ["## Agent Data", "```agent-data", "opts:"];
	for (const [typeName, options] of optTypes) {
		lines.push(`  ${typeName}:`);
		const required = options.filter((option) => option.required);
		const optional = options.filter((option) => !option.required);
		lines.push("    required:");
		for (const option of required) {
			lines.push(`      - key: ${option.key}`);
			lines.push(`        type: ${option.type}`);
		}
		lines.push("    optional:");
		for (const option of optional) {
			lines.push(`      - key: ${option.key}`);
			lines.push(`        type: ${option.type}`);
		}
	}
	lines.push("```");
	return lines.join("\n");
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
	const sourceSection = buildSourceSection(url);
	const isLlms = url.pathname.endsWith("/llms.txt");
	try {
		if (isLlms) {
			const llmsBodyRaw = await buildLlmsReplacement(url, fetcher, ttlSeconds);
			const llmsBody = rewriteMarkdownLinks(
				llmsBodyRaw,
				url.toString(),
				url.origin,
			);
			const relatedLinks = [
				`${url.origin}/${packageName}/${version}/readme.html`,
				`${url.origin}/${packageName}/${version}/readme.md`,
			];
			const bodyParts = [
				instructionHeader,
				sourceSection,
				llmsBody,
				renderRelatedLinks(relatedLinks),
			].filter(Boolean);
			const body = bodyParts.join("\n\n");
			return markdownResponse(body, ttlSeconds);
		}
		const rawMarkdown = await getMarkdownFromPath(url, fetcher, ttlSeconds);
		const rewritten = rewriteMarkdownLinks(
			rawMarkdown,
			url.toString(),
			url.origin,
		);
		const optionsByType = parseTypeOptions(rewritten);
		const specs = parseSpecs(rewritten);
		const callbacks = parseCallbacks(rewritten);
		const typeNames = parseTypeNames(rewritten);
		const withSections = insertSectionHeadings(rewritten, typeNames, callbacks);
		const enhanced = injectFunctionEnhancements(
			withSections,
			optionsByType,
			specs,
		);
		const agentData = buildAgentDataSection(optionsByType);
		const moduleName = extractModuleName(rewritten);
		const relatedPages = extractModuleReferences(enhanced, optionsByType)
			.filter((page) => page !== moduleName)
			.slice(0, 20);
		const relatedPagesSection = renderRelatedPages(
			relatedPages,
			url.origin,
			packageName,
			version,
		);
		const relatedLinks = extractRelatedLinks(
			enhanced,
			url.toString(),
			url.origin,
		);
		const bodyParts = [
			instructionHeader,
			sourceSection,
			enhanced,
			agentData,
			relatedPagesSection,
			renderRelatedLinks(relatedLinks),
		].filter(Boolean);
		const body = bodyParts.join("\n\n");
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
