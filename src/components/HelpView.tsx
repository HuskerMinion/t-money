// The Help tab: every topic in src/help/topics.ts, grouped in a left
// column, searchable, cross-linked. Content is a small markdown subset
// rendered here — no library, no HTML in the content.
import { useEffect, useMemo, useState } from "react";
import TmIcon from "./TmIcon";
import { HELP_GROUPS, HELP_TOPICS, searchTopics, type HelpTopic } from "../help/topics";
import { keys } from "../lib/keys";

interface Props {
  /** Topic to show; App sets it from F1 or the tab that was open. */
  topic?: string | null;
}

/** Inline markup: **bold**, `code`, [[id|text]]. Returns React nodes. */
export function renderInline(text: string, onLink: (id: string) => void, key = 0): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[\[([a-z0-9-]+)\|([^\]]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = key;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={i++}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<code key={i++}>{m[2]}</code>);
    else {
      const id = m[3];
      out.push(
        <a key={i++} href={`#help/${id}`} className="tm-help-link" onClick={(e) => { e.preventDefault(); onLink(id); }}>
          {m[4]}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Block structure: headings, bullets, tips, paragraphs. */
export function renderBody(body: string, onLink: (id: string) => void): React.ReactNode[] {
  const lines = body.split("\n");
  const out: React.ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let k = 0;
  const flushPara = () => {
    if (para.length) out.push(<p key={k++}>{renderInline(para.join(" "), onLink, k * 100)}</p>);
    para = [];
  };
  const flushList = () => {
    if (list.length)
      out.push(
        <ul key={k++}>
          {list.map((l, i) => (
            <li key={i}>{renderInline(l, onLink, (k + i) * 100)}</li>
          ))}
        </ul>
      );
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      flushPara(); flushList();
      out.push(<h4 key={k++}>{renderInline(line.slice(3), onLink)}</h4>);
    } else if (line.startsWith("# ")) {
      flushPara(); flushList();
      out.push(<h3 key={k++}>{renderInline(line.slice(2), onLink)}</h3>);
    } else if (line.startsWith("- ")) {
      flushPara();
      list.push(line.slice(2));
    } else if (line.startsWith("> ")) {
      flushPara(); flushList();
      out.push(<div key={k++} className="tm-help-tip">{renderInline(line.slice(2), onLink)}</div>);
    } else if (line.trim() === "") {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out;
}

/** Topics this one links to, for the "See also" line. */
export function linkedTopics(t: HelpTopic): HelpTopic[] {
  const ids = new Set<string>();
  for (const m of t.body.matchAll(/\[\[([a-z0-9-]+)\|/g)) ids.add(m[1]);
  ids.delete(t.id);
  return HELP_TOPICS.filter((x) => ids.has(x.id));
}

export default function HelpView({ topic = null }: Props) {
  const [current, setCurrent] = useState<string>(topic ?? "welcome");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (topic) {
      setCurrent(topic);
      setQuery("");
    }
  }, [topic]);
  const active = HELP_TOPICS.find((t) => t.id === current) ?? HELP_TOPICS[0];
  const hits = useMemo(() => searchTopics(query), [query]);
  const searching = query.trim().length > 1;
  const open = (id: string) => {
    setCurrent(id);
    setQuery("");
    document.querySelector(".tm-help-article")?.scrollTo?.(0, 0);
  };

  return (
    <div className="tm-help" aria-label="Help">
      <aside className="tm-help-nav">
        <div className="tm-help-search">
          <input
            className="aero-field w-full"
            type="search"
            aria-label="Search help"
            placeholder="Search help…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {searching ? (
          <div className="tm-help-results" aria-label="Help search results">
            {hits.length === 0 && <div className="tm-text-muted p-2">Nothing matches "{query.trim()}".</div>}
            {hits.map((h) => (
              <button key={h.topic.id} type="button" className={`tm-help-hit${h.topic.id === current ? " active" : ""}`} onClick={() => open(h.topic.id)}>
                <span className="tm-help-hit-title">{h.topic.title}</span>
                <span className="tm-help-hit-group">{h.topic.group}</span>
                {h.snippet && <span className="tm-help-hit-snippet">{h.snippet}</span>}
              </button>
            ))}
          </div>
        ) : (
          HELP_GROUPS.map((g) => (
            <div key={g} className="tm-help-group">
              <div className="tm-rail-head">{g}</div>
              <ul>
                {HELP_TOPICS.filter((t) => t.group === g).map((t) => (
                  <li key={t.id}>
                    <button type="button" className={`tm-help-item${t.id === current ? " active" : ""}`} aria-current={t.id === current ? "page" : undefined} onClick={() => open(t.id)}>
                      {t.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </aside>
      <article className="tm-help-article" aria-label={active.title}>
        <div className="tm-help-crumbs">
          <TmIcon name="reports" size={13} /> Help › {active.group}
        </div>
        <h2 className="tm-report-title">{active.title}</h2>
        <p className="tm-help-blurb">{active.blurb}</p>
        <div className="tm-help-body">{renderBody(keys(active.body), open)}</div>
        {linkedTopics(active).length > 0 && (
          <div className="tm-help-seealso">
            <span className="font-bold">See also:</span>{" "}
            {linkedTopics(active).map((t, i) => (
              <span key={t.id}>
                {i > 0 && " · "}
                <a href={`#help/${t.id}`} className="tm-help-link" onClick={(e) => { e.preventDefault(); open(t.id); }}>
                  {t.title}
                </a>
              </span>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
