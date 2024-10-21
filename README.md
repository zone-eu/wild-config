# wild-config

Opinionated configuration management module for Node.js daemon applications.

-   Config files use either [toml](https://github.com/toml-lang/toml), JSON or JavaScript syntax
-   If the config file format is JavaScript, then the value must be exported with "module.exports = {...}"
-   The application can have a config file for default values in ./config/default.toml
-   Main config file path can be provided from a command-line argument, e.g. `--config=/etc/app.toml`
-   Additionally, command-line arguments can be used to override any existing config option

## Loading order

_wild-config_ tries to load configuration in the following order (missing files are skipped, except the one provided by `--config` argument). Values are merged.

1. ./config/default.\*
2. ./config/\$NODE_ENV.\*
3. `NODE_CONFIG_PATH` environment value or `--config` argument value
4. `APPCONF_*` prefixed environment variables
5. command line arguments

> If you want to use a different configuration directory than './config' for default configuration files, then set it with the `NODE_CONFIG_DIR` environment variable

### Environment variables

When using environment variables to provide config values, only such keys are merged that already exist in the configuration object, so you have to define a default value in the config file. Use underscores instead of dots for subkeys. Note that all underscores are interpreted as dots when parsing, which means keys with underscores can't be overriden with environment variables.

Example _config/default.toml_:

```toml
[server]
apiPort=3000
```

Override `server.apiPort` value with the following environment variable:

```
APPCONF_server_apiPort=80
```

This resolves into the following config structure:

```
{
  server: {
    apiPort: 80
  }
}
```

### Command line arguments

Like with the environment variables, when using command-line arguments to provide config values, only such keys are merged that already exist in the configuration object. For subkeys, use dot notation. Value type (numbers, booleans, and strings are supported) is defined by existing value.

Example _config/default.toml_:

```toml
[server]
enabled=false
```

Override `server.enabled` value with the following command-line argument:

```
node app.js --server.enabled=true
```

`server.enabled` is defined as a boolean in the config file, so the overridden value is also going to be `true` as a boolean and not `"true"` as a string.

## TOML extensions

wild-config toml includes additional options when working with toml

### Including child files

Use the following syntax to include an additional config file in the place of the directive.

```toml
# @include "/path/to/sub/config.toml"
```

This directive also works in a nested object.

```toml
[nested]
    # @include "/path/to/sub/config.toml"
```

You can also use wildcards to load data from multiple files.

```toml
# @include "/path/to/sub/*.toml"
# @include "/path/to/sub/**/*.toml"
```

**Notes**

-   Included paths are resolved relative to the path of the configuration file where the include directive is used
-   Included config files do not have to be toml files. Any other supported format works as well
-   If the included config file is a toml file, then it can have its own includes
-   If the config file returns an array, then the array value will become the value of the parent key of the directive only if there are no other subkeys at the same level as the directive
-   In case of duplicate keys, included file will always override the values regardless if `@include` is placed before or after the declaration
-   Special value `{ENV}` is replaced in all file paths by the NODE_ENV value

## Application config file

If you are running your app as a service daemon, you can load configuration from a config file using the `--config` argument. These values are loaded and merged with the default values.

```
[Service]
WorkingDirectory=/opt/app
ExecStart=/usr/bin/node index.js --config=/etc/app.toml
```

## Usage

```javascript
const config = require('wild-config');
console.log(config.server.enabled);
```

### Limitations

-   You can not use "on" as a root key. If you do then it is ignored. This key is reserved for the event emitter handler.
-   When providing configuration options from command line then `--config` does not override `root.config` value (if it even exists). This argument is used only for defining the configuration file path.

## License

Dual license **MIT or EUPL-1.1+**

> `wild-config` is part of the Zone Mail Suite (ZMS). Suite of programs and modules for an efficient, fast and modern email server.