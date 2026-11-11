/*
 * Scripted conversations for the mock gateway. A scenario is picked by matching the user's latest
 * message; its steps are played one per model round-trip. A step either calls tools or says
 * something, exactly what a real model would return, so everything downstream of the gateway
 * (tool execution, the tour, approvals, the activity ledger) runs for real.
 *
 * The edits quote the files under samples/ verbatim; if you change a sample, change its script.
 */

const call = (name, args) => ({ name, args });

export const scenarios = [
    {
        // samples/code, second turn: after the human has accepted the fixes
        match: /again|re-?run|now pass/i,
        steps: [
            { call: [call('run', { command: 'npm test --silent', why: 'Confirms the accepted changes fix both tests and break none.' })] },
            { say: 'All six tests pass now, including the two that failed before. Nothing else in the project calls `slugify` with assumptions about accents, so I see no follow-up work.' }
        ]
    },
    {
        // samples/code: "The slug tests are failing. Find out why and fix it."
        match: /fail|slug|test/i,
        steps: [
            { call: [call('run', { command: 'npm test --silent', why: 'Reproduces the failure before anything is changed.' })] },
            { call: [call('read', { path: 'test/slug.test.js' }), call('read', { path: 'src/slug.js' })] },
            {
                call: [call('show', {
                    path: 'src/slug.js',
                    quote: ".replace(/[^a-z0-9]+/g, '-')",
                    why: 'Both failures start here. Accented letters are outside `a-z`, so each one becomes a hyphen (`Crème` → `cr-me`), and nothing after this line looks at the slug again.'
                })]
            },
            {
                call: [
                    call('edit', {
                        path: 'src/slug.js',
                        old: "    const slug = title\n        .toLowerCase()\n",
                        new: "    const slug = title\n        .normalize('NFKD')\n        .replace(/[\\u0300-\\u036f]/g, '')\n        .toLowerCase()\n",
                        why: 'Splits accented letters into base letter plus accent and drops the accent, so `è` survives as `e` instead of turning into a hyphen.'
                    }),
                    call('edit', {
                        path: 'src/slug.js',
                        old: '    return slug.slice(0, MAX_LENGTH);',
                        new: "    return slug.slice(0, MAX_LENGTH).replace(/-$/, '');",
                        why: 'Cutting at 60 characters can land right after a hyphen. The earlier trim runs before the cut, so the slug needs trimming once more after it.'
                    }),
                    call('edit', {
                        path: 'test/slug.test.js',
                        old: "test('numbers duplicates', () => {",
                        new: "test('treats sharp s as ss', () => {\n    assert.equal(slugify('Straße'), 'strasse');\n});\n\ntest('numbers duplicates', () => {",
                        why: 'A case the accent fix does **not** cover: `ß` has no decomposition and still becomes a hyphen. I added the test so the gap is visible; say the word and I will handle it.'
                    })
                ]
            },
            {
                say: 'Two separate bugs in `slugify`: accents were turned into hyphens, and truncation could leave a trailing hyphen. Stops 3 and 4 fix them. ' +
                    'Look at stop 5 before accepting it: it adds a test that will fail, on purpose, to show that `ß` is still unhandled. ' +
                    'Once you have accepted the fixes, ask me to run the tests again.'
            }
        ]
    },
    {
        // fallback: anything else gets an honest answer about what this gateway is
        match: /.*/s,
        steps: [
            { say: 'This is the mock gateway, so I can only play the conversations scripted in `tools/mock-gateway/scenarios.mjs`. Point Cicerone at a real LiteLLM gateway to work on your own request.' }
        ]
    }
];
