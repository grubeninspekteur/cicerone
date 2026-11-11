const MAX_LENGTH = 60;

/**
 * Turns a title into a URL slug: lower case, words joined by single hyphens.
 * "Hello, World!" -> "hello-world"
 */
export function slugify(title) {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    return slug.slice(0, MAX_LENGTH);
}

/** Makes a slug unique among the ones already taken by appending -2, -3, ... */
export function uniqueSlug(title, taken) {
    const base = slugify(title);
    if (!taken.has(base)) {
        return base;
    }
    let n = 2;
    while (taken.has(`${base}-${n}`)) {
        n++;
    }
    return `${base}-${n}`;
}
