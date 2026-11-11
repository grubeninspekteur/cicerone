import { URI } from '@theia/core';

export const EditValidator = Symbol('EditValidator');

/**
 * Checks what a file would contain after an edit, for files the product itself gives meaning to
 * (its workbench description, skills). The findings go back to the model with the edit's result, so
 * it can correct itself in the same turn instead of leaving the human a broken file to accept.
 */
export interface EditValidator {
    /** @returns problems worded for the model, or nothing when the content is fine or not this validator's concern */
    validate(uri: URI, path: string, proposed: string): Promise<string[] | undefined> | string[] | undefined;
}
