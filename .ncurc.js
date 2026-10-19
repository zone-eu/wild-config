'use strict';

module.exports = {
    upgrade: true,
    // wild-config is bundled into standalone binaries with @yao-pkg/pkg (EmailEngine), which only
    // supports CommonJS. Any dependency upgrade that ships as pure ESM breaks those builds, so such
    // upgrades must be rejected here and the dependency kept on its last CommonJS-compatible release.
    reject: [
        // 7.x fails `npm run typecheck` on index.js (TS2309, it treats the Object.defineProperty
        // on module.exports as an extra export next to the module.exports assignment). 6.0.3 passes.
        // Lift once the typecheck is clean on 7.x.
        'typescript'
    ]
};
