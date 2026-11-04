// The plugin's own version, from package.json. The build (and the unit tests' config) replaces
// __PLUGIN_VERSION__, so no source file repeats the number.
declare const __PLUGIN_VERSION__: string

export const PLUGIN_VERSION: string = __PLUGIN_VERSION__
