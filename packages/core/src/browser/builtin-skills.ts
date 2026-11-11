export const BuiltinSkillContribution = Symbol('BuiltinSkillContribution');

/** A skill that ships with the product instead of living in the workspace. */
export interface BuiltinSkill {
    /** kebab-case; what the model passes to the `skill` tool. */
    name: string;
    /** One line: when to load it. This line is the only part that costs tokens on every request. */
    description: string;
    /** The instructions, loaded on demand. */
    content: string | (() => Promise<string>);
}

export interface BuiltinSkillContribution {
    getSkills(): BuiltinSkill[];
}
