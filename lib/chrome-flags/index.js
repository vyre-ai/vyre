// @ts-check
// Flags every Chrome a test, shot script or docs build launches must carry. Chrome on macOS reaches for the
// login Keychain the moment it starts ("Chrome wants to use your confidential information"), which put a
// real dialog on the user's screen. --use-mock-keychain keeps it off the Keychain, and --password-store=basic
// keeps it off the OS password store on every platform. A launch without them fails
// test/chrome-flags.test.js. Spread it into the argument list: [...CHROME_SAFE, "--headless=new", ...].

export const CHROME_SAFE = Object.freeze(["--use-mock-keychain", "--password-store=basic"]);
