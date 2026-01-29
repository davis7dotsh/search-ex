const UPSTREAM_ORIGIN = "https://hexdocs.pm";
const YEAR_TTL_SECONDS = 31_536_000;
const HOUR_TTL_SECONDS = 3_600;

type OptionEntry = {
	key: string;
	required: boolean;
	type: string;
};

type ModuleEntry = {
	name: string;
	summary?: string;
	url: string;
	markdown_url: string;
	deprecated?: boolean;
	group?: string;
};

type GuideEntry = {
	id: string;
	title: string;
	group?: string;
	url: string;
	headers?: { id: string; anchor: string }[];
};

type TaskEntry = {
	id: string;
	title: string;
	url: string;
	deprecated?: boolean;
	group?: string;
	sections?: { id: string; anchor: string }[];
};

type TaskMapEntry = {
	id: string;
	title: string;
	description: string;
	entrypoints: { label: string; url: string }[];
};

type PackageIndex = {
	package: string;
	version?: string;
	is_versioned: boolean;
	base_path: string;
	origin: string;
	last_modified?: string;
	source: {
		api_reference: string;
		sidebar_items?: string;
	};
	modules: ModuleEntry[];
	guides: GuideEntry[];
	tasks: TaskEntry[];
	task_map: TaskMapEntry[];
	generated_at: string;
};

const parsePathContext = (pathname: string) => {
	const [packageName, maybeVersion, ...rest] = pathname
		.split("/")
		.filter(Boolean);
	if (!packageName || !maybeVersion) {
		return {
			packageName,
			version: undefined,
			restPath: "",
			basePath: packageName ? `/${packageName}` : "",
			isVersioned: false,
		};
	}
	const isVersioned = isVersionSegment(maybeVersion);
	const basePath = isVersioned
		? `/${packageName}/${maybeVersion}`
		: `/${packageName}`;
	const restPath = isVersioned
		? rest.join("/")
		: [maybeVersion, ...rest].join("/");
	return {
		packageName,
		version: isVersioned ? maybeVersion : undefined,
		restPath,
		basePath,
		isVersioned,
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

const jsonResponse = (body: unknown, ttlSeconds: number, status = 200) =>
	new Response(JSON.stringify(body, null, 2), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": `public, max-age=${ttlSeconds}${ttlSeconds === YEAR_TTL_SECONDS ? ", immutable" : ""}`,
		},
	});

const errorWithDetails = (
	message: string,
	details: Record<string, string | number | null>,
) => Object.assign(new Error(message), { details });

const buildInstructionHeader = (origin: string, basePath: string) => {
	const base = `${origin}${basePath}`;
	return [
		"## Navigation",
		`Base: ${base}`,
		`Index: ${base}/index.json`,
		`LLMs: ${base}/llms.txt`,
		`Modules: ${base}/{Module}.html or ${base}/{Module}.md`,
		`Guides: ${base}/{guide}.html`,
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

const buildWrapperUrl = (
	href: string,
	baseUrl: string,
	wrapperOrigin: string,
) => normalizeLinkTarget(href, baseUrl, wrapperOrigin) ?? href;

const toMarkdownUrl = (url: string) =>
	url.endsWith(".md")
		? url
		: url.includes(".html")
			? url.replace(/\.html(\b|$)/, ".md")
			: `${url}.md`;

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

const findSidebarItemsUrl = (html: string, baseUrl: URL) => {
	const match = html.match(/sidebar_items-[A-Za-z0-9]+\.js/);
	return match ? new URL(`dist/${match[0]}`, baseUrl).toString() : null;
};

const parseSidebarNodes = (script: string) => {
	const prefix = "sidebarNodes=";
	const trimmed = script.trim();
	if (!trimmed.startsWith(prefix)) {
		return null;
	}
	try {
		const jsonText = trimmed.slice(prefix.length).replace(/;$/, "");
		return JSON.parse(jsonText) as {
			modules?: { id: string; deprecated?: boolean; group?: string }[];
			extras?: {
				id: string;
				group?: string;
				title: string;
				headers?: { id: string; anchor: string }[];
			}[];
			tasks?: {
				id: string;
				deprecated?: boolean;
				group?: string;
				title: string;
				sections?: { id: string; anchor: string }[];
			}[];
		};
	} catch {
		return null;
	}
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
	const pageUrl = new URL(baseUrl);
	for (const match of markdown.matchAll(pattern)) {
		const href = match[2]?.trim();
		const resolved = href
			? resolveRelatedLink(href, baseUrl, wrapperOrigin)
			: null;
		if (!resolved) {
			continue;
		}
		try {
			const resolvedUrl = new URL(resolved, pageUrl);
			if (
				resolvedUrl.origin === pageUrl.origin &&
				resolvedUrl.pathname === pageUrl.pathname
			) {
				continue;
			}
			links.add(resolvedUrl.toString());
		} catch {
			links.add(resolved);
		}
	}
	return Array.from(links).slice(0, 30);
};

const extractModuleName = (markdown: string) => {
	const headingMatch = markdown.match(/^#\s+`?([^`]+)`?/m);
	return headingMatch?.[1]?.trim() ?? null;
};

const extractModuleReferences = (
	markdown: string,
	typeOptions: Map<string, OptionEntry[]>,
	knownModules: Set<string>,
) => {
	const modulePattern = /\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+\b/g;
	const modules = new Set<string>();
	for (const match of markdown.matchAll(modulePattern)) {
		const name = match[0];
		if (!knownModules.size || knownModules.has(name)) {
			modules.add(name);
		}
	}
	for (const options of typeOptions.values()) {
		for (const option of options) {
			for (const match of option.type.matchAll(modulePattern)) {
				const name = match[0];
				if (!knownModules.size || knownModules.has(name)) {
					modules.add(name);
				}
			}
		}
	}
	return Array.from(modules);
};

const renderRelatedPages = (
	pages: string[],
	origin: string,
	basePath: string,
) => {
	if (!pages.length) {
		return null;
	}
	const lines = ["## Related Pages"];
	for (const page of pages) {
		lines.push(`- ${origin}${basePath}/${page}.html`);
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

const sliceSectionByHeading = (html: string, headingId: string) => {
	const headingMatch = html.match(
		new RegExp(`<h2[^>]*id=["']${headingId}["'][^>]*>`, "i"),
	);
	if (!headingMatch?.index) {
		return "";
	}
	const start = headingMatch.index;
	const rest = html.slice(start + headingMatch[0].length);
	const nextMatch = rest.match(/<h2[^>]*id=["'][^"']+["'][^>]*>/i);
	const end =
		typeof nextMatch?.index === "number"
			? start + headingMatch[0].length + nextMatch.index
			: html.length;
	return html.slice(start, end);
};

const parseApiReferenceModules = (html: string) => {
	const section = sliceSectionByHeading(html, "modules");
	if (!section) {
		return [];
	}
	const rowPattern =
		/<div class="summary-row">[\s\S]*?<a href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?(?:<div class="summary-synopsis">[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<\/div>)?/gi;
	const modules: { name: string; href: string; summary?: string }[] = [];
	for (const match of section.matchAll(rowPattern)) {
		const href = match[1]?.trim();
		const name = match[2]?.trim();
		if (!href || !name) {
			continue;
		}
		const summaryRaw = match[3]?.trim();
		const summary = summaryRaw ? stripTags(summaryRaw).trim() : undefined;
		modules.push({ name, href, summary });
	}
	return modules;
};

const buildTaskMap = ({
	modules,
	guides,
	tasks,
}: {
	modules: ModuleEntry[];
	guides: GuideEntry[];
	tasks: TaskEntry[];
}) => {
	const moduleMap = new Map(modules.map((entry) => [entry.name, entry]));
	const taskMap = new Map(tasks.map((entry) => [entry.title, entry]));
	const guideMap = new Map(guides.map((entry) => [entry.id, entry]));
	const entrypoints = ({
		moduleNames = [],
		taskTitles = [],
		guideIds = [],
	}: {
		moduleNames?: string[];
		taskTitles?: string[];
		guideIds?: string[];
	}) => {
		const points: { label: string; url: string }[] = [];
		for (const name of moduleNames) {
			const module = moduleMap.get(name);
			if (module) {
				points.push({ label: module.name, url: module.url });
			}
		}
		for (const title of taskTitles) {
			const task = taskMap.get(title);
			if (task) {
				points.push({ label: task.title, url: task.url });
			}
		}
		for (const id of guideIds) {
			const guide = guideMap.get(id);
			if (guide) {
				points.push({ label: guide.title, url: guide.url });
			}
		}
		const seen = new Set<string>();
		return points.filter((point) => {
			if (seen.has(point.url)) {
				return false;
			}
			seen.add(point.url);
			return true;
		});
	};
	const tasksOut: TaskMapEntry[] = [];
	const hasGuide = (id: string) => guideMap.has(id);
	const hasModule = (name: string) => moduleMap.has(name);
	const hasTask = (title: string) => taskMap.has(title);

	if (hasGuide("getting-started") || hasGuide("readme")) {
		tasksOut.push({
			id: "getting-started",
			title: "Get started",
			description: "Install and configure the library.",
			entrypoints: entrypoints({
				guideIds: hasGuide("getting-started")
					? ["getting-started"]
					: ["readme"],
			}),
		});
	}

	if (
		hasModule("Ecto.Migration") ||
		hasModule("Ecto.Migrator") ||
		hasTask("mix ecto.migrate")
	) {
		tasksOut.push({
			id: "migrations",
			title: "Run database migrations",
			description: "Create and apply schema changes safely.",
			entrypoints: entrypoints({
				moduleNames: ["Ecto.Migration", "Ecto.Migrator"],
				taskTitles: [
					"mix ecto.gen.migration",
					"mix ecto.migrate",
					"mix ecto.rollback",
				],
				guideIds: ["safe-ecto-migrations"],
			}),
		});
	}

	if (hasModule("Ecto.Repo") || hasTask("mix ecto.create")) {
		tasksOut.push({
			id: "repo-setup",
			title: "Configure and manage the repo",
			description: "Connect to the database and manage lifecycle tasks.",
			entrypoints: entrypoints({
				moduleNames: ["Ecto.Repo"],
				taskTitles: ["mix ecto.create", "mix ecto.drop", "mix ecto.reset"],
				guideIds: ["getting-started"],
			}),
		});
	}

	if (hasModule("Ecto.Schema") || hasModule("Ecto.Changeset")) {
		tasksOut.push({
			id: "schemas",
			title: "Define schemas and validate data",
			description: "Map data structures and validate changes.",
			entrypoints: entrypoints({
				moduleNames: ["Ecto.Schema", "Ecto.Changeset"],
				guideIds: ["getting-started"],
			}),
		});
	}

	if (hasModule("Ecto.Query")) {
		tasksOut.push({
			id: "queries",
			title: "Query data",
			description: "Build composable, secure queries.",
			entrypoints: entrypoints({
				moduleNames: ["Ecto.Query"],
				guideIds: ["getting-started"],
			}),
		});
	}

	return tasksOut.filter((entry) => entry.entrypoints.length);
};

const fetchUpstream = (fetcher: typeof fetch, url: URL, ttlSeconds: number) =>
	fetcher(url, {
		cf: {
			cacheTtl: ttlSeconds,
			cacheEverything: true,
		},
	});

const fetchUpstreamText = async (
	fetcher: typeof fetch,
	url: URL,
	ttlSeconds: number,
) => {
	const response = await fetchUpstream(fetcher, url, ttlSeconds);
	const text = await response.text();
	return { response, text, url: url.toString() };
};

const buildPackageIndex = async (
	requestUrl: URL,
	fetcher: typeof fetch,
	ttlSeconds: number,
) => {
	const { packageName, version, basePath, isVersioned } = parsePathContext(
		requestUrl.pathname,
	);
	const apiReferenceUrl = new URL(
		isVersioned
			? `/${packageName}/${version}/api-reference.html`
			: `/${packageName}/api-reference.html`,
		UPSTREAM_ORIGIN,
	);
	const apiResponse = await fetchUpstream(fetcher, apiReferenceUrl, ttlSeconds);
	if (!apiResponse.ok) {
		throw errorWithDetails("Upstream api-reference fetch failed", {
			attempted: apiReferenceUrl.toString(),
			status: apiResponse.status,
		});
	}
	const apiHtml = await apiResponse.text();
	const sidebarUrl = findSidebarItemsUrl(apiHtml, apiReferenceUrl);
	let resolvedSidebarNodes: ReturnType<typeof parseSidebarNodes> = null;
	if (sidebarUrl) {
		const resolved = new URL(sidebarUrl);
		const { response, text } = await fetchUpstreamText(
			fetcher,
			resolved,
			ttlSeconds,
		);
		resolvedSidebarNodes = response.ok ? parseSidebarNodes(text) : null;
	}
	const sidebarModuleMap = new Map(
		(resolvedSidebarNodes?.modules ?? []).map((entry) => [entry.id, entry]),
	);
	const modulesFromApi = parseApiReferenceModules(apiHtml);
	const modules: ModuleEntry[] =
		modulesFromApi.length > 0
			? modulesFromApi.map((entry) => {
					const url = buildWrapperUrl(
						entry.href,
						apiReferenceUrl.toString(),
						requestUrl.origin,
					);
					return {
						name: entry.name,
						summary: entry.summary,
						url,
						markdown_url: toMarkdownUrl(url),
						deprecated: sidebarModuleMap.get(entry.name)?.deprecated ?? false,
						group: sidebarModuleMap.get(entry.name)?.group,
					};
				})
			: (resolvedSidebarNodes?.modules ?? []).map((entry) => {
					const url = `${requestUrl.origin}${basePath}/${entry.id}.html`;
					return {
						name: entry.id,
						url,
						markdown_url: toMarkdownUrl(url),
						deprecated: entry.deprecated ?? false,
						group: entry.group,
					};
				});
	const guides: GuideEntry[] = (resolvedSidebarNodes?.extras ?? []).map(
		(entry) => ({
			id: entry.id,
			title: entry.title,
			group: entry.group,
			headers: entry.headers,
			url: `${requestUrl.origin}${basePath}/${entry.id}.html`,
		}),
	);
	const tasks: TaskEntry[] = (resolvedSidebarNodes?.tasks ?? []).map(
		(entry) => ({
			id: entry.id,
			title: entry.title,
			group: entry.group,
			deprecated: entry.deprecated ?? false,
			sections: entry.sections,
			url: `${requestUrl.origin}${basePath}/${entry.id}.html`,
		}),
	);
	return {
		package: packageName,
		version,
		is_versioned: isVersioned,
		base_path: basePath,
		origin: requestUrl.origin,
		last_modified: apiResponse.headers.get("last-modified") ?? undefined,
		source: {
			api_reference: apiReferenceUrl.toString(),
			sidebar_items: sidebarUrl ?? undefined,
		},
		modules,
		guides,
		tasks,
		task_map: buildTaskMap({ modules, guides, tasks }),
		generated_at: new Date().toISOString(),
	} satisfies PackageIndex;
};

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
		if (response.ok) {
			return response.text();
		}
		const htmlResponse = await fetchUpstream(fetcher, htmlUrl, ttlSeconds);
		if (htmlResponse.ok) {
			return htmlToMarkdown(await htmlResponse.text());
		}
		throw errorWithDetails("Upstream markdown fetch failed", {
			attempted: upstreamUrl.toString(),
			status: response.status,
			fallback: htmlUrl.toString(),
			fallback_status: htmlResponse.status,
		});
	}
	const htmlResponse = await fetchUpstream(fetcher, upstreamUrl, ttlSeconds);
	if (!htmlResponse.ok) {
		throw errorWithDetails("Upstream html fetch failed", {
			attempted: upstreamUrl.toString(),
			status: htmlResponse.status,
		});
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

const extractFirstParagraph = (markdown: string) => {
	const lines = markdown.split("\n");
	let inCode = false;
	let seenTitle = false;
	const paragraph: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		if (!seenTitle) {
			if (trimmed.startsWith("# ")) {
				seenTitle = true;
			}
			continue;
		}
		if (inCode) {
			continue;
		}
		if (!trimmed) {
			if (paragraph.length) {
				break;
			}
			continue;
		}
		if (trimmed.startsWith("#")) {
			break;
		}
		if (trimmed.startsWith("[🔗](")) {
			continue;
		}
		paragraph.push(trimmed);
	}
	return paragraph.length ? paragraph.join(" ") : null;
};

const extractWarnings = (markdown: string) => {
	const lines = markdown.split("\n");
	const warnings: string[] = [];
	let inCode = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```")) {
			inCode = !inCode;
			continue;
		}
		if (inCode || !trimmed) {
			continue;
		}
		const match = trimmed.match(
			/^(?:NOTE|Note|WARNING|Warning|CAUTION|Caution):\s*(.+)$/,
		);
		if (match?.[1]) {
			warnings.push(match[1].trim());
			if (warnings.length >= 3) {
				break;
			}
		}
	}
	return warnings;
};

const buildOperationalWorkflow = (markdown: string) => {
	const steps: string[] = [];
	if (markdown.includes("mix ecto.gen.migration")) {
		steps.push("- Generate a migration: `mix ecto.gen.migration <name>`.");
	}
	if (markdown.includes("priv/") && markdown.includes("migrations")) {
		steps.push("- Edit the migration file under `priv/.../migrations`.");
	}
	if (markdown.includes("mix ecto.migrate")) {
		steps.push("- Apply migrations: `mix ecto.migrate`.");
	}
	if (markdown.includes("mix ecto.rollback")) {
		steps.push("- Roll back when needed: `mix ecto.rollback --step 1`.");
	}
	if (
		markdown.includes("Ecto.Migrator") ||
		markdown.includes("bin/my_app eval")
	) {
		steps.push(
			"- For releases, run migrations via `Ecto.Migrator` in a release module.",
		);
	}
	return steps.length ? ["## Operational Workflow", ...steps].join("\n") : null;
};

const buildModuleSynopsis = ({
	moduleName,
	markdown,
	specs,
	taskMap,
	relatedPages,
	moduleSummary,
	origin,
	basePath,
}: {
	moduleName: string | null;
	markdown: string;
	specs: Map<string, { spec: string; optsType?: string }>;
	taskMap: TaskMapEntry[];
	relatedPages: string[];
	moduleSummary?: string;
	origin: string;
	basePath: string;
}) => {
	if (!moduleName) {
		return null;
	}
	const purpose = moduleSummary ?? extractFirstParagraph(markdown);
	const entrypoints = Array.from(specs.keys()).slice(0, 5);
	const taskMatches = taskMap
		.filter((task) =>
			task.entrypoints.some(
				(entry) =>
					entry.label === moduleName ||
					entry.url.endsWith(`/${moduleName}.html`),
			),
		)
		.map((task) => task.title)
		.slice(0, 3);
	const seeAlso = relatedPages.slice(0, 5).map((page) => ({
		label: page,
		url: `${origin}${basePath}/${page}.html`,
	}));
	const lines = ["## Module Synopsis"];
	if (purpose) {
		lines.push(`- Purpose: ${purpose}`);
	}
	if (entrypoints.length) {
		lines.push(
			`- Primary entrypoints: ${entrypoints.map((entry) => `\`${entry}\``).join(", ")}`,
		);
	}
	if (taskMatches.length) {
		lines.push(`- Common tasks: ${taskMatches.join(", ")}`);
	}
	if (seeAlso.length) {
		lines.push(
			`- See also: ${seeAlso
				.map((entry) => `[${entry.label}](${entry.url})`)
				.join(", ")}`,
		);
	}
	return lines.length > 1 ? lines.join("\n") : null;
};

const renderGuidesSection = (guides: GuideEntry[]) => {
	if (!guides.length) {
		return null;
	}
	const lines = ["## Guides"];
	for (const guide of guides.slice(0, 30)) {
		const group = guide.group ? ` (${guide.group})` : "";
		lines.push(`- [${guide.title}](${guide.url})${group}`);
	}
	return lines.join("\n");
};

const renderTaskMapSection = (taskMap: TaskMapEntry[]) => {
	if (!taskMap.length) {
		return null;
	}
	const lines = ["## Task Map"];
	for (const task of taskMap) {
		const entrypoints = task.entrypoints
			.map((entry) => `[${entry.label}](${entry.url})`)
			.join(", ");
		const suffix = entrypoints ? ` (Entrypoints: ${entrypoints})` : "";
		lines.push(`- ${task.title} — ${task.description}${suffix}`);
	}
	return lines.join("\n");
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
	const index = await buildPackageIndex(requestUrl, fetcher, ttlSeconds);
	const moduleLines = index.modules.map((entry) => {
		const summary = entry.summary ? ` — ${entry.summary}` : "";
		return `- [${entry.name}](${entry.url})${summary} (Markdown: ${entry.markdown_url})`;
	});
	const guideLines = index.guides.map((entry) => {
		const group = entry.group ? ` (${entry.group})` : "";
		return `- [${entry.title}](${entry.url})${group}`;
	});
	const taskLines = index.tasks.map(
		(entry) => `- [${entry.title}](${entry.url})`,
	);
	const lines = [
		"## Package",
		`- name: ${index.package}`,
		index.version ? `- version: ${index.version}` : "- version: latest",
		`- index: ${index.origin}${index.base_path}/index.json`,
		`- api_reference: ${index.source.api_reference}`,
		index.source.sidebar_items
			? `- sidebar_items: ${index.source.sidebar_items}`
			: null,
		index.last_modified ? `- last_modified: ${index.last_modified}` : null,
		"",
		renderTaskMapSection(index.task_map),
		"",
		"## Modules",
		...moduleLines,
		"",
		index.guides.length ? "## Guides" : null,
		...guideLines,
		"",
		index.tasks.length ? "## Mix Tasks" : null,
		...taskLines,
	]
		.filter((line): line is string => Boolean(line && line.length))
		.join("\n");
	return lines.trim();
};

export const handleRequest = async (
	request: Request,
	fetcher: typeof fetch = fetch,
) => {
	const url = new URL(request.url);
	const { packageName, version, restPath, basePath } = parsePathContext(
		url.pathname,
	);
	if (!packageName || !restPath) {
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
	const instructionHeader = buildInstructionHeader(url.origin, basePath);
	const sourceSection = buildSourceSection(url);
	const isLlms = url.pathname.endsWith("/llms.txt");
	const isIndexJson = url.pathname.endsWith("/index.json");
	try {
		if (isIndexJson) {
			const index = await buildPackageIndex(url, fetcher, ttlSeconds);
			return jsonResponse(index, ttlSeconds);
		}
		if (isLlms) {
			const llmsBodyRaw = await buildLlmsReplacement(url, fetcher, ttlSeconds);
			const llmsBody = rewriteMarkdownLinks(
				llmsBodyRaw,
				url.toString(),
				url.origin,
			);
			const bodyParts = [instructionHeader, llmsBody].filter(Boolean);
			const body = bodyParts.join("\n\n");
			return markdownResponse(body, ttlSeconds);
		}
		const rawMarkdown = await getMarkdownFromPath(url, fetcher, ttlSeconds);
		const rewritten = rewriteMarkdownLinks(
			rawMarkdown,
			url.toString(),
			url.origin,
		);
		const packageIndex = await buildPackageIndex(
			url,
			fetcher,
			ttlSeconds,
		).catch(() => null);
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
		const knownModules = new Set(
			(packageIndex?.modules ?? []).map((entry) => entry.name),
		);
		const relatedPages = extractModuleReferences(
			enhanced,
			optionsByType,
			knownModules,
		)
			.filter((page) => page !== moduleName)
			.slice(0, 20);
		const moduleSummary = packageIndex?.modules.find(
			(entry) => entry.name === moduleName,
		)?.summary;
		const moduleSynopsis = buildModuleSynopsis({
			moduleName,
			markdown: enhanced,
			specs,
			taskMap: packageIndex?.task_map ?? [],
			relatedPages,
			moduleSummary,
			origin: url.origin,
			basePath,
		});
		const warnings = extractWarnings(enhanced);
		const warningsSection = warnings.length
			? ["## Warnings", ...warnings.map((warning) => `- ${warning}`)].join("\n")
			: null;
		const workflowSection = buildOperationalWorkflow(enhanced);
		const relatedPagesSection = renderRelatedPages(
			relatedPages,
			url.origin,
			basePath,
		);
		const relatedLinks = extractRelatedLinks(
			enhanced,
			url.toString(),
			url.origin,
		);
		const guidesSection = packageIndex
			? renderGuidesSection(packageIndex.guides)
			: null;
		const bodyParts = [
			instructionHeader,
			sourceSection,
			moduleSynopsis,
			warningsSection,
			workflowSection,
			enhanced,
			agentData,
			relatedPagesSection,
			guidesSection,
			renderRelatedLinks(relatedLinks),
		].filter(Boolean);
		const body = bodyParts.join("\n\n");
		return markdownResponse(body, ttlSeconds);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		const details =
			error && typeof error === "object" && "details" in error
				? (error as { details?: Record<string, string | number | null> })
						.details
				: null;
		const attempted = details?.attempted ?? url.toString();
		const status = details?.status ?? null;
		const fallback = details?.fallback ?? null;
		const fallbackStatus = details?.fallback_status ?? null;
		if (isIndexJson) {
			return jsonResponse(
				{
					error: message,
					attempted,
					status,
					fallback,
					fallback_status: fallbackStatus,
				},
				HOUR_TTL_SECONDS,
				502,
			);
		}
		const errorLines = [
			instructionHeader,
			"",
			"## Upstream Error",
			`message: ${message}`,
			`attempted: ${attempted}`,
			status ? `status: ${status}` : null,
			fallback ? `fallback: ${fallback}` : "fallback: none",
			fallback && fallbackStatus ? `fallback_status: ${fallbackStatus}` : null,
		].filter((line): line is string => Boolean(line));
		return markdownResponse(errorLines.join("\n"), HOUR_TTL_SECONDS, 502);
	}
};

export default {
	fetch: (request: Request, _env: Env, _ctx: ExecutionContext) =>
		handleRequest(request),
} satisfies ExportedHandler<Env>;
