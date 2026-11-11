import { BUILTIN_VIEWS, SKILLS_DIRECTORY, WORKBENCH_FILE } from './workbench.js';

export const WORKBENCH_SKILL_NAME = 'workbench';
export const WORKBENCH_SKILL_DESCRIPTION =
    'Change the editor itself for the user: add or alter views, the panel layout, context-menu actions, and the skills behind them.';

/** What the agent needs to reshape the workbench. Only read when the user asks for that, so it can afford to be complete. */
export const WORKBENCH_SKILL = `# Shaping the workbench

The user's workbench is described by \`${WORKBENCH_FILE}\` in the workspace. You change the editor by editing that file with \`edit\`;
it takes effect when the change is written. Skills are folders under \`${SKILLS_DIRECTORY}/\`. Read the current file first (it may not exist yet).

Start from what the user does all day, not from the feature list. Ask if you do not know. Add few things; each view should answer a question they
actually ask ("where does this term appear?", "how long is each chapter?"). Give every stop a \`why\` in their terms.

## ${WORKBENCH_FILE}

\`\`\`json
{
  "title": "Manuscript",
  "views": [ ... ],
  "actions": [ ... ],
  "layout": { "left": ["chapters", "explorer"], "right": ["chat"], "bottom": ["activity"], "hide": ["terminal", "debug", "scm", "test"] }
}
\`\`\`

### views
Every view has \`id\` (kebab-case), \`title\`, \`kind\`, optional \`icon\` (a codicon name such as book, person, law, checklist, quote, symbol-key, note, graph)
and optional \`area\` (left, right, bottom; default left). Entries in a view open the file at the right line.

| kind | shows | fields |
|---|---|---|
| outline | headings of markdown files as a table of contents | \`files\` (glob), \`depth\` (default 2) |
| matches | every match of a regular expression | \`files\`, \`pattern\` (first capture group is the label), \`group\`: file (default), match (one entry per distinct match with its occurrences, good for terms and names), none |
| files | one card per file: title plus chosen front-matter fields | \`files\`, \`fields\` |
| counts | words (or lines) per file, total, progress to a target | \`files\`, \`unit\`: words or lines, \`target\` |
| document | one markdown file rendered for reading (a style sheet, a brief, a list you maintain) | \`file\` |

A view may name an \`action\` id; it appears as a button in the view (typical for a document the agent regenerates).
Patterns are matched line by line and must work in both JavaScript and Rust regex syntax; escape backslashes for JSON.

### actions
An action puts a command in the context menu and the command palette. Running it sends you a request.
- \`id\`, \`label\` (what the menu says, imperative: "Tighten This Passage")
- \`on\`: selection (editor context menu, needs selected text), file (editor and file-tree context menus), workspace (command palette only)
- \`skill\`: name of the skill you will load, and/or \`prompt\`: a short instruction
- optional \`files\` (glob, limits where it is offered), \`key\` (e.g. "ctrlcmd+alt+t")

### layout
Lists of view ids per area, in order; the first of each list is brought to the front. \`hide\` closes views. Besides the ids you define:
${Object.entries(BUILTIN_VIEWS).map(([id, view]) => `${id} (${view.description})`).join(', ')}.
Only include \`layout\` when the user wants the arrangement changed; applying it moves their panels.

## Skills
A skill is \`${SKILLS_DIRECTORY}/<name>/SKILL.md\`:

\`\`\`markdown
---
name: <name, same as the folder, kebab-case>
description: <one sentence: what it does and when to use it. This line is all that is loaded until the skill is used.>
---
<Instructions to yourself: what to read, what to check, what a good result looks like, what to leave alone.>
\`\`\`

Write the skill for the user's material: name their files, their conventions, their standards. A skill that would fit any workspace is too vague.
Keep it under a page. If an action needs a skill that does not exist, create both.
`;
