/*
 * Scripted conversations for the mock gateway. A scenario is picked by matching the user's latest
 * message; its steps are played one per model round-trip. A step either calls tools or says
 * something, exactly what a real model would return, so everything downstream of the gateway
 * (tool execution, the tour, approvals, the activity ledger) runs for real.
 *
 * The edits quote the files under samples/ verbatim; if you change a sample, change its script.
 */

const call = (name, args) => ({ name, args });

const TIMELINE = `# Timeline

| When | What happens | Where |
|---|---|---|
| March | Ines's mother goes out to the Skerry and returns the same day; her name is in the landing ledger | told in ch. 1 |
| Tuesday, low tide | Ines arrives on the last ferry and signs the ledger | ch. 1 |
| Tuesday evening | She finds the table laid for two and the ledger page under the second plate | ch. 2 |
| Wednesday | Tobias comes to the door: Mrs Aldous says she will want the boat | ch. 2 |
| Thursday, before light | Ines and Tobias row to the Skerry on the ebb; the tin box; the "weights" are tides | ch. 3 |

## Not yet placed

- When the initials in the ledger change from T. to A. ("from January on", ch. 2): what happened in January?
`;

const TIMELINE_SKILL = `---
name: update-timeline
description: Bring notes/timeline.md up to date with the chapters. Use after chapters were added or changed.
---
Read every file in chapters/ in file name order, then notes/timeline.md.

The timeline is a table with one row per event that moves the story, in story order (not chapter order): when it happens,
what happens in one line, and the chapter it is in. Events that are only told about ("in March her mother...") get "told in ch. N".
Take the day and time from the scene headings (## Tuesday, low tide).

Change only rows that are wrong or missing; do not reword rows that are still right. If a chapter contradicts the timeline,
do not pick a side: add the question under "Not yet placed". One \`edit\` per row.
`;

export const scenarios = [
    {
        // samples/contract, context action "Check Defined Terms"
        match: /defined-terms-check/,
        steps: [
            { call: [call('skill', { name: 'defined-terms-check' })] },
            { call: [call('read', { path: 'services-agreement.md' })] },
            {
                call: [
                    call('show', {
                        path: 'services-agreement.md',
                        quote: '2.2 The Supplier shall deliver the Deliverables in accordance with the timetable in Schedule 1.',
                        why: '**Used but not defined: "Deliverables".** This is the only obligation to deliver anything, and nothing says what. It needs a definition, probably by reference to Schedule 1; what counts as a deliverable is for you to decide.'
                    }),
                    call('show', {
                        path: 'services-agreement.md',
                        quote: '9.1 This Agreement starts on the Effective Date',
                        why: '**Used but not defined: "Effective Date".** The Term in 9.1 runs from it, so without it the start of the contract is open. Usually the date of signature or a date stated on the cover.'
                    }),
                    call('edit', {
                        path: 'services-agreement.md',
                        old: 'reasonably needed to perform the Service.',
                        new: 'reasonably needed to perform the Services.',
                        why: 'The defined term is "Services"; the singular here reads as something else. No change in meaning intended, as far as I can tell.'
                    }),
                    call('show', {
                        path: 'services-agreement.md',
                        quote: '"Affiliate" means any entity that controls, is controlled by, or is under common control with a party.',
                        why: '**Defined but never used: "Affiliate".** Harmless, but it suggests a clause that was cut (assignment? confidentiality carve-out?). Delete the definition or restore what used it.'
                    })
                ]
            },
            {
                say: 'Four findings. Two terms carry obligations but are never defined, "Deliverables" (stop 1) and "Effective Date" (stop 2); both need a decision from you, so I have not drafted anything. ' +
                    'Stop 3 is the one mechanical fix. "Supplier", "Customer" and "Term" are defined inline and used consistently.'
            }
        ]
    },
    {
        // samples/contract, context action "Check Cross-References"
        match: /cross-reference-check/,
        steps: [
            { call: [call('skill', { name: 'cross-reference-check' })] },
            { call: [call('read', { path: 'services-agreement.md' })] },
            {
                call: [
                    call('show', {
                        path: 'services-agreement.md',
                        quote: '3.2 Interest on late payments accrues in accordance with clause 3.4.',
                        why: '**Clause 3.4 does not exist.** Section 3 ends at 3.2, and no other clause sets an interest rate, so I cannot tell what was meant. The numbering also jumps from 3 to 7: sections 4 to 6 may have been cut.'
                    }),
                    call('edit', {
                        path: 'services-agreement.md',
                        old: '7.2 Nothing in clause 8 limits liability',
                        new: '7.2 Nothing in this clause 7 limits liability',
                        why: 'Clause 8 is Confidentiality and limits nothing. The carve-out for death, injury and fraud can only refer to the cap in 7.1.'
                    })
                ]
            },
            { say: 'Two of the five internal references are wrong. Stop 1 points at a clause that is not there and needs you; stop 2 has only one possible target, so I have proposed the correction. The references to clause 9.1, clause 8.1 and Schedule 1 resolve.' }
        ]
    },
    {
        // samples/manuscript, context action "Tighten This Passage" on the second paragraph of chapter 1
        match: /tighten-prose/,
        steps: [
            { call: [call('skill', { name: 'tighten-prose' })] },
            {
                call: [
                    call('edit', {
                        path: 'chapters/01-the-ferry.md',
                        old: 'She noticed that the harbour seemed smaller than she remembered it.',
                        new: 'The harbour was smaller than she remembered.',
                        why: 'Drops "she noticed that" and "seemed": we are already in her head, and she is not in doubt.'
                    }),
                    call('edit', {
                        path: 'chapters/01-the-ferry.md',
                        old: 'she felt a sudden, sharp, unexpected pang of something that was not quite grief. It was not quite grief, but it was close to it.',
                        new: 'she felt a sharp pang of something that was not quite grief.',
                        why: 'Three adjectives doing one job, then a sentence that says the last one again. "Not quite grief" is the line that matters and it lands harder once.'
                    }),
                    call('edit', {
                        path: 'chapters/01-the-ferry.md',
                        old: 'She stood there for a moment, looking at it all, before she picked up her suitcase and began to walk.',
                        new: 'She picked up her suitcase and walked.',
                        why: 'The standing and looking is what the paragraph has just done for her. This one costs a beat of stillness, so take it only if you want the pace.'
                    })
                ]
            },
            { say: 'Thirty of the 68 words came out, and nothing that happens has changed. Stops 1 and 2 are plain cuts. Stop 3 is a matter of taste: it trades a pause for pace.' }
        ]
    },
    {
        // samples/manuscript: "Keep a timeline of the story for me." The agent reshapes the workbench.
        match: /timeline/i,
        steps: [
            { call: [call('skill', { name: 'workbench' })] },
            { call: [call('read', { path: '.cicerone/workbench.json' }), call('find', { glob: 'chapters/*.md' })] },
            { call: [call('read', { path: 'chapters/01-the-ferry.md' }), call('read', { path: 'chapters/02-the-house.md' }), call('read', { path: 'chapters/03-the-skerry.md' })] },
            {
                call: [
                    call('edit', {
                        path: 'notes/timeline.md', old: '', new: TIMELINE,
                        why: 'The timeline itself, built from the scene headings of the three chapters. One question came up while building it and is listed at the bottom rather than guessed at.'
                    }),
                    call('edit', {
                        path: '.agents/skills/update-timeline/SKILL.md', old: '', new: TIMELINE_SKILL,
                        why: 'How to keep the timeline current, written down once so that updating it later is one click and always done the same way.'
                    }),
                    call('edit', {
                        path: '.cicerone/workbench.json',
                        old: '  "actions": [\n    {\n      "id": "tighten",',
                        new: '  "actions": [\n    {\n      "id": "update-timeline",\n      "label": "Update Timeline",\n      "on": "workspace",\n      "skill": "update-timeline"\n    },\n    {\n      "id": "tighten",',
                        why: 'Adds the command **Update Timeline**, which runs the new skill.'
                    }),
                    call('edit', {
                        path: '.cicerone/workbench.json',
                        old: '      "target": 80000\n    }\n  ],',
                        new: '      "target": 80000\n    },\n    {\n      "id": "timeline",\n      "title": "Timeline",\n      "kind": "document",\n      "icon": "calendar",\n      "file": "notes/timeline.md",\n      "action": "update-timeline"\n    }\n  ],',
                        why: 'Adds a **Timeline** view next to your chapters that shows the file, with an Update button on top.'
                    })
                ]
            },
            {
                say: 'I have set up a timeline you can keep open beside the chapters. Accept all four stops and a Timeline view appears on the left with an Update Timeline button. ' +
                    'Look at stop 1 first: the ledger initials change "from January on", and the story does not yet say what happened then.'
            }
        ]
    },
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
