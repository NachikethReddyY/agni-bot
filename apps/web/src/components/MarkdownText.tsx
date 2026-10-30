import { memo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { copyText } from "./bits";

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);
  return <div className="code-block">
    <button type="button" className="code-copy" onClick={async (event) => {
      const code = event.currentTarget.parentElement?.querySelector("code")?.textContent ?? "";
      await copyText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>{copied ? "Copied" : "Copy code"}</button>
    <pre {...props}>{children}</pre>
  </div>;
}

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return <div className="prose">
    <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkBreaks]} components={{
      a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
      // External image URLs never load silently; uploaded images use authenticated cards.
      img: ({ src, alt }) => <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer noopener">{alt || "Open image"}</a>,
    }}>{text}</ReactMarkdown>
  </div>;
});
