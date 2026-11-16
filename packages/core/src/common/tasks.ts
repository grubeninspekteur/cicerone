/**
 * Splits what was typed into a dispatch box into tasks. A bulleted or numbered list of two or more
 * items is a fan-out, one agent per item; anything else is one task, however many lines it has.
 */
export function parseTasks(text: string): string[] {
    const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim());
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
    if (lines.length >= 2 && lines.every(line => bullet.test(line))) {
        return lines.map(line => bullet.exec(line)![1].trim()).filter(Boolean);
    }
    const whole = text.trim();
    return whole ? [whole] : [];
}
