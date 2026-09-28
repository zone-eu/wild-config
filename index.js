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
const toml = require('toml');
const path = require('path');
const deepExtend = require('deep-extend');
const configDirectory = process.env.NODE_CONFIG_DIR || path.join(process.cwd(), 'config');
const events = new EventEmitter();
const vm = require('vm');

const minimist = require('minimist');

const cliArgs = process.argv.slice(2);

// APPCONF_ prefixed environment variables, for example appconf_key_name=123 becomes --key.name=123.
// The names are mapped to config paths once the config files are loaded, see resolveEnvKey().
const envOverrides = Object.keys(process.env)
    .filter(key => /^appconf_/i.test(key))
    .map(key => ({ name: key.substring('appconf_'.length), value: process.env[key] }));

/**
 * Parses override arguments. Every option that is given a value keeps it as the raw string:
 * minimist would otherwise turn "12345678" into a Number and "0012" into 12, which breaks
 * string settings such as secrets. walkConfig() converts values toward the type of the
 * existing config value instead.
 *
 * `--key value` pairs are rewritten to `--key=value` here, so minimist only ever sees the
 * unambiguous form and its own rule for when the next token is a value does not matter.
 * Bare flags, `--no-key` and short options are left for minimist.
 *
 * @param {string[]} list Arguments in the --key=value or --key value form.
 * @returns {{ argv: Record<string, any>, keys: Set<string> }} Parsed arguments and every long option name seen.
 */
let parseArgs = list => {
    /** @type {string[]} */
    let args = [];
    /** @type {string[]} */
    let stringKeys = [];
    let keys = new Set();
    for (let i = 0; i < list.length; i++) {
        let arg = list[i];
        if (arg === '--') {
            // minimist treats everything after this as positional
            args.push(...list.slice(i));
            break;
        }
        let match = arg.match(/^--([^=]+)(=?)/);
        if (!match) {
            args.push(arg);
            continue;
        }
        let key = match[1];
        if (/^no-/.test(key) && !match[2]) {
            keys.add(key.substring(3));
            args.push(arg);
            continue;
        }
        keys.add(key);
        let next = list[i + 1];
        if (!match[2] && next !== undefined && !/^-./.test(next)) {
            arg = '--' + key + '=' + next;
            i++;
        }
        if (arg.includes('=')) {
            stringKeys.push(key);
        }
        args.push(arg);
    }
    return { argv: minimist(args, { string: stringKeys }), keys };
};

/** @type {Record<string, any>} */
const startupArgv = minimist(cliArgs, { string: ['config'] });
const envConfigPath = envOverrides.find(entry => entry.name.toLowerCase() === 'config');
const configPath = process.env.NODE_CONFIG_PATH || startupArgv.config || (envConfigPath && envConfigPath.value) || false;
// Command line arguments win over environment variables for the same key
const cliKeys = parseArgs(cliArgs).keys;

/**
 * Maps the part of an APPCONF_ variable name after the prefix to a config path. Segments match
 * existing keys case-insensitively (an exact match wins), and consecutive segments are joined
 * back with underscores when the config has such a key, so APPCONF_SERVER_MAX_SIZE reaches
 * server.max_size. Anything that matches no existing key keeps the plain mapping where every
 * underscore is a dot.
 *
 * @param {import('./index').ConfigObject} data Loaded configuration.
 * @param {string} name Variable name without the APPCONF_ prefix.
 * @returns {string} Dotted config path.
 */
let resolveEnvKey = (data, name) => {
    let segments = name.split('_');

    /**
     * @param {import('./index').ConfigValue} node
     * @param {number} start
     * @returns {string[] | null}
     */
    let resolve = (node, start) => {
        if (start >= segments.length) {
            return [];
        }
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return null;
        }
        let branch = /** @type {import('./index').ConfigObject} */ (node);
        let keys = Object.keys(branch);
        /** @type {Map<string, string>} */
        let lowerKeys = new Map();
        keys.forEach(k => {
            // first key wins, as a linear search would pick it
            if (!lowerKeys.has(k.toLowerCase())) {
                lowerKeys.set(k.toLowerCase(), k);
            }
        });
        // Longest candidate first, so an existing key that contains underscores is preferred
        for (let end = segments.length; end > start; end--) {
            let candidate = segments.slice(start, end).join('_');
            let key = keys.includes(candidate) ? candidate : lowerKeys.get(candidate.toLowerCase());
            if (key) {
                let rest = resolve(branch[key], end);
                if (rest) {
                    return [key].concat(rest);
                }
            }
        }
        return null;
    };

    let resolved = resolve(data, 0);
    return (resolved || segments).join('.');
};

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
                files = expandWildcard(p);
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

    // Hand-written instead of fs.globSync, which needs Node 22 while the engines floor is Node 20
    /**
     * Expands a wildcard include path. Wildcards (`*` and `?`) are supported in the file name
     * only, optionally below a `**` directory segment that also searches every subdirectory,
     * for example "sub/*.toml" or "sub/**" + "/*.toml". Names starting with a dot only match a
     * pattern that starts with a dot. Matches are sorted, so the merge order (later files win)
     * does not depend on the order the filesystem lists them in.
     *
     * @param {string} pattern Include path containing a wildcard.
     * @returns {string[]} Sorted list of matching paths.
     */
    function expandWildcard(pattern) {
        let dir = path.dirname(pattern);
        let base = path.basename(pattern);
        let recursive = false;
        if (path.basename(dir) === '**') {
            recursive = true;
            dir = path.dirname(dir);
        }
        if (/[*?]/.test(dir)) {
            throw new Error('Unsupported include pattern "' + pattern + '", wildcards are only allowed in the file name');
        }

        let matcher = new RegExp(
            '^' +
                base
                    .split('')
                    .map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$.+()[\]{}|]/g, '\\$&')))
                    .join('') +
                '$'
        );

        /** @type {string[]} */
        let files = [];

        /**
         * @param {string} directory
         * @returns {void}
         */
        let scan = directory => {
            /** @type {fs.Dirent[]} */
            let entries;
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch (E) {
                let err = /** @type {Error & { code?: string }} */ (E);
                if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
                    // nothing to include, same as a pattern that matches no file
                    return;
                }
                throw err;
            }
            entries.forEach(entry => {
                if (entry.name.charAt(0) === '.' && base.charAt(0) !== '.') {
                    return;
                }
                let entryPath = path.join(directory, entry.name);
                if (matcher.test(entry.name)) {
                    files.push(entryPath);
                }
                if (recursive && entry.isDirectory()) {
                    scan(entryPath);
                }
            });
        };
        scan(dir);

        return files.sort((a, b) => a.localeCompare(b, 'en'));
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
     * @returns {void}
     */
    let loadFromFile = filePath => {
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
            console.error('[' + filePath + '] ' + err.message);
            process.exit(1);
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

    let argList = cliArgs.slice();
    envOverrides.forEach(({ name, value }) => {
        let key = resolveEnvKey(data, name);
        if (!cliKeys.has(key)) {
            argList.push(`--${key}=${value}`);
        }
    });

    /** @type {Record<string, any>} */
    let argv = parseArgs(argList).argv;
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

            if (Array.isArray(eParent[key]) && !Array.isArray(cParent[key])) {
                // A repeated flag for a single value: the last one wins
                let list = /** @type {import('./index').ConfigValue[]} */ (eParent[key]);
                eParent[key] = list[list.length - 1];
            }

            let value = eParent[key];

            if (typeof cParent[key] === 'number') {
                eParent[key] = Number(eParent[key]);
            } else if (typeof cParent[key] === 'boolean') {
                if (!isNaN(/** @type {any} */ (value))) {
                    value = Number(value);
                } else {
                    value = /** @type {string} */ (value).toLowerCase();
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

    // A reload has to drop keys that are no longer in the config, not only overwrite the rest
    let exported = /** @type {Record<string, any>} */ (module.exports);
    let stale = new Set(Object.keys(exported));
    stale.delete('configDirectory');
    Object.keys(data).forEach(key => {
        stale.delete(key);
        // A config file may define a key named "on", assigning it would throw on the read-only method
        if (key !== 'on') {
            exported[key] = data[key];
        }
    });
    stale.forEach(key => delete exported[key]);

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
