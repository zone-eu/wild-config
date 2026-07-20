'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const nodemailerConfig = require('eslint-config-nodemailer');
const prettierConfig = require('eslint-config-prettier/flat');

module.exports = [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node
            }
        },
        rules: {
            ...nodemailerConfig.rules,
            indent: 'off',
            'global-require': 'off',
            'no-await-in-loop': 'off'
        }
    },
    prettierConfig
];
