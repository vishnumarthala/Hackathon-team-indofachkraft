// Ticket 026 FR-5 / NFR-3: an activity's `How to do it` text as the provider wrote it (markdown, not translated).
// No raw HTML (react-markdown default), no images (they would load from anywhere), headings shown as bold text.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const heading: Components["h1"] = ({ children }) => <p className="mt-2 font-semibold">{children}</p>;

const components: Components = {
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
  a: ({ children, href }) => (
    <a href={href} className="font-semibold text-teal-800 underline" target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
};

export function Instructions({ markdown, label }: { markdown: string; label: string }) {
  return (
    <div aria-label={label} className="text-sm break-words text-slate-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} disallowedElements={["img"]} unwrapDisallowed>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
