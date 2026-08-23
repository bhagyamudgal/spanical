import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";
import { DocsCard, DocsCardGroup } from "@/components/docs/cards";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function isExternalHref(href: string | undefined): boolean {
    return href?.startsWith("http") ?? false;
}

function MdxTable({ children, ...props }: React.ComponentProps<"table">) {
    return (
        <div className="my-6 max-w-full overflow-x-auto">
            <table {...props} className="w-full text-sm">
                {children}
            </table>
        </div>
    );
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
    return {
        a: ({ href, children }) => {
            if (isExternalHref(href)) {
                return (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                        {children}
                    </a>
                );
            }
            return <Link href={href ?? "#"}>{children}</Link>;
        },
        table: MdxTable,
        pre: CodeBlock,
        Note: (props) => <Callout variant="note" {...props} />,
        Warning: (props) => <Callout variant="warning" {...props} />,
        Tip: (props) => <Callout variant="tip" {...props} />,
        CardGroup: DocsCardGroup,
        Card: DocsCard,
        Tabs,
        TabsList,
        TabsTrigger,
        TabsContent,
        ...components,
    };
}
