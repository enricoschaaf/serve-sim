import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Link2, Search } from "lucide-react";
import type {
  DeepLinkDefinition,
  DeepLinkManifest,
  DeepLinkParameterDefinition,
} from "../../deep-links";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";

interface DeepLinkSection {
  title: string;
  groups: Array<[string, DeepLinkDefinition[]]>;
}

function placeholders(url: string): string[] {
  return [...new Set([...url.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!))];
}

function parameterDefinitions(link: DeepLinkDefinition): DeepLinkParameterDefinition[] {
  const metadata = new Map(link.parameters?.map((parameter) => [parameter.name, parameter]));
  return placeholders(link.url).map((name) => metadata.get(name) ?? { name });
}

function parameterLabel(parameter: DeepLinkParameterDefinition): string {
  return parameter.label ?? parameter.name.replaceAll("_", " ").replaceAll("-", " ");
}

export function groupDeepLinksByAuthentication(links: DeepLinkDefinition[]): DeepLinkSection[] {
  const sections = [
    { title: "Available without authentication", requiresAuthentication: false },
    { title: "Requires authentication", requiresAuthentication: true },
  ];
  return sections.flatMap(({ title, requiresAuthentication }) => {
    const grouped = new Map<string, DeepLinkDefinition[]>();
    for (const link of links) {
      if (link.requiresAuthentication !== requiresAuthentication) continue;
      const group = grouped.get(link.group) ?? [];
      group.push(link);
      grouped.set(link.group, group);
    }
    return grouped.size > 0 ? [{ title, groups: [...grouped.entries()] }] : [];
  });
}

export function resolveDeepLink(
  link: DeepLinkDefinition,
  values: Record<string, string>,
): string | null {
  const definitions = parameterDefinitions(link);
  const resolvedValues = Object.fromEntries(definitions.map((parameter) => [
    parameter.name,
    values[parameter.name]?.trim() || parameter.default?.trim() || "",
  ]));
  if (definitions.some(({ name }) => !resolvedValues[name])) return null;
  return link.url.replace(/\{([^{}]+)\}/g, (_match, name: string) =>
    encodeURIComponent(resolvedValues[name]!));
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    if (body.error) return body.error;
  } catch {}
  return `Could not open deep link (${response.status})`;
}

export function DeepLinksPanel({
  open,
  onClose,
  manifest,
  endpoint,
  token,
  width,
}: {
  open: boolean;
  onClose: () => void;
  manifest: DeepLinkManifest;
  endpoint: string;
  token: string;
  width: number;
}) {
  const [query, setQuery] = useState("");
  const [parameters, setParameters] = useState<Record<string, Record<string, string>>>({});
  const [customUrl, setCustomUrl] = useState(`${manifest.scheme}://`);
  const [opening, setOpening] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sections = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = manifest.links.filter((link) => !needle || [
      link.title,
      link.description,
      link.group,
      link.url,
    ].some((value) => value?.toLocaleLowerCase().includes(needle)));
    return groupDeepLinksByAuthentication(filtered);
  }, [manifest.links, query]);

  const openUrl = async (url: string, key: string) => {
    setOpening(key);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) throw new Error(await responseError(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(null);
    }
  };

  const copyUrl = async (url: string) => {
    setError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied((current) => current === url ? null : current), 1_500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not copy deep link");
    }
  };

  return (
    <Panel open={open} width={width}>
      <PanelHeader>
        <div className="flex min-w-0 items-center gap-2">
          <Link2 size={14} className="text-white/45" />
          <PanelTitle>Deep links</PanelTitle>
        </div>
        <PanelCloseButton onClick={onClose} ariaLabel="Close deep links" title="Close" iconSize={15} />
      </PanelHeader>

      <div className="flex min-h-0 flex-1 flex-col border-t border-white/8">
        <div className="space-y-2 border-b border-white/8 p-3">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2.5 focus-within:border-white/20">
            <Search size={14} className="shrink-0 text-white/35" />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={`Search ${manifest.links.length} deep links`}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-white/85 outline-none placeholder:text-white/30"
            />
          </label>
          <div className="flex gap-2">
            <input
              value={customUrl}
              onChange={(event) => setCustomUrl(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && customUrl.trim()) void openUrl(customUrl.trim(), "custom");
              }}
              aria-label="Custom deep link"
              className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-2.5 font-mono text-[11px] text-white/75 outline-none focus:border-white/20"
            />
            <button
              type="button"
              disabled={!customUrl.trim() || opening !== null}
              onClick={() => void openUrl(customUrl.trim(), "custom")}
              className="h-9 shrink-0 rounded-lg border border-white/10 bg-white/8 px-3 text-[12px] font-medium text-white/80 hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {opening === "custom" ? "Opening…" : "Open"}
            </button>
          </div>
          {error && <p className="m-0 text-[11px] leading-4 text-red-400">{error}</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-color:rgba(255,255,255,0.16)_transparent] [scrollbar-width:thin]">
          {sections.map((section) => (
            <section key={section.title} className="pt-4 first:pt-3">
              <h2 className="m-0 px-2 pb-2 text-[11px] font-semibold text-white/65">
                {section.title}
              </h2>
              <div className="space-y-3">
                {section.groups.map(([group, links]) => (
                  <div key={group}>
                    <h3 className="m-0 px-2 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-white/30">
                      {group}
                    </h3>
                    <div className="space-y-1">
                      {links.map((link) => {
                        const key = `${link.group}:${link.url}`;
                        const definitions = parameterDefinitions(link);
                        const values = parameters[key] ?? {};
                        const resolved = resolveDeepLink(link, values);
                        return (
                          <div key={key} className="rounded-lg border border-transparent bg-white/[0.025] p-2 hover:border-white/8 hover:bg-white/[0.045]">
                            <div className="flex items-start gap-2">
                              <button
                                type="button"
                                disabled={!resolved || opening !== null}
                                onClick={() => resolved && void openUrl(resolved, key)}
                                className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left disabled:cursor-not-allowed"
                              >
                                <span className="flex items-center gap-1.5 text-[13px] font-medium text-white/85">
                                  {opening === key ? "Opening…" : link.title}
                                  <ExternalLink size={11} className="shrink-0 text-white/30" />
                                </span>
                                {link.description && (
                                  <span className="mt-0.5 block text-[11px] leading-4 text-white/40">{link.description}</span>
                                )}
                                <span className="mt-1 block truncate font-mono text-[10px] text-white/28">{link.url}</span>
                              </button>
                              <button
                                type="button"
                                disabled={!resolved || opening !== null}
                                onClick={() => resolved && void copyUrl(resolved)}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-white/35 hover:bg-white/8 hover:text-white/70 disabled:opacity-25"
                                aria-label={`Copy ${link.title} deep link`}
                                title="Copy"
                              >
                                {resolved && copied === resolved ? <Check size={13} /> : <Copy size={13} />}
                              </button>
                            </div>
                            {definitions.length > 0 && (
                              <div className="mt-2 grid grid-cols-2 gap-1.5">
                                {definitions.map((parameter) => (
                                  <label key={parameter.name} className="min-w-0">
                                    <span className="mb-1 block text-[9px] uppercase tracking-wide text-white/30">
                                      {parameterLabel(parameter)}
                                    </span>
                                    <input
                                      value={values[parameter.name] ?? parameter.default ?? ""}
                                      placeholder={parameter.placeholder}
                                      onChange={(event) => setParameters((current) => ({
                                        ...current,
                                        [key]: { ...current[key], [parameter.name]: event.currentTarget.value },
                                      }))}
                                      className="h-7 w-full rounded-md border border-white/8 bg-black/20 px-2 text-[11px] text-white/75 outline-none focus:border-white/20"
                                    />
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {sections.length === 0 && (
            <div className="flex h-28 items-center justify-center text-[12px] text-white/35">No matching deep links</div>
          )}
        </div>
      </div>
    </Panel>
  );
}
