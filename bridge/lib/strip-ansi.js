// Minimal ANSI / control-sequence stripper (avoids ESM-only strip-ansi dep).
// Covers CSI, OSC, and common escape sequences emitted by TUIs.
const ANSI = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
  ].join('|'),
  'g'
);

function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

module.exports = { stripAnsi };
