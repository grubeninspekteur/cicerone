import { WORKBENCH_FILE, WorkbenchConfig } from './workbench.js';

/*
 * Starting points for kinds of work. A profile is nothing but files written into the workspace: a
 * workbench description and the skills its actions use. After that they belong to the user, who can
 * edit them or ask the agent to. Nothing here is special-cased anywhere else in the product.
 *
 * Each profile assumes a folder convention and says so in its description; the agent adapts the
 * globs when the user's folders differ ("Something else…" in the picker does that from the start).
 */

export interface WorkbenchProfile {
    id: string;
    label: string;
    description: string;
    /** Workspace-relative path → content. Existing files are never overwritten. */
    files: Record<string, string>;
}

const workbench = (config: WorkbenchConfig) => JSON.stringify(config, undefined, 2) + '\n';
const skill = (name: string, description: string, body: string) => ({
    [`.agents/skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${description}\n---\n${body.trim()}\n`
});

const HIDE_DEVELOPER_VIEWS = ['terminal', 'problems', 'debug', 'scm', 'test', 'outline'];

const MANUSCRIPT: WorkbenchProfile = {
    id: 'manuscript',
    label: 'Fiction manuscript',
    description: 'chapters/*.md, characters/*.md · chapter list, lengths, cast, loose ends',
    files: {
        [WORKBENCH_FILE]: workbench({
            title: 'Manuscript',
            views: [
                { id: 'chapters', title: 'Chapters', kind: 'outline', icon: 'book', files: 'chapters/*.md', depth: 2 },
                { id: 'cast', title: 'Cast', kind: 'files', icon: 'person', files: 'characters/*.md', fields: ['role', 'wants', 'first-seen'] },
                { id: 'loose-ends', title: 'Loose Ends', kind: 'matches', icon: 'checklist', files: 'chapters/*.md', pattern: '\\[\\[(.+?)\\]\\]', group: 'file' },
                { id: 'length', title: 'Length', kind: 'counts', icon: 'graph', files: 'chapters/*.md', unit: 'words', target: 80000 }
            ],
            actions: [
                { id: 'tighten', label: 'Tighten This Passage', on: 'selection', skill: 'tighten-prose', files: '**/*.md', key: 'ctrlcmd+alt+t' },
                { id: 'continuity', label: 'Check Continuity of This Chapter', on: 'file', skill: 'continuity-check', files: 'chapters/*.md' },
                { id: 'in-voice', label: 'Is This in Character?', on: 'selection', files: 'chapters/*.md',
                    prompt: 'Check the selected passage against the character files in characters/. Do not edit. Point out, with `show`, any line where someone speaks or acts against what their file says, and say why in a sentence each.' }
            ],
            layout: { left: ['chapters', 'cast', 'loose-ends', 'length', 'tour', 'explorer'], right: ['chat'], bottom: ['activity'], hide: HIDE_DEVELOPER_VIEWS }
        }),
        ...skill('tighten-prose', 'Tighten a passage of fiction without changing its voice or what happens in it.', `
Work only on the passage the author selected.

Cut what a careful reader would not miss: filter words (felt, saw, noticed, seemed to), stacked adjectives, stage directions that
restate the dialogue, sentences that say the previous sentence again. Prefer cutting to rewriting. Keep the author's rhythm, their
sentence fragments, their dialect and their punctuation habits, even where a style guide would object.

Never change what happens, who knows what, or any name, number or fact. If a sentence is unclear rather than loose, do not guess:
leave it and say so in your closing words.

Propose one \`edit\` per sentence or small group of sentences, so each cut can be taken or left on its own. The \`why\` names what
was cut and what the sentence gains, in plain words ("drops 'she noticed that': we are already in her head").
Finish by saying how many words came out.`),
        ...skill('continuity-check', 'Check a chapter against the character files and the earlier chapters for contradictions.', `
Read the chapter you were given, the files in characters/, and every earlier chapter in chapters/ (by file name order).

Look for facts the chapter gets wrong against what is already established: ages, eye and hair colour, who has met whom, what a
character knows at this point, distances and travel times, the day of the week and the weather, objects that were lost or broken,
spellings of names and places.

Do not edit the manuscript. For each contradiction use \`show\` twice: once on the line in this chapter, once on the earlier line or
character file it contradicts. The \`why\` states both facts side by side ("Here Ines is left-handed; chapter 2 has her sign with
her right").

Things that are merely unestablished are not contradictions; leave them. If you find nothing, say so in one sentence.`)
    }
};

const CONTRACTS: WorkbenchProfile = {
    id: 'contracts',
    label: 'Contracts and legal drafting',
    description: 'agreements as *.md · clause outline, defined terms, cross-references, open points',
    files: {
        [WORKBENCH_FILE]: workbench({
            title: 'Contract',
            views: [
                { id: 'clauses', title: 'Clauses', kind: 'outline', icon: 'law', files: '**/*.md', depth: 3 },
                { id: 'defined-terms', title: 'Defined Terms', kind: 'matches', icon: 'symbol-key', files: '**/*.md',
                    pattern: '["“]([A-Z][^"”]+)["”]\\*{0,2} (?:means|has the meaning|shall mean)', group: 'none' },
                { id: 'cross-references', title: 'Cross-References', kind: 'matches', icon: 'references', files: '**/*.md',
                    pattern: '((?:[Cc]lause|[Ss]ection|Schedule|Annex) \\d+(?:\\.\\d+)*)', group: 'match' },
                { id: 'open-points', title: 'Open Points', kind: 'matches', icon: 'question', files: '**/*.md',
                    pattern: '\\[([^\\]\\[]*(?:TBC|TBD|to be (?:agreed|confirmed)|insert|\\?\\?)[^\\]\\[]*)\\]', group: 'file' }
            ],
            actions: [
                { id: 'check-terms', label: 'Check Defined Terms', on: 'file', skill: 'defined-terms-check', files: '**/*.md' },
                { id: 'check-references', label: 'Check Cross-References', on: 'file', skill: 'cross-reference-check', files: '**/*.md' },
                { id: 'plain-language', label: 'Explain in Plain Language', on: 'selection', files: '**/*.md',
                    prompt: 'Explain the selected provision in plain language for a non-lawyer: what it obliges whom to do, when, and what happens otherwise. Do not edit. If its effect depends on another clause or a definition, point to that with `show`. This is an explanation of the text, not legal advice.' }
            ],
            layout: { left: ['clauses', 'defined-terms', 'cross-references', 'open-points', 'tour', 'explorer'], right: ['chat'], bottom: ['activity'], hide: HIDE_DEVELOPER_VIEWS }
        }),
        ...skill('defined-terms-check', 'Check a contract for defined terms that are unused, undefined, defined twice or used inconsistently.', `
Read the whole document. Build two lists: terms that are defined (a capitalised term in quotation marks followed by "means",
"has the meaning" or "shall mean", or a term introduced in brackets such as (the "Supplier")), and capitalised terms that are used
as if they were defined.

Report, most serious first:
1. Terms used but never defined.
2. Terms defined more than once, or defined differently in two places.
3. A defined term also used in lower case or in a variant form ("the Service" / "the Services") where the defined meaning seems intended.
4. Terms defined and never used.

Use \`show\` for each finding, on the line where the problem is visible; for 2 and 3 show both places. Where the fix is mechanical and
certain (a variant spelling of a defined term), propose it with \`edit\`, one occurrence per stop. Where the fix needs a decision
(what an undefined term should mean), do not draft a definition: say what has to be decided.

Do not touch anything else in the document. Do not comment on the commercial terms. Ordinary capitalised words (party names,
headings, "Agreement" at the start of a sentence) are not findings.`),
        ...skill('cross-reference-check', 'Check that every clause, section, schedule and annex reference in a contract points at something that exists and is the right thing.', `
Read the whole document and note its numbering: every heading or numbered provision, schedules and annexes included.

Then go through every internal reference ("clause 7.2", "Section 4", "Schedule 1"). For each, check that the target exists and
that it is plausibly the provision meant: a reference to "the limitation of liability in clause 9" should land on a clause that
limits liability.

Use \`show\` on each reference that points at nothing, and on each that points at the wrong provision, naming the clause it most
likely means. Propose an \`edit\` only when exactly one target fits; otherwise leave the decision to the drafter.

References to other documents and to statutes are out of scope. If everything resolves, say so in one sentence.`)
    }
};

const COPY_EDITING: WorkbenchProfile = {
    id: 'copy-editing',
    label: 'Copy-editing',
    description: 'articles as *.md, style-sheet.md · style sheet at hand, author queries, lengths',
    files: {
        [WORKBENCH_FILE]: workbench({
            title: 'Copy desk',
            views: [
                { id: 'style-sheet', title: 'Style Sheet', kind: 'document', icon: 'note', file: 'style-sheet.md', area: 'right' },
                { id: 'queries', title: 'Author Queries', kind: 'matches', icon: 'comment-discussion', files: '**/*.md', pattern: '\\[AQ: ?(.+?)\\]', group: 'file' },
                { id: 'length', title: 'Length', kind: 'counts', icon: 'graph', files: '**/*.md', unit: 'words' }
            ],
            actions: [
                { id: 'copy-edit', label: 'Copy-Edit This Passage', on: 'selection', skill: 'copy-edit', files: '**/*.md', key: 'ctrlcmd+alt+e' },
                { id: 'copy-edit-file', label: 'Copy-Edit This File', on: 'file', skill: 'copy-edit', files: '**/*.md' },
                { id: 'record-decision', label: 'Record as Style Decision', on: 'selection', files: '**/*.md',
                    prompt: 'The selected text shows a style choice worth keeping consistent. Add it to style-sheet.md under the fitting heading, as one line with this instance as the example. If the sheet already rules on it differently, do not change the sheet: tell me about the conflict.' }
            ],
            layout: { left: ['queries', 'length', 'tour', 'explorer'], right: ['style-sheet', 'chat'], bottom: ['activity'], hide: HIDE_DEVELOPER_VIEWS }
        }),
        'style-sheet.md': `# Style sheet

The decisions for this publication. The copy-edit skill reads this file before it changes anything; a decision recorded here is
applied everywhere, and nothing is "corrected" that this sheet allows.

## Spelling and hyphenation

- British spelling with -ize endings (organize, recognize; but analyse).

## Numbers and dates

- One to nine in words, 10 and up in figures; always figures with units (5 km).
- Dates as 3 March 2026.

## Punctuation

- Serial comma only where it prevents ambiguity.
- Single quotation marks; double for quotes within quotes.

## Names and terms

`,
        ...skill('copy-edit', 'Copy-edit text against style-sheet.md: correct errors, apply house style, and query the author instead of rewriting.', `
Read style-sheet.md first. It decides. Where it is silent, follow the usage the text itself already has most often, and do not
impose a preference of your own.

Correct: spelling, grammar, punctuation, house style, inconsistencies within the piece (a name spelt two ways, a figure that
changes), and obvious slips of fact that the text itself contradicts.

Do not: restructure, change the argument, swap words for ones you like better, or smooth out the author's voice. A sentence that is
grammatical and clear stays as it is.

Where something is wrong but the fix needs the author (an ambiguous sentence, a claim that looks doubtful, a missing source), do
not fix it. Insert a query after the passage in the form [AQ: your question] with one \`edit\`.

One \`edit\` per correction, or per group of identical corrections within one paragraph. The \`why\` cites the rule: "style sheet:
figures from 10 up", "subject-verb agreement", "consistency: 'Mbeki' in paragraph 2". A reviewer must be able to accept or reject
each change without reading the others.

If you made a style choice the sheet does not cover and that will recur, say so at the end and offer to record it.`)
    }
};

const SOFTWARE: WorkbenchProfile = {
    id: 'software',
    label: 'Software project',
    description: 'any code base · notes left in the code, docs outline; keeps the developer views',
    files: {
        [WORKBENCH_FILE]: workbench({
            title: 'Code',
            views: [
                { id: 'notes-in-code', title: 'Notes in Code', kind: 'matches', icon: 'bookmark', files: '**/*.{js,jsx,ts,tsx,java,kt,py,go,rs,cs,rb,c,h,cpp,html,css,scss}',
                    pattern: '(?:TODO|FIXME|HACK|XXX)\\b[:\\s]*(.*)', group: 'file', area: 'bottom' },
                { id: 'docs', title: 'Docs', kind: 'outline', icon: 'book', files: '**/*.md', depth: 2 }
            ],
            actions: [
                { id: 'explain', label: 'Walk Me Through This', on: 'selection',
                    prompt: 'Walk me through the selected code: what it does, and the places elsewhere in the code base it depends on or that depend on it. Use `show` for those places. Do not edit.' },
                { id: 'cover', label: 'Write a Test for This', on: 'selection',
                    prompt: 'Write a test for the selected code. Read the existing tests first and follow their framework, naming and layout. Cover the behaviour and one edge case that is likely to break; do not change the code under test.' }
            ]
        })
    }
};

export const PROFILES: WorkbenchProfile[] = [SOFTWARE, MANUSCRIPT, CONTRACTS, COPY_EDITING];
