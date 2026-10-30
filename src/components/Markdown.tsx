// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Minimal Markdown for catalog descriptions, rendered as React elements.
// Untrusted text never becomes HTML: no dangerouslySetInnerHTML, links only
// for https: URLs. Supported: paragraphs, "-"/"*" lists, headings (as bold
// lines), **bold**, *italic*/_italic_, `code` and [text](https://...).

import React from 'react';

const INLINE = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/g;

export function safeHttpsUrl(href: string): string | null {
    try {
        const url = new URL(href);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

function inline(text: string, keyPrefix: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    let last = 0;
    let n = 0;
    for (const m of text.matchAll(INLINE)) {
        if (m.index > last)
            out.push(text.slice(last, m.index));
        const key = `${keyPrefix}-${n++}`;
        if (m[2] !== undefined)
            out.push(<strong key={key}>{m[2]}</strong>);
        else if (m[3] !== undefined)
            out.push(<code key={key}>{m[3]}</code>);
        else if (m[4] !== undefined) {
            const url = safeHttpsUrl(m[5]);
            out.push(url
                ? <a key={key} href={url} target="_blank" rel="noopener noreferrer">{m[4]}</a>
                : m[4]);
        } else
            out.push(<em key={key}>{m[6] ?? m[7]}</em>);
        last = m.index + m[0].length;
    }
    if (last < text.length)
        out.push(text.slice(last));
    return out;
}

export const Markdown = ({ text }: { text: string }) => {
    const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
    return (
        <div className="pitstore-markdown">
            {blocks.map((block, i) => {
                const lines = block.split('\n').filter(l => l.trim() !== '');
                if (lines.length === 0)
                    return null;
                if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
                    return (
                        <ul key={i}>
                            {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''), `${i}-${j}`)}</li>)}
                        </ul>
                    );
                }
                return (
                    <p key={i}>
                        {lines.map((l, j) => {
                            const heading = /^#{1,6}\s+(.*)$/.exec(l);
                            const content = heading
                                ? <strong>{inline(heading[1], `${i}-${j}`)}</strong>
                                : inline(l, `${i}-${j}`);
                            return <React.Fragment key={j}>{j > 0 && <br />}{content}</React.Fragment>;
                        })}
                    </p>
                );
            })}
        </div>
    );
};
