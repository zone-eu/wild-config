// @ts-check
/* eslint no-console: 0, global-require: 0 */
'use strict';

if (process.env.DISABLE_WILD_CONFIG === 'true') {
    // @ts-ignore
    return;
}

const EventEmitter = require('events');
const env =
    (process.env.NODE_ENV || '')
        .toString()
        .toLowerCase()
        .replace(/[^0-9a-z-_]/g, '') || 'development';

const fs = require('fs');
const glob = require('glob');
const toml = require('toml');
const path = require('path');
const deepExtend = require('deep-extend');
const configDirectory = process.env.NODE_CONFIG_DIR || path.join(process.cwd(), 'config');
const events = new EventEmitter();
const vm = require('vm');

const argList = process.argv.slice(2);

// Populate environment variables into cli arguments
// appconf_key_name=123 becomes --key.name=123
Object.keys(process.env).forEach(key => {
    if (/^appconf_/i.test(key)) {
        let cKey = key.substring('appconf_'.length).replace(/_/g, '.');
        if (!argList.some(e => e.indexOf(`--${cKey}=`) >= 0)) {
            argList.push(`--${cKey}=${process.env[key]}`);
        }
    }
});

/** @type {Record<string, any>} */
const argv = require('minimist')(argList);
const configPath = process.env.NODE_CONFIG_PATH || argv.config || false;

events.setMaxListeners(0);

module.exports = {
    configDirectory
};

/**
 * Loads configuration files, environment overrides and CLI overrides into the
 * exported configuration object.
 *
 * @param {boolean} [skipEvent] If true, skips emitting the reload event after loading.
 * @returns {void}
 */
let loadConfig = skipEvent => {
    /** @type {(import('./index').ConfigObject | import('./index').ConfigValue[])[]} */
    let sources = [{}];

    /**
     * Rewrites TOML include directives into placeholder keys that the TOML
     * parser can read.
     *
     * @param {string} basePath Directory used to resolve relative include paths.
     * @param {string} contents Raw TOML file contents.
     * @returns {string} TOML contents with include directives replaced.
     */
    function extendToml(basePath, contents) {
        // # @include "/path/to/toml"
        let c = 0;

        /**
         * Resolves an include directive match into a placeholder assignment.
         *
         * @param {string} match Full include directive match.
         * @param {string} p Include path or glob from the directive.
         * @returns {string} Placeholder assignment containing matched file paths.
         */
        const replaceInclude = (match, p) => {
            if (!path.isAbsolute(p)) {
                p = path.join(basePath, p);
            }
            p = p.replace(/\{ENV\}/gi, env);

            /** @type {string[]} */
            let files;
            if (p.indexOf('*') >= 0) {
                files = glob.sync(p);
            } else {
                files = [p];
            }

            files.forEach(file => {
                const stat = fs.statSync(file);

                if (!stat.isFile()) {
                    throw new Error(file + ' is not a file');
                }
            });
            return '__include_file_path_' + ++c + '=' + JSON.stringify(files);
        };

        return contents.replace(/^\s*#\s*@include\s*"([^"]+)"/gim, replaceInclude);
    }

    /**
     * Parses a supported configuration file.
     *
     * @param {string} filePath Path to a JavaScript, TOML or JSON configuration file.
     * @returns {import('./index').ConfigObject | import('./index').ConfigValue[] | undefined} Parsed configuration data, or undefined for unsupported extensions.
     */
    function parseFile(filePath) {
        let pathParts = path.parse(filePath);
        let ext = pathParts.ext.toLowerCase();
        let basePath = pathParts.dir;
        /** @type {import('./index').ConfigObject | import('./index').ConfigValue[] | undefined} */
        let parsed;
        try {
            let contents = fs.readFileSync(filePath, 'utf-8');

            switch (ext) {
                case '.js': {
                    let script = new vm.Script(contents);
                    /** @type{vm.Context} */
                    const sandbox = {
                        require,
                        __dirname: basePath,
                        __filename: filePath,
                        module: {
                            exports: {}
                        }
                    };
                    script.runInNewContext(sandbox);
                    parsed = sandbox.module.exports;
                    break;
                }
                case '.toml':
                    parsed = tomlParser(basePath, contents);
                    break;
                case '.json':
                    parsed = JSON.parse(contents);
                    break;
            }
        } catch (E) {
            let err = /** @type {Error & { code?: string }} */ (E);
            err.message = filePath + ': ' + err.message;
            throw err;
        }
        return parsed;
    }

    /**
     * Parses TOML contents and expands any nested include directives.
     *
     * @param {string} basePath Directory used to resolve relative include paths.
     * @param {string} contents Raw TOML file contents.
     * @returns {import('./index').ConfigObject} Parsed TOML configuration object.
     */
    function tomlParser(basePath, contents) {
        let parsed = toml.parse(extendToml(basePath, contents));
        // find includes
        /**
         * Walks parsed TOML values and replaces include placeholders with parsed
         * file contents.
         *
         * @param {import('./index').ConfigValue} node Current value being inspected.
         * @param {import('./index').ConfigObject | import('./index').ConfigValue[] | false} parentNode Parent object or array for the current value.
         * @param {string | false} nodeKey Key for the current value in the parent object.
         * @param {number} level Current recursion depth.
         * @returns {void}
         */
        let walk = (node, parentNode, nodeKey, level) => {
            if (level > 100) {
                throw new Error('Too much nesting in configuration file');
            }

            if (Array.isArray(node)) {
                node.forEach(entry => walk(entry, node, false, level + 1));
            } else if (node && typeof node === 'object') {
                Object.keys(node || {}).forEach(key => {
                    if (/^__include_file_path_\d+$/.test(key) && Array.isArray(node[key])) {
                        let filePaths = /** @type {string[]} */ (node[key]);
                        delete node[key];
                        filePaths.forEach(filePath => {
                            let parsed = parseFile(filePath);
                            if (!parsed) {
                                return;
                            } else if (Array.isArray(parsed)) {
                                if (parentNode && !Array.isArray(parentNode) && nodeKey && Object.keys(node).length === 0) {
                                    parentNode[nodeKey] = parsed;
                                }
                            } else {
                                Object.keys(parsed || {}).forEach(subKey => {
                                    node[subKey] = parsed[subKey];
                                });
                            }
                        });
                    } else if (node[key] && typeof node[key] === 'object') {
                        walk(node[key], node, key, level + 1);
                    }
                });
            }
        };

        walk(parsed, false, false, 0);

        return parsed;
    }

    /**
     * Loads a configuration source and appends parsed data to the merge list.
     *
     * @param {string | false} filePath Path to load, or false to skip loading.
     * @param {boolean} [ignoreMissing] If true, ignores missing files.
     * @returns {void}
     */
    let loadFromFile = (filePath, ignoreMissing) => {
        if (!filePath) {
            // do nothing
            return;
        }
        try {
            let parsed = parseFile(filePath);
            if (parsed) {
                sources.push(parsed);
            }
        } catch (E) {
            let err = /** @type {Error & { code?: string }} */ (E);
            if (err.code !== 'ENOENT' || !ignoreMissing) {
                // file missing, ignore
                console.error('[' + filePath + '] ' + err.message);
                process.exit(1);
            }
        }
    };

    try {
        let listing = fs.readdirSync(configDirectory);
        listing
            .map(file => ({
                name: file,
                isDefault: file.toLowerCase().indexOf('default.') === 0,
                path: path.join(configDirectory, file)
            }))
            .filter(file => {
                let parts = path.parse(file.name);
                if (!['.toml', '.json', '.js'].includes(parts.ext.toLowerCase())) {
                    return false;
                }
                if (!['default', env].includes(parts.name.toLowerCase())) {
                    return false;
                }
                return true;
            })
            .sort((a, b) => {
                if (a.isDefault) {
                    return -1;
                }
                if (b.isDefault) {
                    return 1;
                }
                return a.path.localeCompare(b.path);
            })
            .forEach(file => loadFromFile(file.path));
    } catch {
        // failed to list files
    }

    // try user specified file
    loadFromFile(configPath);

    // join found files
    /** @type {import('./index').ConfigObject} */
    let data = /** @type {import('./index').ConfigObject} */ (/** @type {any} */ (deepExtend)(...sources));

    delete argv._;
    delete argv.config;

    /**
     * Coerces CLI and environment override values to match existing config
     * value types before merging them.
     *
     * @param {import('./index').ConfigObject} cParent Existing configuration branch.
     * @param {import('./index').ConfigObject} eParent Override configuration branch.
     * @returns {void}
     */
    let walkConfig = (cParent, eParent) => {
        Object.keys(eParent || {}).forEach(key => {
            if (!(key in cParent)) {
                return;
            }

            if (typeof cParent[key] === 'object') {
                if (!cParent[key]) {
                    // null
                    return;
                }
                if (typeof eParent[key] === 'object') {
                    if (!eParent[key]) {
                        // null
                        return;
                    }
                    return walkConfig(
                        /** @type {import('./index').ConfigObject} */ (cParent[key]),
                        /** @type {import('./index').ConfigObject} */ (eParent[key])
                    );
                }
                if (typeof eParent[key] === 'string' && Array.isArray(cParent[key])) {
                    eParent[key] = eParent[key].trim().split(/\s*,\s*/);
                    return;
                }
            }

            let value = eParent[key];

            if (typeof cParent[key] === 'number') {
                eParent[key] = Number(eParent[key]);
            } else if (typeof cParent[key] === 'boolean') {
                if (!isNaN(/** @type {any} */ (value))) {
                    value = Number(value);
                } else {
                    value = (/** @type {string} */ (value)).toLowerCase();
                }
                let falsy = ['false', 'null', 'undefined', 'no', '0', '', 0];
                eParent[key] = falsy.includes(/** @type {string | number} */ (value)) ? false : !!value;
            }
        });
    };

    if (Object.keys(argv || {}).length) {
        walkConfig(data, argv);
        data = deepExtend(data, argv);
    }

    Object.keys(data).forEach(key => {
        if (key !== 'on') {
            /** @type {import('./index').WildConfig} */ (module.exports)[key] = data[key];
        }
    });

    if (!skipEvent) {
        events.emit('reload');
    }
};
/** @type {EventEmitter & { reload?: typeof loadConfig }} */ (events).reload = loadConfig;

Object.defineProperty(module.exports, 'on', {
    enumerable: false,
    configurable: false,
    writable: false,
    /**
     * Registers a listener on the internal configuration event emitter.
     *
     * @type {import('./index').WildConfig['on']}
     */
    value: (...args) => events.on(...args)
});

loadConfig(true);
