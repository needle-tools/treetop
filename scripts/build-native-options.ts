// ssh2 catches a missing CPU detector and uses its normal crypto defaults.
// Keep this optional native addon out of the standalone daemon bundle.
export const DAEMON_BUILD_EXTERNALS = ["cpu-features"];
