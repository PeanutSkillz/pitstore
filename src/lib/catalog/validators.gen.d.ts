// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Types for the validators that schemas/generate.js writes to validators.gen.js.

export interface ValidationError {
    instancePath: string;
    keyword: string;
    message?: string;
}

export interface Validator {
    (data: unknown): boolean;
    errors?: ValidationError[] | null;
}

export const validate_store: Validator;
export const validate_index: Validator;
export const validate_index_app: Validator;
export const validate_meta: Validator;
export const validate_compose: Validator;
