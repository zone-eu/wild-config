declare namespace wildConfig {
    /** Primitive values supported in configuration data. */
    export type ConfigPrimitive = string | number | boolean | null | undefined;

    /**
     * Function values supported in JavaScript configuration data.
     *
     * @param args Arguments passed by code that consumes the config value.
     * @returns The function result.
     */
    export type ConfigFunction = (...args: unknown[]) => unknown;

    /** Any value that can appear in a loaded configuration object. */
    export type ConfigValue = ConfigPrimitive | ConfigObject | ConfigValue[] | ConfigFunction;

    /**
     * Listener invoked by wild-config events.
     *
     * @param args Event arguments forwarded by the underlying EventEmitter.
     * @returns Nothing.
     */
    export type ConfigEventListener = (...args: unknown[]) => void;

    /** Object shape used for loaded configuration branches. */
    export interface ConfigObject {
        [key: string]: ConfigValue;
    }

    /** Registers listeners for wild-config events. */
    export interface WildConfigOn {
        /**
         * Registers a listener for the configuration reload event.
         *
         * @param eventName Event name to listen for.
         * @param listener Listener invoked when configuration is reloaded.
         * @returns The value returned by the underlying EventEmitter.
         */
        (eventName: 'reload', listener: ConfigEventListener): unknown;

        /**
         * Registers a listener for an event on the underlying EventEmitter.
         *
         * @param eventName Event name or symbol to listen for.
         * @param listener Listener invoked when the event is emitted.
         * @returns The value returned by the underlying EventEmitter.
         */
        (eventName: string | symbol, listener: ConfigEventListener): unknown;
    }

    /** Loaded configuration object exported by wild-config. */
    export interface WildConfig {
        [key: string]: ConfigValue | WildConfigOn;

        /** Directory used to discover default and environment configuration files. */
        configDirectory: string;

        /** Registers listeners for configuration events. */
        on: WildConfigOn;
    }
}

/** Loaded configuration object. */
declare const wildConfig: wildConfig.WildConfig;

export = wildConfig;
