import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Renders AI deliverables. Raw HTML in the markdown is NOT rendered (react-markdown default), so output cannot inject scripts. */
export default function Markdown({ children }: { children: string }) {
  return <div className="ht-prose text-[15px] text-[#1D2540]"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{children}</ReactMarkdown></div>;
}
