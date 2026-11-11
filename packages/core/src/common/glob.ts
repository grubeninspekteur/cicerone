/** Enough of glob for matching workspace paths: `**`, `*`, `?`, and `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
    let source = '';
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === '*') {
            if (glob[i + 1] === '*') {
                source += '.*';
                i += glob[i + 2] === '/' ? 2 : 1;
            } else {
                source += '[^/]*';
            }
        } else if (char === '?') {
            source += '[^/]';
        } else if (char === '{') {
            source += '(?:';
        } else if (char === '}') {
            source += ')';
        } else if (char === ',') {
            source += '|';
        } else {
            source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
        }
    }
    // A pattern without a slash matches the file name at any depth, as in ripgrep.
    return new RegExp(glob.includes('/') ? `^${source}$` : `(?:^|/)${source}$`);
}
