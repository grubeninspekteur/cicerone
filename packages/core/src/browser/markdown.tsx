import * as React from '@theia/core/shared/react';
import markdownit from '@theia/core/shared/markdown-it';
import * as DOMPurify from '@theia/core/shared/dompurify';

const inline = markdownit({ html: false, linkify: false, breaks: true });

/** The agent's words, rendered; `block` for paragraphs and lists, otherwise a single run of inline text. */
export function Markdown(props: { text: string, block?: boolean, className?: string }): React.ReactElement {
    const html = React.useMemo(
        () => DOMPurify.sanitize(props.block ? inline.render(props.text) : inline.renderInline(props.text)),
        [props.text, props.block]
    );
    const Tag = props.block ? 'div' : 'span';
    return <Tag className={props.className} dangerouslySetInnerHTML={{ __html: html }} />;
}
