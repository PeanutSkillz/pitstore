// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Validation of catalog images (icons, screenshots). Cockpit's CSP only
// allows images from 'self' or data: URLs, so images are fetched through
// the bridge, checked here and shown as data: URLs.

export const MAX_IMAGE_BYTES = 512 * 1024;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
    return prefix.every((b, i) => bytes[offset + i] === b);
}

// Constructs that can load external content or run code in an SVG.
// The check is deliberately conservative: a false rejection only means
// a placeholder icon is shown.
const SVG_FORBIDDEN = [
    /<!DOCTYPE/i,
    /<!ENTITY/i,
    /<script/i,
    /<foreignObject/i,
    /<(?:iframe|embed|object|audio|video|handler|listener)\b/i,
    /\son[a-z]+\s*=/i,
    /javascript:/i,
    /@import/i,
    // href/xlink:href must stay inside the document or be an inline raster image
    /href\s*=\s*(?:"(?!#|data:image\/(?:png|jpeg|webp);)|'(?!#|data:image\/(?:png|jpeg|webp);)|(?!["'#]))/i,
    // CSS url() must reference an element inside the document
    /url\(\s*(?:"(?!#)|'(?!#)|(?!["'#]))/i,
];

export function checkSvg(text: string): void {
    if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text))
        throw new Error("not an SVG document");
    for (const re of SVG_FORBIDDEN) {
        if (re.test(text))
            throw new Error(`SVG contains a forbidden construct (${re.source})`);
    }
}

/* Determine the image type from its bytes. The declared Content-Type must
 * agree with the detected type.
 */
export function detectImage(bytes: Uint8Array, contentType: string): ImageType {
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
        throw new Error(`image size ${bytes.length} is out of range`);
    const declared = contentType.split(';')[0].trim().toLowerCase();

    let type: ImageType;
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        type = 'image/png';
    else if (startsWith(bytes, [0xff, 0xd8, 0xff]))
        type = 'image/jpeg';
    else if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
        type = 'image/webp';
    else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        checkSvg(text);
        type = 'image/svg+xml';
    }
    if (declared !== type)
        throw new Error(`declared type ${declared || '(none)'} does not match content ${type}`);
    return type;
}

export function toDataUrl(bytes: Uint8Array, type: ImageType): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk)
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return `data:${type};base64,${btoa(binary)}`;
}
