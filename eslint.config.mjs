import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const eslintConfig = [
    {
        ignores: [
            '.next/**',
            'node_modules/**',
            'dist/**',
            'build/**',
            'release/**',
            'packages/**/dist/**',
        ],
    },
    ...compat.extends('next/core-web-vitals'),
];

export default eslintConfig;
