'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INDEX = path.join(__dirname, '..', 'index.js');
const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Loads wild-config in a fresh child process, since the module reads its environment and
 * arguments once at require time.
 *
 * @param {object} options
 * @param {string} [options.dir] NODE_CONFIG_DIR
 * @param {string[]} [options.args] Command line arguments
 * @param {Record<string, string>} [options.env] Extra environment variables
 * @param {string} [options.script] Code to run, `config` is the loaded module
 * @returns {{ status: number | null, stdout: string, stderr: string, result: any }}
 */
function load({ dir, args = [], env = {}, script = 'process.stdout.write(JSON.stringify(config));' }) {
    /** @type {Record<string, string>} */
    let childEnv = {};
    for (let [key, value] of Object.entries(process.env)) {
        // keep the parent's own settings out of the child
        if (/^(appconf_|node_config_|node_env$|disable_wild_config$)/i.test(key) || value === undefined) {
            continue;
        }
        childEnv[key] = value;
    }
    if (dir) {
        childEnv.NODE_CONFIG_DIR = dir;
    }
    Object.assign(childEnv, env);

    let code = `const config = require(${JSON.stringify(INDEX)});\n${script}`;
    let child = spawnSync(process.execPath, ['-e', code, '--', 'wild-config-test', ...args], { env: childEnv, encoding: 'utf-8', cwd: os.tmpdir() });
    let result;
    try {
        result = JSON.parse(child.stdout);
    } catch {
        result = undefined;
    }
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, result };
}

const BASIC = path.join(FIXTURES, 'basic');

test('layers default, NODE_ENV and the application config file', () => {
    let { result } = load({ dir: BASIC });
    assert.strictEqual(result.title, 'default');
    assert.strictEqual(result.server.port, 3000);
    assert.strictEqual(result.configDirectory, BASIC);

    ({ result } = load({ dir: BASIC, env: { NODE_ENV: 'production' } }));
    assert.strictEqual(result.title, 'production');
    assert.strictEqual(result.server.port, 443);
    assert.strictEqual(result.server.host, '127.0.0.1');

    let appConfig = path.join(BASIC, 'app.toml');
    ({ result } = load({ dir: BASIC, env: { NODE_ENV: 'production', NODE_CONFIG_PATH: appConfig } }));
    assert.strictEqual(result.title, 'app');
    assert.strictEqual(result.server.port, 443);
    assert.strictEqual(result.server.host, '0.0.0.0');

    ({ result } = load({ dir: BASIC, args: [`--config=${appConfig}`] }));
    assert.strictEqual(result.title, 'app');
    assert.strictEqual(result.config, undefined);
});

test('--a.b overrides a nested value', () => {
    let { result } = load({ dir: BASIC, args: ['--server.host=10.0.0.1', '--server.tls.cert', 'other.pem'] });
    assert.strictEqual(result.server.host, '10.0.0.1');
    assert.strictEqual(result.server.tls.cert, 'other.pem');
    assert.strictEqual(result.server.port, 3000);
});

test('converts overrides toward the type of the existing value', () => {
    let { result } = load({
        dir: BASIC,
        args: ['--server.port=8080', '--server.enabled=yes', '--server.list=x, y', '--server.max_size=0012', '--title=42']
    });
    assert.strictEqual(result.server.port, 8080);
    assert.strictEqual(result.server.enabled, true);
    assert.deepStrictEqual(result.server.list, ['x', 'y']);
    assert.strictEqual(result.server.max_size, 12);
    assert.strictEqual(result.title, '42');

    ({ result } = load({ dir: BASIC, args: ['--server.enabled=0'] }));
    assert.strictEqual(result.server.enabled, false);

    // a bare flag is still true, not an empty string
    ({ result } = load({ dir: BASIC, args: ['--server.enabled'] }));
    assert.strictEqual(result.server.enabled, true);

    ({ result } = load({ dir: BASIC, args: ['--server.enabled', '--server.port', '81'] }));
    assert.strictEqual(result.server.enabled, true);
    assert.strictEqual(result.server.port, 81);
});

test('keeps numeric-looking values as strings for string and unknown keys', () => {
    let { result } = load({
        dir: BASIC,
        args: ['--server.secret=12345678', '--server.host=0012', '--service.secret=123e4567', '--server.newkey=007', '--server.tls.cert', '99']
    });
    // minimist used to return 12345678, 12, Infinity, 7 and 99 here
    assert.strictEqual(result.server.secret, '12345678');
    assert.strictEqual(result.server.host, '0012');
    assert.strictEqual(result.service.secret, '123e4567');
    assert.strictEqual(result.server.newkey, '007');
    assert.strictEqual(result.server.tls.cert, '99');

    ({ result } = load({ dir: BASIC, env: { APPCONF_server_secret: '0012', APPCONF_service_secret: '12345678' } }));
    assert.strictEqual(result.server.secret, '0012');
    assert.strictEqual(result.service.secret, '12345678');
});

test('--x= gives an empty value and a repeated flag keeps the last one', () => {
    let { result } = load({ dir: BASIC, args: ['--server.host=', '--server.empty='] });
    assert.strictEqual(result.server.host, '');
    assert.strictEqual(result.server.empty, '');

    ({ result } = load({ dir: BASIC, args: ['--server.port=1', '--server.port=2', '--server.secret=a', '--server.secret=b'] }));
    assert.strictEqual(result.server.port, 2);
    assert.strictEqual(result.server.secret, 'b');

    ({ result } = load({ dir: BASIC, args: ['--server.list=x', '--server.list=y'] }));
    assert.deepStrictEqual(result.server.list, ['x', 'y']);
});

test('maps APPCONF_ variables to config paths', () => {
    let { result } = load({
        dir: BASIC,
        env: {
            APPCONF_server_port: '81',
            APPCONF_SERVER_HOST: '10.1.1.1',
            APPCONF_Server_Max_Size: '20',
            APPCONF_server_tls_CERT: 'env.pem',
            APPCONF_brand_new_key: '5'
        }
    });
    assert.strictEqual(result.server.port, 81);
    // upper-case names used to create a separate SERVER.HOST branch
    assert.strictEqual(result.server.host, '10.1.1.1');
    assert.strictEqual(result.SERVER, undefined);
    // keys containing underscores used to be unreachable
    assert.strictEqual(result.server.max_size, 20);
    assert.strictEqual(result.server.tls.cert, 'env.pem');
    // unknown keys keep the plain mapping
    assert.strictEqual(result.brand.new.key, '5');

    // the command line wins over the environment
    ({ result } = load({ dir: BASIC, args: ['--server.port=1'], env: { APPCONF_SERVER_PORT: '2' } }));
    assert.strictEqual(result.server.port, 1);

    // --no-x counts as setting x, so the variable does not flip it back
    ({ result } = load({ dir: BASIC, args: ['--no-server.enabled'], env: { APPCONF_SERVER_ENABLED: 'true' } }));
    assert.strictEqual(result.server.enabled, false);

    let appConfig = path.join(BASIC, 'app.toml');
    ({ result } = load({ dir: BASIC, env: { APPCONF_config: appConfig } }));
    assert.strictEqual(result.title, 'app');
});

test('@include resolves relative paths, {ENV} and wildcards in sorted order', () => {
    let { result, stderr } = load({ dir: path.join(FIXTURES, 'includes') });
    assert.strictEqual(stderr, '');
    // later files win, so the last file in sorted order decides a shared key
    assert.deepStrictEqual(result.inc, { order: 'c', a: true, b: true, c: true });
    assert.deepStrictEqual(result.deep, { order: 'nested', a: true, b: true, c: true, nested: true });
    assert.deepStrictEqual(result.envinc, { envname: 'development' });
    assert.deepStrictEqual(result.rel, { one: 1, two: 2 });

    ({ result } = load({ dir: path.join(FIXTURES, 'includes'), env: { NODE_ENV: 'production' } }));
    assert.deepStrictEqual(result.envinc, { envname: 'production' });
});

test('@include wildcard order does not depend on creation order', t => {
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wild-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'parts'));

    let names = [];
    for (let i = 0; i < 30; i++) {
        names.push(String(i).padStart(2, '0'));
    }
    // create in a shuffled order so directory order and sorted order differ
    let shuffled = names.slice().sort((a, b) => ((Number(a) * 7919) % 31) - ((Number(b) * 7919) % 31));
    for (let name of shuffled) {
        fs.writeFileSync(path.join(dir, 'parts', `${name}.toml`), `last = "${name}"\nk${name} = true\n`);
    }
    fs.writeFileSync(path.join(dir, 'default.toml'), '[parts]\n# @include "parts/*.toml"\n');

    let { result } = load({ dir });
    assert.strictEqual(result.parts.last, '29');
    assert.strictEqual(Object.keys(result.parts).length, 31);
});

test('a TOML syntax error exits with status 1 and names the file', () => {
    let { status, stderr } = load({ dir: path.join(FIXTURES, 'broken') });
    assert.strictEqual(status, 1);
    assert.ok(stderr.includes(path.join(FIXTURES, 'broken', 'default.toml')), stderr);
});

test('config files, arguments and variables cannot pollute prototypes', () => {
    let { result, status } = load({
        dir: path.join(FIXTURES, 'pollution'),
        env: { NODE_ENV: 'production', APPCONF___proto___polluted: 'env', APPCONF_constructor_prototype_polluted: 'env' },
        args: ['--__proto__.polluted=cli', '--constructor.prototype.polluted=cli', '--nested.__proto__.polluted=cli'],
        script: `process.stdout.write(JSON.stringify({
            plain: ({}).polluted === undefined,
            proto: Object.getPrototypeOf(config) === Object.prototype,
            nestedProto: Object.getPrototypeOf(config.nested) === Object.prototype,
            ok: config.ok,
            nested: config.nested.value
        }));`
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(result, { plain: true, proto: true, nestedProto: true, ok: 2, nested: 'x' });
});

test('reload() drops removed keys and DISABLE_WILD_CONFIG skips loading', t => {
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wild-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let file = path.join(dir, 'default.toml');
    fs.writeFileSync(file, 'keep = 1\ngone = 2\n[section]\nvalue = 3\n');

    let { result } = load({
        dir,
        script: `
            const fs = require('fs');
            let reloaded = 0;
            // on() returns the internal emitter, which carries reload()
            const emitter = config.on('reload', () => reloaded++);
            fs.writeFileSync(${JSON.stringify(file)}, 'keep = 10\\n');
            emitter.reload();
            process.stdout.write(JSON.stringify({ config, reloaded, keys: Object.keys(config) }));
        `
    });
    assert.deepStrictEqual(result.config, { configDirectory: dir, keep: 10 });
    assert.strictEqual(result.reloaded, 1);

    ({ result } = load({ dir: BASIC, env: { DISABLE_WILD_CONFIG: 'true' } }));
    assert.deepStrictEqual(result, {});
});
