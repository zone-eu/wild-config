declare namespace wildConfig {
    export type ConfigPrimitive = string | number | boolean | null | undefined;
    export type ConfigFunction = (...args: unknown[]) => unknown;
    export type ConfigValue = ConfigPrimitive | ConfigObject | ConfigValue[] | ConfigFunction;
    export type ConfigEventListener = (...args: unknown[]) => void;

    export interface ConfigObject {
        [key: string]: ConfigValue;
    }

    export interface WildConfigOn {
        (eventName: 'reload', listener: ConfigEventListener): unknown;
        (eventName: string | symbol, listener: ConfigEventListener): unknown;
    }

    export interface WildConfig {
        [key: string]: ConfigValue | WildConfigOn;
        configDirectory: string;
        on: WildConfigOn;
    }
}

declare const wildConfig: wildConfig.WildConfig;

export = wildConfig;
